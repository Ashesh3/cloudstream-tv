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
  MEDIA_HANDLE_LIFETIME_MS,
  type MediaHandleClaims,
  type MediaHandleCodec,
} from "../auth/media-handles";
import { SealedValueError } from "../crypto/aead";
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
    refresh?: boolean,
  ): Promise<DirectThumbnailResponse>;
  media(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
  ): Promise<DirectMediaResponse>;
  googleMedia(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
    request: GoogleMediaRequest,
  ): Promise<Response>;
}

export interface GoogleMediaRequest {
  method: "GET" | "HEAD";
  range: string | null;
  ifRange: string | null;
  signal?: AbortSignal;
}

export interface CreateDirectMediaServiceOptions {
  browse: Pick<LiveBrowseService, "authorizeHandle" | "authorizeClaims">;
  mediaHandles: MediaHandleCodec;
  credentialBroker: CredentialBroker;
  providers: ProviderRegistry;
  fetch?: typeof globalThis.fetch;
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
  const providerFetch = options.fetch ?? fetch;

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
      let refreshedCredentials = false;
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
          const operation = (activeCredentials: ProviderCredentials) =>
            adapter!.getThumbnailUrl({
              credentials: activeCredentials,
              providerNodeId: entry.item.claims.providerNodeId,
              maxDimension,
            });
          let temporary: TemporaryUrl | null;
          try {
            temporary = await operation(credentials!);
          } catch (error) {
            if (
              error instanceof ProviderError &&
              error.code === "PROVIDER_REAUTH_REQUIRED" &&
              error.reauthReason !== "invalid_grant" &&
              !refreshedCredentials
            ) {
              credentials = compatibleCredentials(
                entry.item,
                await options.credentialBroker.refresh(
                  entry.item.source.id,
                  entry.item.claims.householdId,
                ),
              );
              refreshedCredentials = true;
              temporary = await operation(credentials);
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

    let temporary: TemporaryUrl | AuthenticatedMediaRequest;
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
    if (item.source.provider === "google") {
      const issuedAt = now().getTime();
      const mediaHandle = options.mediaHandles.seal({
        version: 1,
        householdId: item.claims.householdId,
        deviceId: item.claims.deviceId,
        sourceId: item.claims.sourceId,
        rootId: item.claims.rootId,
        rootProviderNodeId: item.claims.rootProviderNodeId,
        providerNodeId: item.claims.providerNodeId,
        parentProviderNodeId: item.claims.parentProviderNodeId,
        kind: item.claims.kind,
        name: item.claims.name,
        mimeType: item.claims.mimeType!,
        credentialVersion: item.claims.credentialVersion,
        issuedAt,
        expiresAt: issuedAt + MEDIA_HANDLE_LIFETIME_MS,
      });
      return {
        itemId: item.id,
        kind: item.claims.kind,
        url: `/api/tv/google-media/${encodeURIComponent(mediaHandle)}`,
        expiresAt: new Date(issuedAt + MEDIA_HANDLE_LIFETIME_MS).toISOString(),
        revision: null,
        responseHeaders: RESPONSE_HEADERS,
      };
    }
    return {
      itemId: item.id,
      kind: item.claims.kind,
      url: safe.url,
      expiresAt: safe.expiresAt.toISOString(),
      revision: null,
      responseHeaders: RESPONSE_HEADERS,
    };
  }

  async function googleMedia(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
    request: GoogleMediaRequest,
  ): Promise<Response> {
    let claims: MediaHandleClaims;
    try {
      claims = options.mediaHandles.open(sealedHandle);
    } catch (error) {
      if (error instanceof SealedValueError) throw navigationExpired();
      throw error;
    }
    const item = options.browse.authorizeClaims(auth, {
      ...claims,
      version: 2,
    });
    if (item.source.provider !== "google" || item.claims.kind === "folder") {
      throw directMediaError("ITEM_NOT_FOUND");
    }
    if (request.range !== null && !validRange(request.range)) {
      throw directMediaError("ITEM_NOT_FOUND");
    }
    if (request.ifRange !== null && !validIfRange(request.ifRange)) {
      throw directMediaError("ITEM_NOT_FOUND");
    }

    let credentials = compatibleCredentials(
      item,
      await brokerGet(options.credentialBroker, item),
    );
    const fetchGoogle = async (active: ProviderCredentials) => {
      const adapter = providerAdapter(options.providers, "google");
      const upstream = await adapter.getMediaUrl({
        credentials: active,
        providerNodeId: item.claims.providerNodeId,
      });
      const safe = validTemporaryUrl(upstream, item, active, now());
      if (!("headers" in safe)) throw directMediaError("INVALID_PROVIDER_URL");
      const headers = new Headers(safe.headers);
      headers.set("accept-encoding", "identity");
      if (request.range !== null) headers.set("range", request.range);
      if (request.ifRange !== null) headers.set("if-range", request.ifRange);
      return providerFetch(safe.url, {
        method: request.method,
        headers,
        signal: request.signal,
      });
    };

    let upstream: Response;
    try {
      upstream = await fetchGoogle(credentials);
    } catch (error) {
      normalizeDependencyError(error);
    }
    if (upstream.status === 401) {
      cancelBodyBestEffort(upstream);
      try {
        credentials = compatibleCredentials(
          item,
          await options.credentialBroker.refresh(
            item.source.id,
            item.claims.householdId,
          ),
        );
        upstream = await fetchGoogle(credentials);
      } catch (error) {
        normalizeDependencyError(error);
      }
    }
    if (upstream.status === 416) {
      cancelBodyBestEffort(upstream);
      return googleRangeNotSatisfiableResponse(upstream);
    }
    if (!upstream.ok) {
      const error = providerResponseError(upstream, now());
      cancelBodyBestEffort(upstream);
      throw error;
    }
    return googleMediaResponse(upstream, request.method);
  }

  return { thumbnails, media, googleMedia };
}

async function brokerGet(
  broker: CredentialBroker,
  item: AuthorizedBrowseItem,
): Promise<BrokeredProviderCredentials> {
  try {
    return await broker.get(item.source.id, item.claims.householdId);
  } catch (error) {
    normalizeDependencyError(error);
  }
}

function validRange(value: string): boolean {
  if (value.length > 128) return false;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match) return false;
  const start = match[1]!;
  const end = match[2]!;
  if (start.length === 0 && end.length === 0) return false;
  if (start.length === 0) return end !== "0";
  if (end.length === 0) return true;
  try {
    return BigInt(start) <= BigInt(end);
  } catch {
    return false;
  }
}

