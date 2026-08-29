import {
  ProviderError,
  type ProviderAdapter,
  type AuthenticatedMediaRequest,
  type ProviderCredentials,
  type ProviderKind,
  type ProviderRegistry,
  type TemporaryUrl,
} from "@cloudframe/providers";
import type {
  DirectMediaUrlResponse,
  DirectThumbnailItem,
} from "@cloudframe/shared";

import type { AuthenticatedControlDevice } from "./control-auth";
import {
  CredentialBrokerError,
  type BrokeredProviderCredentials,
  type CredentialBroker,
} from "./credential-broker";
import {
  LiveBrowseError,
  type AuthorizedBrowseItem,
  type LiveBrowseService,
} from "./live-browse";
import {
  ProviderMediaSourceError,
  type ProviderMediaSourceService,
} from "./provider-media-source";

const MAX_THUMBNAIL_BATCH = 100;
const MIN_THUMBNAIL_DIMENSION = 64;
const MAX_THUMBNAIL_DIMENSION = 4096;
const MAX_CONCURRENT_THUMBNAIL_REQUESTS = 4;

const RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
} as const;

export interface DirectThumbnailResponse {
  items: DirectThumbnailItem[];
  responseHeaders: typeof RESPONSE_HEADERS;
}

export type DirectMediaResponse = DirectMediaUrlResponse & {
  responseHeaders: typeof RESPONSE_HEADERS;
};

export interface DirectMediaService {
  thumbnails(
    auth: AuthenticatedControlDevice,
    sealedHandles: readonly string[],
    maxDimension: number,
    refresh?: boolean,
  ): Promise<DirectThumbnailResponse>;
  media(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
  ): Promise<DirectMediaResponse>;
}

export interface CreateDirectMediaServiceOptions {
  browse: Pick<LiveBrowseService, "authorizeHandle">;
  credentialBroker: CredentialBroker;
  providers: ProviderRegistry;
  mediaSources: ProviderMediaSourceService;
  now?: () => Date;
}

export type DirectMediaErrorCode =
  | "INVALID_PROVIDER_URL"
  | "INVALID_THUMBNAIL_REQUEST"
  | "ITEM_NOT_FOUND";

export class DirectMediaError extends Error {
  constructor(readonly code: DirectMediaErrorCode) {
    super(code);
    this.name = "DirectMediaError";
  }
}

interface SourceGroup {
  item: AuthorizedBrowseItem;
  items: Array<{ index: number; item: AuthorizedBrowseItem }>;
}

function directMediaError(code: DirectMediaErrorCode): DirectMediaError {
  return new DirectMediaError(code);
}

function navigationExpired(): LiveBrowseError {
  return new LiveBrowseError("NAVIGATION_EXPIRED");
}

function validateThumbnailRequest(
  sealedHandles: readonly string[],
  maxDimension: number,
): void {
  if (
    sealedHandles.length < 1 ||
    sealedHandles.length > MAX_THUMBNAIL_BATCH ||
    sealedHandles.some((handle) => typeof handle !== "string" || handle.length === 0) ||
    new Set(sealedHandles).size !== sealedHandles.length ||
    !Number.isInteger(maxDimension) ||
    maxDimension < MIN_THUMBNAIL_DIMENSION ||
    maxDimension > MAX_THUMBNAIL_DIMENSION
  ) {
    throw directMediaError("INVALID_THUMBNAIL_REQUEST");
  }
}

