import { bearer, json, optionalJson, providerFetch, temporaryExpiry } from "./http";
import { ProviderError } from "./types";
import type {
  AuthorizationCallback,
  GetNodeInput,
  ListFolderInput,
  MediaUrlInput,
  ProviderAccount,
  ProviderAdapter,
  ProviderAdapterDependencies,
  ProviderCredentials,
  ProviderNode,
  Source,
  TemporaryUrl,
  ThumbnailUrlInput
} from "./types";

const GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0";
const MICROSOFT_SCOPES =
  "openid profile email offline_access User.Read Files.Read";

interface OneDriveDependencies extends ProviderAdapterDependencies {
  tenant?: string;
}

export function createOneDriveAdapter(
  dependencies: OneDriveDependencies
): ProviderAdapter {
  const { clientId, clientSecret, fetch, now } = dependencies;
  const tenant = dependencies.tenant ?? "common";
  const oauthBase = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

  return {
    async beginAuthorization(input) {
      const url = new URL(`${oauthBase}/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        response_mode: "query",
        scope: MICROSOFT_SCOPES,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256"
      }).toString();
      return { authorizationUrl: url.toString() };
    },

    async completeAuthorization(input: AuthorizationCallback): Promise<ProviderAccount> {
      const credentials = await exchangeCode(
        fetch,
        `${oauthBase}/token`,
        clientId,
        clientSecret,
        input,
        now()
      );
      const account = await graphJson<{ id?: string; displayName?: string; mail?: string; userPrincipalName?: string }>(
        fetch,
        `${GRAPH_ENDPOINT}/me?$select=id,displayName,mail,userPrincipalName`,
        credentials.accessToken,
        now
      );
      return {
        accountId: requireString(account.id),
        accountLabel: account.mail ?? account.userPrincipalName ?? account.displayName ?? "OneDrive",
        credentials
      };
    },

    async refreshCredentials(source: Source) {
      if (!source.credentials.refreshToken) {
        throw new ProviderError(
          "PROVIDER_REAUTH_REQUIRED",
          "Provider authorization is required.",
          { retryable: false }
        );
      }
      const response = await providerFetch(fetch, `${oauthBase}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: source.credentials.refreshToken,
          grant_type: "refresh_token",
          scope: MICROSOFT_SCOPES
        })
      }, { now });
      return tokenCredentials(
        await json<MicrosoftTokenResponse>(response),
        now(),
        source.credentials.refreshToken
      );
    },

    async getRoot(credentials) {
      const item = await graphJson<OneDriveItem>(
        fetch,
        `${GRAPH_ENDPOINT}/me/drive/root?$select=${encodeURIComponent(ONEDRIVE_SELECT)}`,
        credentials.accessToken,
        now
      );
      const node = normalizeOneDriveItem(item, now());
      if (!node || node.kind !== "folder") {
        throw new ProviderError(
          "PROVIDER_BAD_RESPONSE",
          "Provider returned an invalid root folder.",
          { retryable: false }
        );
      }
      return node;
    },

    async getNode(input: GetNodeInput) {
      const item = await graphJson<OneDriveItem>(
        fetch,
        `${GRAPH_ENDPOINT}/me/drive/items/${encodeURIComponent(input.providerNodeId)}?$select=${encodeURIComponent(ONEDRIVE_SELECT)}`,
        input.credentials.accessToken,
        now
      );
      const node = normalizeOneDriveItem(item, now());
      if (!node) {
        throw new ProviderError(
          "PROVIDER_NOT_FOUND",
          "Provider item was not found.",
          { retryable: false }
        );
      }
      return node;
    },

    async listFolder(input: ListFolderInput) {
      const url = input.cursor
        ? requireFolderGraphCursor(input.cursor, input.folderId, input.pageSize)
        : new URL(`${GRAPH_ENDPOINT}/me/drive/items/${encodeURIComponent(input.folderId)}/children`);
      if (!input.cursor) {
        url.searchParams.set("$top", String(input.pageSize));
        url.searchParams.set("$select", ONEDRIVE_SELECT);
        url.searchParams.set("$expand", "thumbnails($select=large)");
      }
      const page = await graphJson<OneDrivePage>(fetch, url, input.credentials.accessToken, now);
      return {
        items: page.value
          .map((item) => normalizeOneDriveItem(item, now()))
          .filter(isDefined),
        nextCursor: page["@odata.nextLink"] ?? null
      };
    },

    async getThumbnailUrl(input: ThumbnailUrlInput): Promise<TemporaryUrl | null> {
      const size = Math.max(64, Math.min(4096, Math.round(input.maxDimension)));
      const response = await providerFetch(
        fetch,
        `${GRAPH_ENDPOINT}/me/drive/items/${encodeURIComponent(input.providerNodeId)}/thumbnails/0/c${size}x${size}`,
        { headers: bearer(input.credentials.accessToken) },
        { now, acceptedStatuses: [404] }
      );
      const value = await optionalJson<{ url?: string }>(response);
      return value?.url
        ? {
            url: value.url,
            expiresAt: temporaryExpiry(now())
          }
        : null;
    },

    async getMediaUrl(input: MediaUrlInput): Promise<TemporaryUrl> {
      const item = await graphJson<OneDriveItem>(
        fetch,
        `${GRAPH_ENDPOINT}/me/drive/items/${encodeURIComponent(input.providerNodeId)}?$select=@microsoft.graph.downloadUrl`,
        input.credentials.accessToken,
        now
      );
      const url = item["@microsoft.graph.downloadUrl"];
      if (!url) {
        throw new ProviderError(
          "PROVIDER_BAD_RESPONSE",
          "The cloud provider did not return a media URL.",
          { retryable: false }
        );
      }
      return { url, expiresAt: temporaryExpiry(now()) };
    }
  };
}

