import {
  ProviderError,
  type AuthenticatedMediaRequest,
  type ProviderCredentials,
  type ProviderKind,
  type ProviderRegistry,
  type TemporaryUrl,
} from "@cloudframe/providers";
import type { AuthorizedBrowseItem } from "./live-browse.ts";
import { LiveBrowseError } from "./live-browse.ts";
import {
  CredentialBrokerError,
  type BrokeredProviderCredentials,
  type CredentialBroker,
} from "./credential-broker.ts";

export interface ValidatedProviderMediaSource {
  item: AuthorizedBrowseItem;
  provider: ProviderKind;
  request: { url: string; headers: Headers; expiresAt: Date };
  credentialVersion: number;
}

export interface ProviderMediaSourceService {
  resolve(
    item: AuthorizedBrowseItem,
    options?: { refresh?: boolean },
  ): Promise<ValidatedProviderMediaSource>;
}

export type ProviderMediaSourceErrorCode = "INVALID_PROVIDER_URL" | "ITEM_NOT_FOUND";

export class ProviderMediaSourceError extends Error {
  constructor(readonly code: ProviderMediaSourceErrorCode) {
    super(code);
    this.name = "ProviderMediaSourceError";
  }
}

export function createProviderMediaSourceService(options: {
  credentialBroker: CredentialBroker;
  providers: ProviderRegistry;
  now?: () => Date;
}): ProviderMediaSourceService {
  const now = options.now ?? (() => new Date());

  async function credentialsFor(item: AuthorizedBrowseItem, refresh: boolean) {
    try {
      const credentials = refresh
        ? await options.credentialBroker.refresh(item.source.id, item.claims.householdId)
        : await options.credentialBroker.get(item.source.id, item.claims.householdId);
      return compatibleCredentials(item, credentials);
    } catch (error) {
      normalizeDependencyError(error);
    }
  }

  return {
    async resolve(item, resolveOptions = {}) {
      if (item.claims.kind === "folder") throw itemNotFound();
      let credentials = await credentialsFor(item, resolveOptions.refresh === true);
      let adapter;
      try {
        adapter = options.providers.get(item.source.provider);
      } catch (error) {
        normalizeDependencyError(error);
      }
      const retrieve = () => adapter!.getMediaUrl({
        credentials,
        providerNodeId: item.claims.providerNodeId,
      });
      let value: TemporaryUrl | AuthenticatedMediaRequest;
      try {
        value = await retrieve();
      } catch (error) {
        if (
          !resolveOptions.refresh &&
          error instanceof ProviderError &&
          error.code === "PROVIDER_REAUTH_REQUIRED" &&
          error.reauthReason !== "invalid_grant"
        ) {
          credentials = await credentialsFor(item, true);
          try {
            value = await retrieve();
          } catch (retryError) {
            normalizeDependencyError(retryError);
          }
        } else {
          normalizeDependencyError(error);
        }
      }
      return {
        item,
        provider: item.source.provider,
        request: validateProviderRequest(value!, item, credentials, now()),
        credentialVersion: credentials.credentialVersion,
      };
    },
  };
}

function compatibleCredentials(
  item: AuthorizedBrowseItem,
  credentials: BrokeredProviderCredentials,
): BrokeredProviderCredentials {
  if (
    credentials.credentialVersion !== item.claims.credentialVersion ||
    credentials.credentialVersion !== item.source.credentialVersion
  ) throw new LiveBrowseError("NAVIGATION_EXPIRED");
  return credentials;
}

function normalizeDependencyError(error: unknown): never {
  if (error instanceof LiveBrowseError || error instanceof ProviderMediaSourceError) throw error;
  if (error instanceof CredentialBrokerError) throw itemNotFound();
  if (error instanceof ProviderError) {
    if (error.code === "PROVIDER_NOT_FOUND") throw itemNotFound();
    throw new ProviderError(error.code, "Provider request failed.", {
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      reauthReason: error.reauthReason,
    });
  }
  throw new ProviderError("PROVIDER_BAD_RESPONSE", "Provider request failed.", { retryable: false });
}