function groupsBySource(items: readonly AuthorizedBrowseItem[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  items.forEach((item, index) => {
    const key = `${item.source.id}\u0000${item.claims.credentialVersion}`;
    const group = groups.get(key);
    if (group) {
      group.items.push({ index, item });
    } else {
      groups.set(key, { item, items: [{ index, item }] });
    }
  });
  return [...groups.values()];
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (!failed && nextIndex < items.length) {
        const item = items[nextIndex]!;
        nextIndex += 1;
        try {
          await operation(item);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    },
  );
  await Promise.all(workers);
  if (failed) throw firstError;
}

function compatibleCredentials(
  item: AuthorizedBrowseItem,
  credentials: BrokeredProviderCredentials,
): BrokeredProviderCredentials {
  if (
    credentials.credentialVersion !== item.claims.credentialVersion ||
    credentials.credentialVersion !== item.source.credentialVersion
  ) {
    throw navigationExpired();
  }
  return credentials;
}

function safeProviderError(error: ProviderError): ProviderError {
  return new ProviderError(error.code, "Provider request failed.", {
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
    reauthReason: error.reauthReason,
  });
}

function normalizeDependencyError(error: unknown): never {
  if (error instanceof LiveBrowseError || error instanceof DirectMediaError) {
    throw error;
  }
  if (error instanceof CredentialBrokerError) {
    throw directMediaError("ITEM_NOT_FOUND");
  }
  if (error instanceof ProviderError) {
    if (error.code === "PROVIDER_NOT_FOUND") {
      throw directMediaError("ITEM_NOT_FOUND");
    }
    throw safeProviderError(error);
  }
  throw new ProviderError("PROVIDER_BAD_RESPONSE", "Provider request failed.", {
    retryable: false,
  });
}

function providerAdapter(
  providers: ProviderRegistry,
  provider: ProviderKind,
): ProviderAdapter {
  try {
    return providers.get(provider);
  } catch (error) {
    normalizeDependencyError(error);
  }
}

function queryKeys(url: URL): string[] {
  return [...url.searchParams.keys()];
}

function exactlyOneQueryValue(
  url: URL,
  key: string,
  expected: string,
): boolean {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] === expected;
}

function validGoogleRequest(
  value: TemporaryUrl | AuthenticatedMediaRequest,
  url: URL,
  item: AuthorizedBrowseItem,
  credentials: ProviderCredentials,
): boolean {
  const allowedQueryKeys = new Set(["alt", "supportsAllDrives"]);
  const keys = queryKeys(url);
  if (!("headers" in value)) return false;
  const headers = new Headers(value.headers);
  return (
    url.origin === "https://www.googleapis.com" &&
    url.pathname ===
      `/drive/v3/files/${encodeURIComponent(item.claims.providerNodeId)}` &&
    keys.length === 2 &&
    new Set(keys).size === 2 &&
    keys.every((key) => allowedQueryKeys.has(key)) &&
    exactlyOneQueryValue(url, "alt", "media") &&
    exactlyOneQueryValue(url, "supportsAllDrives", "true") &&
    headers.get("authorization") === `Bearer ${credentials.accessToken}` &&
    [...headers.keys()].length === 1
  );
}

function validGoogleThumbnailUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    /^lh\d+\.googleusercontent\.com$/u.test(hostname) &&
    /=s\d+$/u.test(url.pathname) &&
    url.search === "" &&
    url.hash === "" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

function hostnameMatchesSubdomain(hostname: string, suffix: string): boolean {
  return hostname.endsWith(`.${suffix}`);
}

function hasDownloadCapability(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (key.length > 0 && value.length > 0) return true;
  }
  return false;
}

function hasExactSharePointDownloadHandler(pathname: string): boolean {
  if (/%(?:2e|2f|5c)/iu.test(pathname)) return false;
  const segments = pathname.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0)) return false;
  if (segments.length < 3) return false;
  const handler = segments.slice(-3).map((segment) => segment.toLowerCase());
  return (
    handler[0] === "_layouts" &&
    handler[1] === "15" &&
    handler[2] === "download.aspx"
  );
}

function rawPath(value: string): string | null {
  const authorityStart = value.indexOf("://");
  if (authorityStart < 0) return null;
  const pathDelimiters = [
    value.indexOf("/", authorityStart + 3),
    value.indexOf("\\", authorityStart + 3),
  ].filter((index) => index >= 0);
  const pathStart = pathDelimiters.length > 0 ? Math.min(...pathDelimiters) : -1;
  if (pathStart < 0) return "";
  const queryStart = value.indexOf("?", pathStart);
  const fragmentStart = value.indexOf("#", pathStart);
  const candidates = [queryStart, fragmentStart].filter((index) => index >= 0);
  const pathEnd = candidates.length > 0 ? Math.min(...candidates) : value.length;
  return value.slice(pathStart, pathEnd);
}

