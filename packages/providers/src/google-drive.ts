import { bearer, json, providerFetch } from "./http";
import { ProviderError } from "./types";
import type {
  AuthenticatedMediaRequest,
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

    async getRoot(credentials) {
      const file = await googleJson<GoogleFile>(
        fetch,
        `${DRIVE_ENDPOINT}/files/root?fields=${encodeURIComponent(GOOGLE_FILE_FIELDS)}`,
        credentials.accessToken,
        now
      );
      const node = normalizeGoogleFile(file, credentials.accessTokenExpiresAt);
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
      const file = await googleJson<GoogleFile>(
        fetch,
        `${DRIVE_ENDPOINT}/files/${encodeURIComponent(input.providerNodeId)}?fields=${encodeURIComponent(GOOGLE_FILE_FIELDS)}&supportsAllDrives=true`,
        input.credentials.accessToken,
        now
      );
      const node = normalizeGoogleFile(file, input.credentials.accessTokenExpiresAt);
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
      const url = new URL(`${DRIVE_ENDPOINT}/files`);
      url.searchParams.set("q", `'${input.folderId.replaceAll("'", "\\'")}' in parents and trashed=false`);
      url.searchParams.set("pageSize", String(input.pageSize));
      url.searchParams.set("spaces", "drive");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      url.searchParams.set("fields", `nextPageToken,files(${GOOGLE_FILE_FIELDS})`);
      if (input.cursor) url.searchParams.set("pageToken", input.cursor);
      const page = await googleJson<GoogleFilePage>(fetch, url, input.credentials.accessToken, now);
      return {
        items: page.files
          .map((file) => normalizeGoogleFile(file, input.credentials.accessTokenExpiresAt))
          .filter(isDefined),
        nextCursor: page.nextPageToken ?? null
      };
    },

    async getThumbnailUrl(input: ThumbnailUrlInput): Promise<TemporaryUrl | null> {
      if (input.kind === "folder") {
        const url = new URL(`${DRIVE_ENDPOINT}/files`);
        url.searchParams.set(
          "q",
          `'${input.providerNodeId.replaceAll("'", "\\'")}' in parents and trashed=false and (mimeType contains 'image/' or mimeType contains 'video/')`
        );
        url.searchParams.set("pageSize", "1");
        url.searchParams.set("orderBy", "modifiedTime desc");
        url.searchParams.set("spaces", "drive");
        url.searchParams.set("supportsAllDrives", "true");
        url.searchParams.set("includeItemsFromAllDrives", "true");
        url.searchParams.set("fields", "files(id,mimeType,thumbnailLink)");
        const page = await googleJson<GoogleFilePage>(
          fetch,
          url,
          input.credentials.accessToken,
          now
        );
        const preview = listedGooglePreview(
          page.files.find((file) => Boolean(file.thumbnailLink))?.thumbnailLink,
          input.credentials.accessTokenExpiresAt
        );
        return preview
          ? { url: googleThumbnailUrl(preview.url, input.maxDimension), expiresAt: preview.expiresAt }
          : null;
      }
      const file = await googleJson<GoogleFile>(
        fetch,
        `${DRIVE_ENDPOINT}/files/${encodeURIComponent(input.providerNodeId)}?fields=mimeType%2CthumbnailLink&supportsAllDrives=true`,
        input.credentials.accessToken,
        now
      );
      if (
        (!file.mimeType?.startsWith("image/") &&
          !file.mimeType?.startsWith("video/")) ||
        !file.thumbnailLink
      ) {
        return null;
      }
      return {
        url: googleThumbnailUrl(file.thumbnailLink, input.maxDimension),
        expiresAt: input.credentials.accessTokenExpiresAt
      };
    },

    async getMediaUrl(input: MediaUrlInput): Promise<AuthenticatedMediaRequest> {
      return {
        url: googleMediaUrl(input.providerNodeId),
        headers: { authorization: `Bearer ${input.credentials.accessToken}` },
        expiresAt: input.credentials.accessTokenExpiresAt
      };
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

function normalizeGoogleFile(
  file: GoogleFile,
  previewExpiresAt: Date,
): ProviderNode | null {
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
  const preview = listedGooglePreview(file.thumbnailLink, previewExpiresAt);
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
    hasPreview: preview !== null,
    preview,
  };
}

function listedGooglePreview(
  thumbnailLink: string | undefined,
  expiresAt: Date,
): TemporaryUrl | null {
  if (!thumbnailLink) return null;
  try {
    return {
      url: googleThumbnailUrl(thumbnailLink, 720),
      expiresAt: new Date(expiresAt.getTime()),
    };
  } catch {
    return null;
  }
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

function googleMediaUrl(providerNodeId: string): string {
  const url = new URL(`${DRIVE_ENDPOINT}/files/${encodeURIComponent(providerNodeId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url.toString();
}

function googleThumbnailUrl(value: string, maxDimension: number): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !validGoogleThumbnailHost(hostname) ||
    url.search !== "" ||
    !/=s\d+$/u.test(url.pathname)
  ) {
    throw badResponse();
  }
  url.pathname = url.pathname.replace(/=s\d+$/u, `=s${maxDimension}`);
  return url.toString();
}

function validGoogleThumbnailHost(hostname: string): boolean {
  return /^lh\d+\.googleusercontent\.com$/u.test(hostname);
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
