import type { ProviderKind } from "@cloudframe/shared";

export type { ProviderKind };

export interface ProviderCredentials {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
}

export interface AuthorizationInput {
  state: string;
  redirectUri: string;
  codeChallenge: string;
}

export interface AuthorizationStart {
  authorizationUrl: string;
}

export interface AuthorizationCallback {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export interface ProviderAccount {
  accountId: string;
  accountLabel: string;
  credentials: ProviderCredentials;
}

export interface Source {
  id: string;
  provider: ProviderKind;
  credentials: ProviderCredentials;
}

export type RefreshedCredentials = ProviderCredentials;

export interface ProviderNode {
  providerNodeId: string;
  parentProviderId: string | null;
  name: string;
  kind: "folder" | "image" | "video";
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: Date | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
  thumbnailRevision: string | null;
  hasPreview: boolean;
  preview?: TemporaryUrl | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListFolderInput {
  credentials: ProviderCredentials;
  folderId: string;
  cursor: string | null;
  pageSize: number;
}

export interface GetNodeInput {
  credentials: ProviderCredentials;
  providerNodeId: string;
}

export interface ThumbnailUrlInput {
  credentials: ProviderCredentials;
  providerNodeId: string;
  kind: ProviderNode["kind"];
  maxDimension: number;
}

export interface MediaUrlInput {
  credentials: ProviderCredentials;
  providerNodeId: string;
}

export interface TemporaryUrl {
  url: string;
  expiresAt: Date;
}

export interface AuthenticatedMediaRequest {
  url: string;
  headers: HeadersInit;
  expiresAt: Date;
}

export interface ProviderAdapter {
  beginAuthorization(input: AuthorizationInput): Promise<AuthorizationStart>;
  completeAuthorization(input: AuthorizationCallback): Promise<ProviderAccount>;
  refreshCredentials(source: Source): Promise<RefreshedCredentials>;
  getRoot(credentials: ProviderCredentials): Promise<ProviderNode>;
  getNode(input: GetNodeInput): Promise<ProviderNode>;
  listFolder(input: ListFolderInput): Promise<Page<ProviderNode>>;
  getThumbnailUrl(input: ThumbnailUrlInput): Promise<TemporaryUrl | null>;
  getMediaUrl(input: MediaUrlInput): Promise<TemporaryUrl | AuthenticatedMediaRequest>;
}

export type ProviderErrorCode =
  | "PROVIDER_BAD_RESPONSE"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_REAUTH_REQUIRED"
  | "PROVIDER_THROTTLED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE";

export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly reauthReason: "invalid_grant" | null;

  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options: {
      retryable: boolean;
      retryAfterSeconds?: number | null;
      reauthReason?: "invalid_grant" | null;
    }
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.reauthReason = options.reauthReason ?? null;
  }
}

export interface ProviderRegistry {
  get(provider: ProviderKind): ProviderAdapter;
}

export interface ProviderAdapterDependencies {
  clientId: string;
  clientSecret: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
}
