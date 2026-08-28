import {
  createHash,
  randomBytes as nodeRandomBytes,
  timingSafeEqual
} from "node:crypto";

import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderKind,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import type {
  ControlPlaneDocumentV2,
  ControlPlaneSource,
  EncryptedSecret
} from "@cloudframe/shared";
import { assertProviderAuthorizationUrl } from "@cloudframe/shared";
import { getCache, type RuntimeCache } from "@vercel/functions";

import type { SealedSessionCodec } from "../auth/sealed-sessions";
import { hashOpaqueToken } from "../auth/tokens";
import {
  connectSourceMutation,
  reconnectSourceMutation
} from "../control-plane/mutations";
import type {
  ControlMutationResult,
  ControlPlaneStore
} from "../control-plane/store";
import {
  encryptProviderToken,
  type ProviderTokenKeyring
} from "../crypto/provider-tokens";
import type {
  AuthenticatedControlAdmin,
  ControlRequestContext
} from "./control-auth";

const OAUTH_STATE_BYTES = 32;
const OAUTH_VERIFIER_BYTES = 48;
const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1_000;
const OAUTH_STATE_LIFETIME_SECONDS = OAUTH_STATE_LIFETIME_MS / 1_000;
const OAUTH_COOKIE_NAME = "oauth_state";

export interface ControlOAuthBeginInput {
  admin: AuthenticatedControlAdmin;
  context: ControlRequestContext;
  provider: ProviderKind;
  reconnectSourceId?: string;
}

export interface ControlOAuthBeginResult {
  authorizationUrl: string;
  stateCookie: string;
}

export interface ControlOAuthCompleteInput {
  admin: AuthenticatedControlAdmin;
  context: ControlRequestContext;
  provider: ProviderKind;
  state: string;
  stateCookie: string;
  code?: string;
  providerError?: string;
}

export interface ControlOAuthCompleteResult {
  sourceId: string;
  status: "connected";
}

export interface ControlOAuthService {
  beginAuthorization(
    input: ControlOAuthBeginInput
  ): Promise<ControlOAuthBeginResult>;
  completeAuthorization(
    input: ControlOAuthCompleteInput
  ): Promise<ControlOAuthCompleteResult>;
}

export interface ControlOAuthReplayCache {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    options?: { ttl?: number }
  ): Promise<void>;
}

export interface ControlOAuthServiceDependencies {
  store: ControlPlaneStore;
  codec: SealedSessionCodec;
  providers: ProviderRegistry;
  keyring: ProviderTokenKeyring;
  redirectUris: Record<ProviderKind, string>;
  runtimeCache?: ControlOAuthReplayCache;
  now?: () => Date;
  createId?: () => string;
  randomBytes?: (size: number) => Uint8Array;
}

export type ControlOAuthServiceErrorCode =
  | "OAUTH_ACCOUNT_MISMATCH"
  | "OAUTH_CANCELLED"
  | "OAUTH_PROVIDER_ERROR"
  | "OAUTH_STATE_INVALID"
  | "SOURCE_NOT_FOUND";

export class ControlOAuthServiceError extends Error {
  constructor(readonly code: ControlOAuthServiceErrorCode) {
    super(code);
    this.name = "ControlOAuthServiceError";
  }
}

function fail(code: ControlOAuthServiceErrorCode): never {
  throw new ControlOAuthServiceError(code);
}

function stateInvalid(): never {
  fail("OAUTH_STATE_INVALID");
}