function validRawSharePointPath(value: string): boolean {
  const path = rawPath(value);
  if (path === null || path.includes("\\") || /%(?:25|2e|2f|5c)/iu.test(path)) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

function validOneDriveUrl(url: URL, rawUrl: string): boolean {
  if (url.pathname === "/" || url.pathname.length === 0) return false;
  if (!hasDownloadCapability(url)) return false;
  const hostname = url.hostname.toLowerCase();
  if (hostnameMatchesSubdomain(hostname, "sharepoint.com")) {
    return (
      validRawSharePointPath(rawUrl) &&
      hasExactSharePointDownloadHandler(url.pathname)
    );
  }
  if (hostnameMatchesSubdomain(hostname, "files.1drv.com")) return true;
  if (hostname === "storage.live.com" || hostnameMatchesSubdomain(hostname, "storage.live.com")) return true;
  return hostnameMatchesSubdomain(hostname, "microsoftusercontent.com");
}

function validTemporaryUrl(
  value: TemporaryUrl | AuthenticatedMediaRequest,
  item: AuthorizedBrowseItem,
  credentials: ProviderCredentials,
  now: Date,
): TemporaryUrl | AuthenticatedMediaRequest {
  try {
    const rawUrl = value?.url;
    const rawExpiry = value?.expiresAt;
    const expiryEpoch = Date.prototype.getTime.call(rawExpiry);
    if (
      !value ||
      typeof value !== "object" ||
      typeof rawUrl !== "string" ||
      !(rawExpiry instanceof Date) ||
      !Number.isFinite(expiryEpoch) ||
      expiryEpoch <= now.getTime()
    ) {
      throw directMediaError("INVALID_PROVIDER_URL");
    }
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      !(
        item.source.provider === "google"
          ? "headers" in value
            ? validGoogleRequest(value, url, item, credentials)
            : validGoogleThumbnailUrl(url)
          : validOneDriveUrl(url, rawUrl)
      )
    ) {
      throw directMediaError("INVALID_PROVIDER_URL");
    }
    return {
      url: rawUrl,
      expiresAt: new Date(expiryEpoch),
      ...("headers" in value ? { headers: new Headers(value.headers) } : {}),
    };
  } catch (error) {
    if (error instanceof DirectMediaError) throw error;
    throw directMediaError("INVALID_PROVIDER_URL");
  }
}

function validThumbnailUrl(
  value: TemporaryUrl,
  item: AuthorizedBrowseItem,
  now: Date,
): TemporaryUrl | null {
  try {
    const rawUrl = value?.url;
    const rawExpiry = value?.expiresAt;
    const expiryEpoch = Date.prototype.getTime.call(rawExpiry);
    if (
      !value ||
      typeof value !== "object" ||
      typeof rawUrl !== "string" ||
      !(rawExpiry instanceof Date) ||
      !Number.isFinite(expiryEpoch) ||
      expiryEpoch <= now.getTime()
    ) {
      throw directMediaError("INVALID_PROVIDER_URL");
    }
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== "" ||
      !(
        item.source.provider === "google"
          ? validGoogleThumbnailUrl(url)
          : validOneDriveUrl(url, rawUrl)
      )
    ) {
      throw directMediaError("INVALID_PROVIDER_URL");
    }
    return { url: rawUrl, expiresAt: new Date(expiryEpoch) };
  } catch (error) {
    const normalized = error instanceof DirectMediaError
      ? error
      : directMediaError("INVALID_PROVIDER_URL");
    if (normalized.code === "INVALID_PROVIDER_URL") return null;
    throw normalized;
  }
}

type SealedPreviewResult =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "ready"; value: TemporaryUrl };

function sealedPreview(
  item: AuthorizedBrowseItem,
  currentNow: Date,
): SealedPreviewResult {
  const preview = item.claims.preview;
  if (!preview || preview.expiresAt <= currentNow.getTime()) return { status: "absent" };
  const value = validThumbnailUrl(
    { url: preview.url, expiresAt: new Date(preview.expiresAt) },
    item,
    currentNow,
  );
  return value ? { status: "ready", value } : { status: "invalid" };
}

function unavailable(item: AuthorizedBrowseItem): DirectThumbnailItem {
  return { itemId: item.id, status: "unavailable" };
}

function readyThumbnail(
  item: AuthorizedBrowseItem,
  temporary: TemporaryUrl,
): DirectThumbnailItem {
  return {
    itemId: item.id,
    status: "ready",
    url: temporary.url,
    expiresAt: temporary.expiresAt.toISOString(),
    revision: null,
  };
}