function validateProviderRequest(
  value: TemporaryUrl | AuthenticatedMediaRequest,
  item: AuthorizedBrowseItem,
  credentials: ProviderCredentials,
  now: Date,
): ValidatedProviderMediaSource["request"] {
  try {
    const rawUrl = value?.url;
    const rawExpiry = value?.expiresAt;
    const expiryEpoch = Date.prototype.getTime.call(rawExpiry);
    if (!value || typeof value !== "object" || typeof rawUrl !== "string" || !(rawExpiry instanceof Date) || !Number.isFinite(expiryEpoch) || expiryEpoch <= now.getTime()) throw invalidProviderUrl();
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "" || url.hash !== "") throw invalidProviderUrl();
    if (item.source.provider === "google") {
      if (!validGoogleRequest(value, url, item, credentials)) throw invalidProviderUrl();
      return { url: rawUrl, headers: new Headers(value.headers), expiresAt: new Date(expiryEpoch) };
    }
    if ("headers" in value || !validOneDriveUrl(url, rawUrl)) throw invalidProviderUrl();
    return { url: rawUrl, headers: new Headers(), expiresAt: new Date(expiryEpoch) };
  } catch (error) {
    if (error instanceof ProviderMediaSourceError) throw error;
    throw invalidProviderUrl();
  }
}

function validGoogleRequest(value: TemporaryUrl | AuthenticatedMediaRequest, url: URL, item: AuthorizedBrowseItem, credentials: ProviderCredentials): value is AuthenticatedMediaRequest {
  if (!("headers" in value)) return false;
  const keys = [...url.searchParams.keys()];
  const headers = new Headers(value.headers);
  return url.origin === "https://www.googleapis.com" &&
    url.pathname === `/drive/v3/files/${encodeURIComponent(item.claims.providerNodeId)}` &&
    keys.length === 2 && new Set(keys).size === 2 &&
    keys.every((key) => key === "alt" || key === "supportsAllDrives") &&
    exactlyOneQueryValue(url, "alt", "media") &&
    exactlyOneQueryValue(url, "supportsAllDrives", "true") &&
    headers.get("authorization") === `Bearer ${credentials.accessToken}` &&
    [...headers.keys()].length === 1;
}

function exactlyOneQueryValue(url: URL, key: string, expected: string): boolean {
  const values = url.searchParams.getAll(key);
  return values.length === 1 && values[0] === expected;
}

function validOneDriveUrl(url: URL, rawUrl: string): boolean {
  if (url.pathname === "/" || url.pathname.length === 0 || !hasDownloadCapability(url)) return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".sharepoint.com")) return validRawSharePointPath(rawUrl) && hasExactSharePointDownloadHandler(url.pathname);
  if (hostname.endsWith(".files.1drv.com")) return true;
  if (hostname === "storage.live.com" || hostname.endsWith(".storage.live.com")) return true;
  return hostname.endsWith(".microsoftusercontent.com");
}

function hasDownloadCapability(url: URL): boolean {
  for (const [key, value] of url.searchParams) if (key.length > 0 && value.length > 0) return true;
  return false;
}

function hasExactSharePointDownloadHandler(pathname: string): boolean {
  if (/%(?:2e|2f|5c)/iu.test(pathname)) return false;
  const segments = pathname.split("/").slice(1);
  if (segments.some((segment) => segment.length === 0) || segments.length < 3) return false;
  const handler = segments.slice(-3).map((segment) => segment.toLowerCase());
  return handler[0] === "_layouts" && handler[1] === "15" && handler[2] === "download.aspx";
}

function validRawSharePointPath(value: string): boolean {
  const path = rawPath(value);
  if (path === null || path.includes("\\") || /%(?:25|2e|2f|5c)/iu.test(path)) return false;
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

function rawPath(value: string): string | null {
  const authorityStart = value.indexOf("://");
  if (authorityStart < 0) return null;
  const delimiters = [value.indexOf("/", authorityStart + 3), value.indexOf("\\", authorityStart + 3)].filter((index) => index >= 0);
  const start = delimiters.length ? Math.min(...delimiters) : -1;
  if (start < 0) return "";
  const ends = [value.indexOf("?", start), value.indexOf("#", start)].filter((index) => index >= 0);
  return value.slice(start, ends.length ? Math.min(...ends) : value.length);
}

function invalidProviderUrl() { return new ProviderMediaSourceError("INVALID_PROVIDER_URL"); }
function itemNotFound() { return new ProviderMediaSourceError("ITEM_NOT_FOUND"); }