function providerInvalid(): never {
  fail("OAUTH_PROVIDER_ERROR");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function visibleLabel(value: unknown): value is string {
  return nonEmpty(value) && value.length <= 120 && value === value.trim();
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function formatStateCookie(token: string, expiresAt: Date): string {
  return [
    `${OAUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Expires=${expiresAt.toUTCString()}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function cookieToken(value: string): string {
  const prefix = `${OAUTH_COOKIE_NAME}=`;
  const candidate = value.startsWith(prefix)
    ? value.slice(prefix.length).split(";", 1)[0]
    : value;
  if (!candidate) stateInvalid();
  try {
    return decodeURIComponent(candidate);
  } catch {
    stateInvalid();
  }
}

function assertActiveAdmin(
  admin: AuthenticatedControlAdmin,
  context: ControlRequestContext
): ControlPlaneDocumentV2 {
  const { document, revision } = context;
  if (
    revision !== document.revision ||
    admin.householdId !== document.householdId ||
    admin.adminPassphraseVersion !== document.household.adminPassphraseVersion
  ) {
    stateInvalid();
  }
  return document;
}

function reconnectSource(
  document: ControlPlaneDocumentV2,
  sourceId: string,
  provider: ProviderKind
): ControlPlaneSource {
  const source = document.sources[sourceId];
  if (!source || source.provider !== provider) fail("SOURCE_NOT_FOUND");
  return source;
}

function activeReconnectSource(
  document: ControlPlaneDocumentV2,
  sourceId: string,
  provider: ProviderKind
): ControlPlaneSource {
  const source = document.sources[sourceId];
  if (!source || source.provider !== provider) stateInvalid();
  return source;
}

function validProviderResult(
  account: ProviderAccount,
  root: ProviderNode
): void {
  const expiry = account?.credentials?.accessTokenExpiresAt;
  if (
    !nonEmpty(account?.accountId) ||
    !visibleLabel(account?.accountLabel) ||
    !nonEmpty(account?.credentials?.accessToken) ||
    !(expiry instanceof Date) ||
    !Number.isFinite(expiry.getTime()) ||
    (account.credentials.refreshToken !== null &&
      !nonEmpty(account.credentials.refreshToken)) ||
    !nonEmpty(root?.providerNodeId) ||
    root.kind !== "folder" ||
    root.parentProviderId !== null
  ) {
    providerInvalid();
  }
}

function encryptedBootstrapAccessToken(
  account: ProviderAccount,
  keyring: ProviderTokenKeyring
): { token: EncryptedSecret | null; expiresAt: string | null } {
  return {
    token: encryptProviderToken(account.credentials.accessToken, keyring),
    expiresAt: account.credentials.accessTokenExpiresAt.toISOString()
  };
}

function revisioned<T>(
  current: ControlPlaneDocumentV2,
  mutation: ControlMutationResult<T>
): ControlMutationResult<T> {
  if (!mutation.changed) return mutation;
  return {
    ...mutation,
    next: { ...mutation.next, revision: current.revision + 1 }
  };
}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ControlOAuthServiceError) throw error;
    providerInvalid();
  }
}

async function replayMarkerAbsent(
  cache: ControlOAuthReplayCache,
  key: string
): Promise<void> {
  try {
    if ((await cache.get(key)) !== null) stateInvalid();
  } catch (error) {
    if (error instanceof ControlOAuthServiceError) throw error;
    stateInvalid();
  }
}

async function markReplayUsed(
  cache: ControlOAuthReplayCache,
  key: string,
  owner: string
): Promise<void> {
  try {
    await cache.set(key, owner, { ttl: OAUTH_STATE_LIFETIME_SECONDS });
  } catch {
    // Runtime Cache can report a failed set after accepting it; verify below.
  }
  try {
    if ((await cache.get(key)) !== owner) stateInvalid();
  } catch (error) {
    if (error instanceof ControlOAuthServiceError) throw error;
    stateInvalid();
  }
}

export function createControlOAuthService(
  dependencies: ControlOAuthServiceDependencies
): ControlOAuthService {
  const now = dependencies.now ?? (() => new Date());
  const createId =
    dependencies.createId ?? (() => `source-${crypto.randomUUID()}`);
  const randomBytes =
    dependencies.randomBytes ?? ((size: number) => nodeRandomBytes(size));
  const runtimeCache =
    dependencies.runtimeCache ??
    (getCache({ namespace: "cloudframe-control" }) as Pick<
      RuntimeCache,
      "get" | "set"
    >);
  const completingStates = new Set<string>();

  async function beginAuthorization(
    input: ControlOAuthBeginInput
  ): Promise<ControlOAuthBeginResult> {
    const document = assertActiveAdmin(input.admin, input.context);
    const redirectUri = dependencies.redirectUris[input.provider];
    if (!nonEmpty(redirectUri)) stateInvalid();
    const reconnect = input.reconnectSourceId
      ? reconnectSource(document, input.reconnectSourceId, input.provider)
      : undefined;
    const sourceId = reconnect?.id ?? createId();
    if (!nonEmpty(sourceId)) stateInvalid();

    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + OAUTH_STATE_LIFETIME_MS);
    const rawState = base64url(randomBytes(OAUTH_STATE_BYTES));
    const pkceVerifier = base64url(randomBytes(OAUTH_VERIFIER_BYTES));
    const stateToken = dependencies.codec.issueOAuthState({
      version: 2,
      householdId: input.admin.householdId,
      adminSessionId: input.admin.sessionId,
      provider: input.provider,
      redirectUri,
      sourceId,
      expectedControlRevision: input.context.revision,
      ...(reconnect === undefined
        ? {}
        : {
            reconnectSourceId: reconnect.id,
            expectedCredentialVersion: reconnect.credentialVersion
          }),
      pkceVerifier,
      stateHash: hashOpaqueToken(rawState),
      issuedAt: issuedAt.getTime(),
      expiresAt: expiresAt.getTime()
    });
    const started = await providerCall(() =>
      dependencies.providers.get(input.provider).beginAuthorization({
        state: rawState,
        redirectUri,
        codeChallenge: pkceChallenge(pkceVerifier)
      })
    );
    if (!nonEmpty(started?.authorizationUrl)) providerInvalid();
    try { assertProviderAuthorizationUrl(input.provider, started.authorizationUrl); } catch { providerInvalid(); }
    return {
      authorizationUrl: started.authorizationUrl,
      stateCookie: formatStateCookie(stateToken, expiresAt)
    };
  }

  async function completeAuthorization(
    input: ControlOAuthCompleteInput
  ): Promise<ControlOAuthCompleteResult> {
    assertActiveAdmin(input.admin, input.context);
    let claims;
    try {
      claims = dependencies.codec.openOAuthState(cookieToken(input.stateCookie));
    } catch {
      stateInvalid();
    }
    const redirectUri = dependencies.redirectUris[input.provider];
    const currentTime = now().getTime();
    if (
      !nonEmpty(redirectUri) ||
      claims.householdId !== input.admin.householdId ||
      claims.adminSessionId !== input.admin.sessionId ||
      claims.provider !== input.provider ||
      claims.redirectUri !== redirectUri ||
      input.context.revision !== claims.expectedControlRevision ||
      input.context.document.revision !== claims.expectedControlRevision ||
      claims.issuedAt > currentTime ||
      claims.expiresAt <= currentTime ||
      claims.expiresAt - claims.issuedAt <= 0 ||
      claims.expiresAt - claims.issuedAt > OAUTH_STATE_LIFETIME_MS ||
      !sameHash(hashOpaqueToken(input.state), claims.stateHash)
    ) {
      stateInvalid();
    }

    const replayKey = `oauth-used:${claims.stateHash}`;
    await replayMarkerAbsent(runtimeCache, replayKey);
    if (completingStates.has(claims.stateHash)) stateInvalid();
    completingStates.add(claims.stateHash);
    try {
      if (input.providerError) {
        fail(
          input.providerError === "access_denied"
            ? "OAUTH_CANCELLED"
            : "OAUTH_PROVIDER_ERROR"
        );
      }
      if (!nonEmpty(input.code)) providerInvalid();

      const activeDocument = assertActiveAdmin(input.admin, input.context);
      const expectedReconnect = claims.reconnectSourceId
        ? activeReconnectSource(
            activeDocument,
            claims.reconnectSourceId,
            claims.provider
          )
        : undefined;
      if (
        expectedReconnect &&
        expectedReconnect.credentialVersion !== claims.expectedCredentialVersion
      ) {
        stateInvalid();
      }

      const adapter: ProviderAdapter = dependencies.providers.get(claims.provider);
      const account = await providerCall(() =>
        adapter.completeAuthorization({
          code: input.code!,
          redirectUri,
          codeVerifier: claims.pkceVerifier
        })
      );
      const root = await providerCall(() => adapter.getRoot(account.credentials));
      validProviderResult(account, root);

      if (
        expectedReconnect &&
        (expectedReconnect.providerAccountId !== account.accountId ||
          expectedReconnect.providerRootId !== root.providerNodeId)
      ) {
        fail("OAUTH_ACCOUNT_MISMATCH");
      }

      const bootstrap = encryptedBootstrapAccessToken(
        account,
        dependencies.keyring
      );
      const encryptedRefreshToken = account.credentials.refreshToken
        ? encryptProviderToken(
            account.credentials.refreshToken,
            dependencies.keyring
          )
        : undefined;
      if (!expectedReconnect && !encryptedRefreshToken) providerInvalid();
      const createdAt = now().toISOString();

      await markReplayUsed(
        runtimeCache,
        replayKey,
        base64url(randomBytes(OAUTH_STATE_BYTES))
      );
      const stored = await dependencies.store.mutate(
        expectedReconnect ? "reconnect-source" : "connect-source",
        (current) => {
          if (
            current.revision !== claims.expectedControlRevision ||
            current.householdId !== input.admin.householdId ||
            current.household.adminPassphraseVersion !==
              input.admin.adminPassphraseVersion
          ) {
            stateInvalid();
          }
          if (claims.reconnectSourceId) {
            const currentSource = activeReconnectSource(
              current,
              claims.reconnectSourceId,
              claims.provider
            );
            if (
              currentSource.credentialVersion !==
              claims.expectedCredentialVersion
            ) {
              stateInvalid();
            }
            if (
              currentSource.providerAccountId !== account.accountId ||
              currentSource.providerRootId !== root.providerNodeId
            ) {
              fail("OAUTH_ACCOUNT_MISMATCH");
            }
            return revisioned(
              current,
              reconnectSourceMutation(current, claims.reconnectSourceId, {
                provider: claims.provider,
                providerAccountId: account.accountId,
                providerRootId: root.providerNodeId,
                accountLabel: account.accountLabel,
                ...(encryptedRefreshToken === undefined
                  ? {}
                  : { encryptedRefreshToken }),
                encryptedBootstrapAccessToken: bootstrap.token,
                bootstrapAccessTokenExpiresAt: bootstrap.expiresAt
              })
            );
          }

          if (current.sources[claims.sourceId]) stateInvalid();
          const source: ControlPlaneSource = {
            id: claims.sourceId,
            provider: claims.provider,
            providerAccountId: account.accountId,
            providerRootId: root.providerNodeId,
            accountLabel: account.accountLabel,
            encryptedRefreshToken: encryptedRefreshToken!,
            encryptedBootstrapAccessToken: bootstrap.token,
            bootstrapAccessTokenExpiresAt: bootstrap.expiresAt,
            credentialVersion: 1,
            status: "healthy",
            createdAt
          };
          return revisioned(current, connectSourceMutation(current, source));
        }
      );

      return { sourceId: stored.id, status: "connected" };
    } finally {
      completingStates.delete(claims.stateHash);
    }
  }

  return { beginAuthorization, completeAuthorization };
}
