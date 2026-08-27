import { isDeepStrictEqual } from "node:util";

import {
  ProviderError,
  type ProviderCredentials,
  type ProviderRegistry,
} from "@cloudframe/providers";
import type {
  ControlPlaneDocumentV2,
  ControlPlaneSource,
  EncryptedSecret,
} from "@cloudframe/shared";
import { getCache } from "@vercel/functions";

import {
  markSourceReauthRequiredMutation,
  rotateSourceCredentialsMutation,
} from "../control-plane/mutations";
import type {
  ControlMutationResult,
  ControlPlaneStore,
} from "../control-plane/store";
import {
  decryptProviderToken,
  encryptProviderToken,
  type ProviderTokenKeyring,
} from "../crypto/provider-tokens";
import type { ControlRequestContext } from "./control-auth";

export interface CredentialRuntimeCache {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    options?: { name?: string; tags?: string[]; ttl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CredentialBroker {
  get(sourceId: string, householdId: string): Promise<ProviderCredentials>;
  refresh(sourceId: string, householdId: string): Promise<ProviderCredentials>;
}

export interface CreateCredentialBrokerOptions {
  controlStore: ControlPlaneStore;
  controlState: () => ControlRequestContext;
  providers: ProviderRegistry;
  providerTokenKeyring: ProviderTokenKeyring;
  cache?: CredentialRuntimeCache;
  now?: () => Date;
}

export type CredentialBrokerErrorCode = "SOURCE_NOT_FOUND";

export class CredentialBrokerError extends Error {
  constructor(readonly code: CredentialBrokerErrorCode) {
    super(code);
    this.name = "CredentialBrokerError";
  }
}

interface CachedCredentials {
  encryptedAccessToken: EncryptedSecret;
  accessTokenExpiresAt: string;
}

interface RotationResult {
  source: ControlPlaneSource;
  rotated: boolean;
}

const refreshes = new Map<string, Promise<ProviderCredentials>>();

function notFound(): CredentialBrokerError {
  return new CredentialBrokerError("SOURCE_NOT_FOUND");
}

function reauthRequired(): ProviderError {
  return new ProviderError(
    "PROVIDER_REAUTH_REQUIRED",
    "Provider authorization is required.",
    { retryable: false },
  );
}

function credentialKey(source: ControlPlaneSource): string {
  return `source:${source.id}:credentials:${source.credentialVersion}`;
}

function refreshKey(householdId: string, source: ControlPlaneSource): string {
  return `${householdId}:${credentialKey(source)}`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function encryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<EncryptedSecret>;
  return (
    typeof candidate.keyVersion === "string" &&
    candidate.keyVersion.length > 0 &&
    typeof candidate.iv === "string" &&
    candidate.iv.length > 0 &&
    typeof candidate.ciphertext === "string" &&
    candidate.ciphertext.length > 0 &&
    typeof candidate.authTag === "string" &&
    candidate.authTag.length > 0 &&
    Object.keys(candidate).length === 4
  );
}

function cachedCredentials(value: unknown): value is CachedCredentials {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<CachedCredentials>;
  return (
    Object.keys(candidate).length === 2 &&
    encryptedSecret(candidate.encryptedAccessToken) &&
    validTimestamp(candidate.accessTokenExpiresAt)
  );
}

function activeSource(
  context: ControlRequestContext,
  sourceId: string,
  householdId: string,
): ControlPlaneSource {
  if (
    context.revision !== context.document.revision ||
    context.document.householdId !== householdId
  ) {
    throw notFound();
  }
  const source = context.document.sources[sourceId];
  if (!source || source.status === "disabled") throw notFound();
  if (source.status === "reauth-required") throw reauthRequired();
  return source;
}

function usableExpiry(expiresAt: Date, now: Date): boolean {
  return (
    Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > now.getTime()
  );
}

function accessCredentials(
  accessToken: string,
  accessTokenExpiresAt: Date,
): ProviderCredentials {
  return { accessToken, refreshToken: null, accessTokenExpiresAt };
}

function revisioned<T>(
  current: ControlPlaneDocumentV2,
  mutation: ControlMutationResult<T>,
): ControlMutationResult<T> {
  if (!mutation.changed) return mutation;
  return {
    ...mutation,
    next: { ...mutation.next, revision: current.revision + 1 },
  };
}

function sameSecret(left: EncryptedSecret, right: EncryptedSecret): boolean {
  return isDeepStrictEqual(left, right);
}

function validProviderCredentials(
  credentials: ProviderCredentials,
): credentials is ProviderCredentials {
  return (
    typeof credentials?.accessToken === "string" &&
    credentials.accessToken.length > 0 &&
    (credentials.refreshToken === null ||
      (typeof credentials.refreshToken === "string" &&
        credentials.refreshToken.length > 0)) &&
    credentials.accessTokenExpiresAt instanceof Date &&
    Number.isFinite(credentials.accessTokenExpiresAt.getTime())
  );
}

async function deleteBestEffort(
  cache: CredentialRuntimeCache,
  key: string,
): Promise<void> {
  try {
    await cache.delete(key);
  } catch {
    // Cache loss is safe; current control state still gates every credential use.
  }
}

export function createCredentialBroker(
  options: CreateCredentialBrokerOptions,
): CredentialBroker {
  const cache: CredentialRuntimeCache =
    options.cache ?? getCache({ namespace: "cloudframe-credentials" });
  const now = options.now ?? (() => new Date());
  const keys = options.providerTokenKeyring.keys;

  async function readCached(
    source: ControlPlaneSource,
  ): Promise<ProviderCredentials | null> {
    const key = credentialKey(source);
    let value: unknown;
    try {
      value = await cache.get(key);
    } catch {
      return null;
    }
    if (value === null) return null;
    if (!cachedCredentials(value)) {
      await deleteBestEffort(cache, key);
      return null;
    }
    const accessTokenExpiresAt = new Date(value.accessTokenExpiresAt);
    if (!usableExpiry(accessTokenExpiresAt, now())) {
      await deleteBestEffort(cache, key);
      return null;
    }
    try {
      const accessToken = decryptProviderToken(
        value.encryptedAccessToken,
        keys,
      );
      if (!accessToken) {
        await deleteBestEffort(cache, key);
        return null;
      }
      return accessCredentials(accessToken, accessTokenExpiresAt);
    } catch {
      await deleteBestEffort(cache, key);
      return null;
    }
  }

  async function cacheAccess(
    source: ControlPlaneSource,
    credentials: ProviderCredentials,
  ): Promise<void> {
    const ttl = Math.max(
      1,
      Math.floor(
        (credentials.accessTokenExpiresAt.getTime() - now().getTime()) / 1_000,
      ) - 60,
    );
    const key = credentialKey(source);
    const value: CachedCredentials = {
      encryptedAccessToken: encryptProviderToken(
        credentials.accessToken,
        options.providerTokenKeyring,
      ),
      accessTokenExpiresAt: credentials.accessTokenExpiresAt.toISOString(),
    };
    try {
      await cache.set(key, value, { ttl });
      const verified = await cache.get(key);
      if (!isDeepStrictEqual(verified, value)) {
        await deleteBestEffort(cache, key);
      }
    } catch {
      await deleteBestEffort(cache, key);
    }
  }

  async function bootstrap(
    source: ControlPlaneSource,
  ): Promise<ProviderCredentials | null> {
    if (
      source.encryptedBootstrapAccessToken === null ||
      source.bootstrapAccessTokenExpiresAt === null
    ) {
      return null;
    }
    const accessTokenExpiresAt = new Date(source.bootstrapAccessTokenExpiresAt);
    if (!usableExpiry(accessTokenExpiresAt, now())) return null;
    try {
      const accessToken = decryptProviderToken(
        source.encryptedBootstrapAccessToken,
        keys,
      );
      return accessToken
        ? accessCredentials(accessToken, accessTokenExpiresAt)
        : null;
    } catch {
      return null;
    }
  }

  async function markReauth(
    sourceId: string,
    householdId: string,
    expected: ControlPlaneSource,
  ): Promise<ControlPlaneSource> {
    return options.controlStore.mutate(
      "mark-source-reauth-required",
      (current) => {
        if (current.householdId !== householdId) throw notFound();
        const source = current.sources[sourceId];
        if (!source || source.status === "disabled") throw notFound();
        if (
          source.credentialVersion !== expected.credentialVersion ||
          !sameSecret(
            source.encryptedRefreshToken,
            expected.encryptedRefreshToken,
          )
        ) {
          return { changed: false, next: current, result: source };
        }
        return revisioned(
          current,
          markSourceReauthRequiredMutation(current, sourceId),
        );
      },
    );
  }

  async function rotateRefreshToken(
    source: ControlPlaneSource,
    householdId: string,
    refreshToken: string,
  ): Promise<RotationResult> {
    const encryptedRefreshToken = encryptProviderToken(
      refreshToken,
      options.providerTokenKeyring,
    );
    return options.controlStore.mutate(
      "rotate-source-credentials",
      (current) => {
        if (current.householdId !== householdId) throw notFound();
        const currentSource = current.sources[source.id];
        if (!currentSource || currentSource.status === "disabled")
          throw notFound();
        if (currentSource.status === "reauth-required") throw reauthRequired();
        if (
          currentSource.credentialVersion !== source.credentialVersion ||
          !sameSecret(
            currentSource.encryptedRefreshToken,
            source.encryptedRefreshToken,
          )
        ) {
          return {
            changed: false,
            next: current,
            result: { source: currentSource, rotated: false },
          };
        }
        const mutation = rotateSourceCredentialsMutation(
          current,
          source.id,
          source.credentialVersion,
          encryptedRefreshToken,
        );
        const next = revisioned(current, mutation);
        return {
          ...next,
          result: { source: next.result, rotated: next.changed },
        };
      },
    );
  }

  async function refresh(
    source: ControlPlaneSource,
    householdId: string,
  ): Promise<ProviderCredentials> {
    let refreshToken: string;
    try {
      refreshToken = decryptProviderToken(source.encryptedRefreshToken, keys);
    } catch {
      throw reauthRequired();
    }

    let refreshed: ProviderCredentials;
    try {
      refreshed = await options.providers
        .get(source.provider)
        .refreshCredentials({
          id: source.id,
          provider: source.provider,
          credentials: {
            accessToken: "",
            refreshToken,
            accessTokenExpiresAt: new Date(0),
          },
        });
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_REAUTH_REQUIRED" &&
        error.reauthReason === "invalid_grant"
      ) {
        const winner = await markReauth(source.id, householdId, source);
        if (
          winner.credentialVersion !== source.credentialVersion ||
          !sameSecret(
            winner.encryptedRefreshToken,
            source.encryptedRefreshToken,
          )
        ) {
          if (winner.status === "reauth-required") throw error;
          const cached = await readCached(winner);
          return cached ?? refreshDeduplicated(winner, householdId);
        }
      }
      throw error;
    }

    if (
      !validProviderCredentials(refreshed) ||
      !usableExpiry(refreshed.accessTokenExpiresAt, now())
    ) {
      throw new ProviderError(
        "PROVIDER_BAD_RESPONSE",
        "Provider returned invalid credentials.",
        { retryable: false },
      );
    }

    const access = accessCredentials(
      refreshed.accessToken,
      refreshed.accessTokenExpiresAt,
    );
    const returnedRefreshToken = refreshed.refreshToken;
    if (
      returnedRefreshToken === null ||
      returnedRefreshToken === refreshToken
    ) {
      await cacheAccess(source, access);
      return access;
    }

    const rotation = await rotateRefreshToken(
      source,
      householdId,
      returnedRefreshToken,
    );
    if (rotation.rotated) {
      await cacheAccess(rotation.source, access);
      return access;
    }

    if (rotation.source.status === "reauth-required") throw reauthRequired();
    const winning = await readCached(rotation.source);
    if (winning) return winning;
    return refreshDeduplicated(rotation.source, householdId);
  }

