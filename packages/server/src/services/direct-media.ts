import {
  ProviderError,
  type ProviderAdapter,
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

const MAX_THUMBNAIL_BATCH = 100;
const MIN_THUMBNAIL_DIMENSION = 64;
const MAX_THUMBNAIL_DIMENSION = 4096;

const RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
} as const;

export interface DirectThumbnailResponse {
  items: DirectThumbnailItem[];
  responseHeaders: typeof RESPONSE_HEADERS;
}

export interface DirectMediaResponse extends DirectMediaUrlResponse {
  responseHeaders: typeof RESPONSE_HEADERS;
}

export interface DirectMediaService {
  thumbnails(
    auth: AuthenticatedControlDevice,
    sealedHandles: readonly string[],
    maxDimension: number,
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

function validGoogleUrl(
  url: URL,
  item: AuthorizedBrowseItem,
  credentials: ProviderCredentials,
): boolean {
  const allowedQueryKeys = new Set([
    "access_token",
    "alt",
    "supportsAllDrives",
  ]);
  const keys = queryKeys(url);
  return (
    url.origin === "https://www.googleapis.com" &&
    url.pathname ===
      `/drive/v3/files/${encodeURIComponent(item.claims.providerNodeId)}` &&
    keys.length === 3 &&
    new Set(keys).size === 3 &&
    keys.every((key) => allowedQueryKeys.has(key)) &&
    exactlyOneQueryValue(url, "alt", "media") &&
    exactlyOneQueryValue(url, "access_token", credentials.accessToken) &&
    exactlyOneQueryValue(url, "supportsAllDrives", "true")
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

function validOneDriveUrl(url: URL): boolean {
  if (url.pathname === "/" || url.pathname.length === 0) return false;
  if (!hasDownloadCapability(url)) return false;
  const hostname = url.hostname.toLowerCase();
  if (hostnameMatchesSubdomain(hostname, "sharepoint.com")) {
    const pathname = url.pathname.toLowerCase();
    return (
      pathname === "/_layouts/15/download.aspx" ||
      pathname.includes("/_layouts/15/download.aspx")
    );
  }
  if (hostnameMatchesSubdomain(hostname, "files.1drv.com")) return true;
  if (hostname === "storage.live.com") return true;
  return hostnameMatchesSubdomain(hostname, "microsoftusercontent.com");
}

function validTemporaryUrl(
  value: TemporaryUrl,
  item: AuthorizedBrowseItem,
  credentials: ProviderCredentials,
  now: Date,
): TemporaryUrl {
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
      (item.source.provider === "google"
        ? !validGoogleUrl(url, item, credentials)
        : !validOneDriveUrl(url))
    ) {
      throw directMediaError("INVALID_PROVIDER_URL");
    }
    return { url: rawUrl, expiresAt: new Date(expiryEpoch) };
  } catch (error) {
    if (error instanceof DirectMediaError) throw error;
    throw directMediaError("INVALID_PROVIDER_URL");
  }
}

function validThumbnailUrl(
  value: TemporaryUrl,
  item: AuthorizedBrowseItem,
  credentials: ProviderCredentials,
  now: Date,
): TemporaryUrl | null {
  try {
    return validTemporaryUrl(value, item, credentials, now);
  } catch (error) {
    if (
      error instanceof DirectMediaError &&
      item.source.provider === "onedrive"
    ) {
      return null;
    }
    throw error;
  }
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
  ): Promise<DirectThumbnailResponse> {
    validateThumbnailRequest(sealedHandles, maxDimension);
    const authorized = sealedHandles.map((sealedHandle) =>
      options.browse.authorizeHandle(auth, sealedHandle),
    );
    const items: DirectThumbnailItem[] = new Array(authorized.length);

    for (const group of groupsBySource(authorized)) {
      const vendable = group.items.filter(
        (entry) => entry.item.claims.kind !== "folder",
      );
      for (const entry of group.items) {
        if (entry.item.claims.kind === "folder") {
          items[entry.index] = unavailable(entry.item);
        }
      }
      if (vendable.length === 0) continue;

      const provider = group.item.source.provider;
      let credentials: BrokeredProviderCredentials;
      let adapter: ProviderAdapter;
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

      for (const entry of vendable) {
        try {
          const temporary = await adapter!.getThumbnailUrl({
            credentials: credentials!,
            providerNodeId: entry.item.claims.providerNodeId,
            maxDimension,
          });
          const safe = temporary
            ? validThumbnailUrl(temporary, entry.item, credentials!, now())
            : null;
          items[entry.index] = safe
            ? readyThumbnail(entry.item, safe)
            : unavailable(entry.item);
        } catch (error) {
          if (
            error instanceof ProviderError &&
            error.code === "PROVIDER_NOT_FOUND"
          ) {
            items[entry.index] = unavailable(entry.item);
            continue;
          }
          normalizeDependencyError(error);
        }
      }
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

    let credentials: BrokeredProviderCredentials;
    let adapter: ProviderAdapter;
    try {
      credentials = compatibleCredentials(
        item,
        await options.credentialBroker.get(
          item.source.id,
          item.claims.householdId,
        ),
      );
      adapter = providerAdapter(options.providers, item.source.provider);
    } catch (error) {
      normalizeDependencyError(error);
    }

    const operation = (activeCredentials: ProviderCredentials) =>
      adapter!.getMediaUrl({
        credentials: activeCredentials,
        providerNodeId: item.claims.providerNodeId,
      });

    let temporary: TemporaryUrl;
    try {
      temporary = await operation(credentials!);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_REAUTH_REQUIRED" &&
        error.reauthReason !== "invalid_grant"
      ) {
        try {
          credentials = compatibleCredentials(
            item,
            await options.credentialBroker.refresh(
              item.source.id,
              item.claims.householdId,
            ),
          );
          temporary = await operation(credentials);
        } catch (retryError) {
          normalizeDependencyError(retryError);
        }
      } else {
        normalizeDependencyError(error);
      }
    }

    const safe = validTemporaryUrl(
      temporary!,
      item,
      credentials!,
      now(),
    );
    return {
      itemId: item.id,
      kind: item.claims.kind,
      url: safe.url,
      expiresAt: safe.expiresAt.toISOString(),
      revision: null,
      responseHeaders: RESPONSE_HEADERS,
    };
  }

  return { thumbnails, media };
}
