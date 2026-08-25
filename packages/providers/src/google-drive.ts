import { bearer, json, providerFetch, temporaryExpiry } from "./http";
import { ProviderError } from "./types";
import type {
  AuthorizationCallback,
  ChangesPage,
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

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_ENDPOINT = "https://www.googleapis.com/drive/v3";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/drive.readonly"
].join(" ");

export function createGoogleDriveAdapter(
  dependencies: ProviderAdapterDependencies
): ProviderAdapter {
  const { clientId, clientSecret, fetch, now } = dependencies;

  return {
    async beginAuthorization(input) {
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: input.redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true"
      }).toString();
      return { authorizationUrl: url.toString() };
    },

    async completeAuthorization(input: AuthorizationCallback): Promise<ProviderAccount> {
      const credentials = await exchangeCode(
        fetch,
        clientId,
        clientSecret,
        input,
        now()
      );
      const account = await googleJson<{
        sub?: string;
        email?: string;
        name?: string;
      }>(fetch, USERINFO_ENDPOINT, credentials.accessToken, now);
      return {
        accountId: requireString(account.sub),
        accountLabel: account.email ?? account.name ?? "Google Drive",
        credentials
      };
    },

    async refreshCredentials(source: Source) {
      if (!source.credentials.refreshToken) {
        return Promise.reject(reauthRequired());
      }
      const response = await providerFetch(fetch, TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: source.credentials.refreshToken,
          grant_type: "refresh_token"
        })
      }, { now });
      const token = await json<GoogleTokenResponse>(response);
      return tokenCredentials(token, now(), source.credentials.refreshToken);
    },

    async listFolder(input: ListFolderInput) {
      const url = new URL(`${DRIVE_ENDPOINT}/files`);
      url.searchParams.set("q", `'${input.folderId.replaceAll("'", "\\'")}' in parents and trashed = false`);
      url.searchParams.set("pageSize", String(input.pageSize));
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("fields", `nextPageToken,files(${GOOGLE_FILE_FIELDS})`);
      if (input.cursor) url.searchParams.set("pageToken", input.cursor);
      const page = await googleJson<GoogleFilePage>(fetch, url, input.credentials.accessToken, now);
      return {
        items: page.files.map(normalizeGoogleFile).filter(isDefined),
        nextCursor: page.nextPageToken ?? null
      };
    },

    async getChanges(input) {
      if (!input.cursor) {
        const start = await googleJson<{ startPageToken: string }>(
          fetch,
          `${DRIVE_ENDPOINT}/changes/startPageToken?supportsAllDrives=true`,
          input.credentials.accessToken,
          now
        );
        return { changes: [], nextCursor: null, deltaCursor: start.startPageToken };
      }
      const url = new URL(`${DRIVE_ENDPOINT}/changes`);
      url.searchParams.set("pageToken", input.cursor);
      url.searchParams.set("pageSize", String(input.pageSize));
      url.searchParams.set("includeRemoved", "true");
      url.searchParams.set("fields", `nextPageToken,newStartPageToken,changes(fileId,removed,file(${GOOGLE_FILE_FIELDS}))`);
      const page = await googleJson<GoogleChangesResponse>(
        fetch,
        url,
        input.credentials.accessToken,
        now
      );
      const changes = page.changes
        .map(change => {
          if (change.removed) {
            return { providerNodeId: change.fileId, removed: true, node: null };
          }
          const node = change.file ? normalizeGoogleFile(change.file) : null;
          return node
            ? { providerNodeId: change.fileId, removed: false, node }
            : null;
        })
        .filter(isDefined);
      return {
        changes,
        nextCursor: page.nextPageToken ?? null,
        deltaCursor: page.nextPageToken ? null : page.newStartPageToken ?? input.cursor
      } satisfies ChangesPage;
    },

    async getThumbnailUrl(input: ThumbnailUrlInput): Promise<TemporaryUrl | null> {
      const file = await googleJson<GoogleFile>(
        fetch,
        `${DRIVE_ENDPOINT}/files/${encodeURIComponent(input.providerNodeId)}?fields=id,thumbnailLink,version`,
        input.credentials.accessToken,
        now
      );
      if (!file.thumbnailLink) return null;
      return {
        url: resizeGoogleThumbnail(file.thumbnailLink, input.maxDimension),
        expiresAt: temporaryExpiry(now(), input.credentials.accessTokenExpiresAt)
      };
    },

    async getMediaUrl(input: MediaUrlInput): Promise<TemporaryUrl> {
      const url = new URL(
        `${DRIVE_ENDPOINT}/files/${encodeURIComponent(input.providerNodeId)}`
      );
      url.searchParams.set("alt", "media");
      url.searchParams.set("access_token", input.credentials.accessToken);
      return { url: url.toString(), expiresAt: input.credentials.accessTokenExpiresAt };
    }
  };
}