  async function refreshDeduplicated(
    source: ControlPlaneSource,
    householdId: string,
  ): Promise<ProviderCredentials> {
    const key = refreshKey(householdId, source);
    const running = refreshes.get(key);
    if (running) return running;
    const promise = refresh(source, householdId);
    refreshes.set(key, promise);
    try {
      return await promise;
    } finally {
      if (refreshes.get(key) === promise) refreshes.delete(key);
    }
  }

  async function getForSource(
    source: ControlPlaneSource,
    householdId: string,
  ): Promise<ProviderCredentials> {
    if (source.status === "disabled") throw notFound();
    if (source.status === "reauth-required") throw reauthRequired();
    const cached = await readCached(source);
    if (cached) return cached;
    const initial = await bootstrap(source);
    if (initial) {
      await cacheAccess(source, initial);
      return initial;
    }
    return refreshDeduplicated(source, householdId);
  }

  async function get(
    sourceId: string,
    householdId: string,
  ): Promise<ProviderCredentials> {
    const source = activeSource(options.controlState(), sourceId, householdId);
    return getForSource(source, householdId);
  }

  async function forceRefresh(
    sourceId: string,
    householdId: string,
  ): Promise<ProviderCredentials> {
    const source = activeSource(options.controlState(), sourceId, householdId);
    return refreshDeduplicated(source, householdId);
  }

  return { get, refresh: forceRefresh };
}