export function createDirectMediaService(
  options: CreateDirectMediaServiceOptions,
): DirectMediaService {
  const now = options.now ?? (() => new Date());

  async function thumbnails(
    auth: AuthenticatedControlDevice,
    sealedHandles: readonly string[],
    maxDimension: number,
    refresh = false,
  ): Promise<DirectThumbnailResponse> {
    validateThumbnailRequest(sealedHandles, maxDimension);
    const authorized = sealedHandles.map((sealedHandle) =>
      options.browse.authorizeHandle(auth, sealedHandle),
    );
    const items: DirectThumbnailItem[] = new Array(authorized.length);

    for (const group of groupsBySource(authorized)) {
      const vendable: typeof group.items = [];
      for (const entry of group.items) {
        const preview = refresh ? { status: "absent" as const } : sealedPreview(entry.item, now());
        if (preview.status === "ready") {
          items[entry.index] = readyThumbnail(entry.item, preview.value);
        } else if (preview.status === "invalid") {
          items[entry.index] = unavailable(entry.item);
        } else {
          vendable.push(entry);
        }
      }
      if (vendable.length === 0) continue;

      const provider = group.item.source.provider;
      let credentials: BrokeredProviderCredentials;
      let adapter: ProviderAdapter;
      let credentialGeneration = 0;
      let refreshPromise: Promise<BrokeredProviderCredentials> | null = null;
      try {
        credentials = compatibleCredentials(
          group.item,
          await options.credentialBroker.get(
            group.item.source.id,
            group.item.claims.householdId,
          ),
        );
        adapter = providerAdapter(options.providers, provider);
      } catch (error) {
        normalizeDependencyError(error);
      }

      const refreshedCredentials = () => {
        if (!refreshPromise) {
          refreshPromise = options.credentialBroker.refresh(
            group.item.source.id,
            group.item.claims.householdId,
          ).then((nextCredentials) => {
            const compatible = compatibleCredentials(group.item, nextCredentials);
            credentials = compatible;
            credentialGeneration = 1;
            return compatible;
          });
        }
        return refreshPromise;
      };

      await forEachWithConcurrency(
        vendable,
        MAX_CONCURRENT_THUMBNAIL_REQUESTS,
        async (entry) => {
          try {
            const operation = (activeCredentials: ProviderCredentials) =>
              adapter!.getThumbnailUrl({
                credentials: activeCredentials,
                providerNodeId: entry.item.claims.providerNodeId,
                kind: entry.item.claims.kind,
                maxDimension,
              });
            const operationGeneration = credentialGeneration;
            let temporary: TemporaryUrl | null;
            try {
              temporary = await operation(credentials!);
            } catch (error) {
              if (
                error instanceof ProviderError &&
                error.code === "PROVIDER_REAUTH_REQUIRED" &&
                error.reauthReason !== "invalid_grant" &&
                operationGeneration === 0
              ) {
                const retryCredentials = credentialGeneration === 1
                  ? credentials!
                  : await refreshedCredentials();
                temporary = await operation(retryCredentials);
              } else {
                throw error;
              }
            }
            const safe = temporary
              ? validThumbnailUrl(temporary, entry.item, now())
              : null;
            items[entry.index] = safe
              ? readyThumbnail(entry.item, safe)
              : unavailable(entry.item);
          } catch (error) {
            if (
              error instanceof ProviderError &&
              (error.code === "PROVIDER_NOT_FOUND" ||
                error.code === "PROVIDER_BAD_RESPONSE")
            ) {
              items[entry.index] = unavailable(entry.item);
              return;
            }
            normalizeDependencyError(error);
          }
        },
      );
    }

    return { items, responseHeaders: RESPONSE_HEADERS };
  }

  async function media(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
  ): Promise<DirectMediaResponse> {
    const item = options.browse.authorizeHandle(auth, sealedHandle);
    if (item.claims.kind === "folder") {
      throw directMediaError("ITEM_NOT_FOUND");
    }

    let source;
    try {
      source = await options.mediaSources.resolve(item);
    } catch (error) {
      if (error instanceof ProviderMediaSourceError) throw directMediaError(error.code);
      throw error;
    }
    if (source.provider === "google") {
      const authorization = source.request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) throw directMediaError("INVALID_PROVIDER_URL");
      return {
        itemId: item.id,
        kind: item.claims.kind,
        transport: "google-bearer",
        url: source.request.url,
        authorization: { scheme: "Bearer", token: authorization.slice(7) },
        expiresAt: source.request.expiresAt.toISOString(),
        revision: item.claims.contentRevision,
        responseHeaders: RESPONSE_HEADERS,
      };
    }
    return {
      itemId: item.id,
      kind: item.claims.kind,
      transport: "direct",
      url: source.request.url,
      expiresAt: source.request.expiresAt.toISOString(),
      revision: item.claims.contentRevision,
      responseHeaders: RESPONSE_HEADERS,
    };
  }

  return { thumbnails, media };
}