const GOOGLE_FILE_FIELDS =
  "id,name,mimeType,parents,size,createdTime,modifiedTime,imageMediaMetadata(width,height,time),videoMediaMetadata(width,height),thumbnailLink,version";

interface GoogleFile {
  id: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  imageMediaMetadata?: { width?: number; height?: number; time?: string };
  videoMediaMetadata?: { width?: number; height?: number };
  thumbnailLink?: string;
  version?: string;
}

interface GoogleFilePage {
  files: GoogleFile[];
  nextPageToken?: string;
}

interface GoogleChangesResponse {
  changes: Array<{ fileId: string; removed?: boolean; file?: GoogleFile }>;
  nextPageToken?: string;
  newStartPageToken?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

async function exchangeCode(
  fetch: typeof globalThis.fetch,
  clientId: string,
  clientSecret: string,
  input: AuthorizationCallback,
  now: Date
): Promise<ProviderCredentials> {
  const response = await providerFetch(fetch, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code"
    })
  }, { now: () => now });
  return tokenCredentials(await json<GoogleTokenResponse>(response), now, null);
}

function tokenCredentials(
  token: GoogleTokenResponse,
  now: Date,
  fallbackRefreshToken: string | null
): ProviderCredentials {
  return {
    accessToken: requireString(token.access_token),
    refreshToken: token.refresh_token ?? fallbackRefreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + requirePositive(token.expires_in) * 1000)
  };
}

function normalizeGoogleFile(file: GoogleFile): ProviderNode | null {
  const mimeType = file.mimeType ?? "";
  const kind = mimeType === "application/vnd.google-apps.folder"
    ? "folder"
    : mimeType.startsWith("image/")
      ? "image"
      : mimeType.startsWith("video/")
        ? "video"
        : null;
  if (!kind || !file.id || !file.name) return null;
  const mediaMetadata = kind === "image" ? file.imageMediaMetadata : file.videoMediaMetadata;
  return {
    providerNodeId: file.id,
    parentProviderId: file.parents?.[0] ?? null,
    name: file.name,
    kind,
    mimeType: kind === "folder" ? null : mimeType,
    size: integer(file.size),
    width: mediaMetadata?.width ?? null,
    height: mediaMetadata?.height ?? null,
    capturedAt: date(file.imageMediaMetadata?.time),
    createdAt: date(file.createdTime),
    modifiedAt: date(file.modifiedTime),
    thumbnailRevision: file.version ?? null,
    hasPreview: Boolean(file.thumbnailLink)
  };
}

async function googleJson<T>(
  fetch: typeof globalThis.fetch,
  url: string | URL,
  accessToken: string,
  now: () => Date
): Promise<T> {
  return json<T>(await providerFetch(fetch, url, { headers: bearer(accessToken) }, {
    now
  }));
}

function resizeGoogleThumbnail(url: string, size: number): string {
  const normalized = Math.max(64, Math.min(4096, Math.round(size)));
  return /=[^/?#]+$/.test(url)
    ? url.replace(/=[^/?#]+$/, `=s${normalized}`)
    : `${url}=s${normalized}`;
}

function requireString(value: string | undefined): string {
  if (!value) throw badResponse();
  return value;
}

function requirePositive(value: number | undefined): number {
  if (!value || value <= 0) throw badResponse();
  return value;
}

function badResponse(): Error {
  return new ProviderError(
    "PROVIDER_BAD_RESPONSE",
    "The cloud provider returned an invalid response.",
    { retryable: false }
  );
}

function reauthRequired(): Error {
  return new ProviderError(
    "PROVIDER_REAUTH_REQUIRED",
    "Provider authorization is required.",
    { retryable: false }
  );
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function integer(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isDefined<T>(value: T | null): value is T {
  return value !== null;
}