function validIfRange(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && !/[\r\n]/u.test(value);
}

function googleMediaResponse(upstream: Response, method: "GET" | "HEAD"): Response {
  const headers = new Headers(RESPONSE_HEADERS);
  for (const name of [
    "accept-ranges",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

function googleRangeNotSatisfiableResponse(upstream: Response): Response {
  const headers = new Headers(RESPONSE_HEADERS);
  const contentRange = upstream.headers.get("content-range");
  if (contentRange !== null) headers.set("content-range", contentRange);
  return new Response(null, { status: 416, headers });
}

function providerResponseError(upstream: Response, now: Date): ProviderError {
  const retryAfterSeconds = parseRetryAfter(
    upstream.headers.get("retry-after"),
    now,
  );
  if (upstream.status === 429) {
    return new ProviderError("PROVIDER_THROTTLED", "Provider request failed.", {
      retryable: true,
      retryAfterSeconds,
    });
  }
  if (upstream.status >= 500) {
    return new ProviderError("PROVIDER_UNAVAILABLE", "Provider request failed.", {
      retryable: true,
      retryAfterSeconds,
    });
  }
  if (upstream.status === 404) {
    return new ProviderError("PROVIDER_NOT_FOUND", "Provider request failed.", {
      retryable: false,
    });
  }
  if (upstream.status === 401) {
    return new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "Provider request failed.",
      { retryable: false },
    );
  }
  return new ProviderError("PROVIDER_BAD_RESPONSE", "Provider request failed.", {
    retryable: false,
  });
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1_000));
}

function cancelBodyBestEffort(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Cleanup is advisory and never changes the client-visible error.
  }
}