const ONEDRIVE_SELECT =
  "id,name,parentReference,folder,file,image,video,size,createdDateTime,lastModifiedDateTime,photo,eTag";

interface OneDriveItem {
  id: string;
  name?: string;
  parentReference?: { id?: string };
  folder?: { childCount?: number };
  file?: { mimeType?: string };
  image?: { width?: number; height?: number };
  video?: { width?: number; height?: number };
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  photo?: { takenDateTime?: string };
  thumbnails?: Array<{ large?: { url?: string } }>;
  eTag?: string;
  "@microsoft.graph.downloadUrl"?: string;
}

interface OneDrivePage {
  value: OneDriveItem[];
  "@odata.nextLink"?: string;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function exchangeCode(
  fetch: typeof globalThis.fetch,
  tokenEndpoint: string,
  clientId: string,
  clientSecret: string,
  input: AuthorizationCallback,
  now: Date
): Promise<ProviderCredentials> {
  const response = await providerFetch(fetch, tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
      scope: MICROSOFT_SCOPES
    })
  }, { now: () => now });
  return tokenCredentials(await json<MicrosoftTokenResponse>(response), now, null);
}

function tokenCredentials(
  token: MicrosoftTokenResponse,
  now: Date,
  fallbackRefreshToken: string | null
): ProviderCredentials {
  return {
    accessToken: requireString(token.access_token),
    refreshToken: token.refresh_token ?? fallbackRefreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + requirePositive(token.expires_in) * 1000)
  };
}

function normalizeOneDriveItem(item: OneDriveItem, previewNow: Date): ProviderNode | null {
  const mimeType = item.file?.mimeType ?? "";
  const kind = item.folder
    ? "folder"
    : mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("video/")
        ? "video"
        : null;
  if (!kind || !item.id || !item.name) return null;
  const dimensions = kind === "image" ? item.image : item.video;
  const previewUrl = item.thumbnails?.[0]?.large?.url;
  const preview = listedOneDrivePreview(previewUrl, previewNow);
  return {
    providerNodeId: item.id,
    parentProviderId: item.parentReference?.id ?? null,
    name: item.name,
    kind,
    mimeType: kind === "folder" ? null : mimeType,
    size: Number.isSafeInteger(item.size) ? item.size! : null,
    width: dimensions?.width ?? null,
    height: dimensions?.height ?? null,
    capturedAt: date(item.photo?.takenDateTime),
    createdAt: date(item.createdDateTime),
    modifiedAt: date(item.lastModifiedDateTime),
    thumbnailRevision: providerRevision(item.eTag),
    contentRevision: providerRevision(item.eTag),
    hasPreview: preview !== null,
    preview,
  };
}

function providerRevision(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    ? value
    : null;
}

function listedOneDrivePreview(
  previewUrl: string | undefined,
  previewNow: Date,
): TemporaryUrl | null {
  if (!previewUrl || previewUrl.length > 4_096) return null;
  try {
    const url = new URL(previewUrl);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { url: previewUrl, expiresAt: temporaryExpiry(previewNow) };
}

async function graphJson<T>(
  fetch: typeof globalThis.fetch,
  url: string | URL,
  accessToken: string,
  now: () => Date
): Promise<T> {
  return json<T>(await providerFetch(fetch, url, { headers: bearer(accessToken) }, { now }));
}

function requireGraphCursor(cursor: string): URL {
  try {
    const url = new URL(cursor);
    if (
      url.origin !== new URL(GRAPH_ENDPOINT).origin ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) throw invalidCursor();
    return url;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw invalidCursor();
  }
}

function requireFolderGraphCursor(cursor: string, folderId: string, pageSize: number): URL {
  const url = requireGraphCursor(cursor);
  const expectedPath = `/v1.0/me/drive/items/${encodeURIComponent(folderId)}/children`;
  if (url.pathname !== expectedPath) throw invalidCursor();

  const expected = new Map([
    ["$top", String(pageSize)],
    ["$select", ONEDRIVE_SELECT],
    ["$expand", "thumbnails($select=large)"]
  ]);
  const allowed = new Set(["$skiptoken", ...expected.keys()]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw invalidCursor();
    }
  }
  const skipTokens = url.searchParams.getAll("$skiptoken");
  if (skipTokens.length !== 1 || skipTokens[0].trim() === "") throw invalidCursor();
  for (const [key, value] of expected) {
    const actual = url.searchParams.get(key);
    if (actual !== null && actual !== value) throw invalidCursor();
  }
  return url;
}

function invalidCursor(): ProviderError {
  return new ProviderError(
    "PROVIDER_BAD_RESPONSE",
    "The cloud provider returned an invalid cursor.",
    { retryable: false }
  );
}

function requireString(value: string | undefined): string {
  if (!value) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "The cloud provider returned incomplete credentials.",
      { retryable: false }
    );
  }
  return value;
}

function requirePositive(value: number | undefined): number {
  if (!value || value <= 0) {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "The cloud provider returned incomplete credentials.",
      { retryable: false }
    );
  }
  return value;
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
