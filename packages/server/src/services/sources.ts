import type { Source } from "@cloudframe/shared";
import {
  ProviderError,
  type ProviderCredentials,
  type ProviderRegistry
} from "@cloudframe/providers";
import {
  decryptProviderToken,
  encryptProviderToken,
  type ProviderTokenKeyring
} from "../crypto/provider-tokens";
import type { AppRepository } from "../firestore/repository";

export interface CreateEncryptedSourceInput {
  id: string;
  householdId: string;
  provider: Source["provider"];
  providerAccountId: string | null;
  accountLabel: string;
  credentials: ProviderCredentials;
  createdAt: Date;
}

export interface DecryptedSource {
  source: Source;
  credentials: ProviderCredentials;
}

export interface SourceService {
  encryptSource(input: CreateEncryptedSourceInput): Source;
  decryptSource(source: Source): DecryptedSource;
  getUsableCredentials(sourceId: string, householdId: string): Promise<ProviderCredentials>;
}

export interface SourceServiceDependencies {
  repository: AppRepository;
  providers: ProviderRegistry;
  keyring: ProviderTokenKeyring;
  now: () => Date;
}

export function createSourceService(
  dependencies: SourceServiceDependencies
): SourceService {
  const { repository, providers, keyring, now } = dependencies;

  function encryptSource(input: CreateEncryptedSourceInput): Source {
    if (!input.credentials.refreshToken) {
      throw new ProviderError(
        "PROVIDER_REAUTH_REQUIRED",
        "Provider authorization did not include renewable credentials.",
        { retryable: false }
      );
    }
    return {
      id: input.id,
      householdId: input.householdId,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      providerRootId: null,
      accountLabel: input.accountLabel,
      encryptedRefreshToken: encryptProviderToken(
        input.credentials.refreshToken,
        keyring
      ),
      encryptedAccessToken: encryptProviderToken(
        input.credentials.accessToken,
        keyring
      ),
      accessTokenExpiresAt: input.credentials.accessTokenExpiresAt,
      status: "syncing",
      deltaCursor: null,
      crawlCheckpoint: null,
      activeWorkflowRunId: null,
      syncGeneration: null,
      nextSyncAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastSyncStartedAt: null,
      lastSyncCompletedAt: null,
      lastSyncErrorCode: null,
      createdAt: input.createdAt
    };
  }

  function decryptSource(source: Source): DecryptedSource {
    const accessToken = source.encryptedAccessToken
      ? decryptProviderToken(source.encryptedAccessToken, keyring.keys)
      : "";
    return {
      source,
      credentials: {
        accessToken,
        refreshToken: decryptProviderToken(
          source.encryptedRefreshToken,
          keyring.keys
        ),
        accessTokenExpiresAt: source.accessTokenExpiresAt ?? new Date(0)
      }
    };
  }

  async function getUsableCredentials(
    sourceId: string,
    householdId: string
  ): Promise<ProviderCredentials> {
    const source = await repository.getSource(sourceId);
    if (!source || source.householdId !== householdId) {
      throw new SourceServiceError("SOURCE_NOT_FOUND", "Source not found.");
    }
    const decrypted = decryptSource(source);
    const refreshAt = now().getTime() + 5 * 60 * 1000;
    if (
      decrypted.credentials.accessToken &&
      decrypted.credentials.accessTokenExpiresAt.getTime() > refreshAt
    ) {
      return decrypted.credentials;
    }

    try {
      const refreshed = await providers.get(source.provider).refreshCredentials({
        id: source.id,
        provider: source.provider,
        credentials: decrypted.credentials
      });
      const updated: Source = {
        ...source,
        encryptedRefreshToken: encryptProviderToken(
          refreshed.refreshToken ?? decrypted.credentials.refreshToken!,
          keyring
        ),
        encryptedAccessToken: encryptProviderToken(refreshed.accessToken, keyring),
        accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
        status: source.status === "reauth-required" ? "syncing" : source.status,
        lastSyncErrorCode: null
      };
      const committed = await repository.updateSourceCredentialsIfCurrent({
        sourceId,
        expectedEncryptedRefreshToken: source.encryptedRefreshToken,
        credentials: {
          encryptedRefreshToken: updated.encryptedRefreshToken,
          encryptedAccessToken: updated.encryptedAccessToken,
          accessTokenExpiresAt: updated.accessTokenExpiresAt
        }
      });
      if (!committed) throw new SourceServiceError("SOURCE_NOT_FOUND", "Source not found.");
      return decryptSource(committed).credentials;
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_REAUTH_REQUIRED"
      ) {
        const current = await repository.markSourceReauthRequiredIfCurrent({
          sourceId, expectedEncryptedRefreshToken: source.encryptedRefreshToken
        });
        if (current && current.status !== "reauth-required") return decryptSource(current).credentials;
      }
      throw error;
    }
  }

  return { encryptSource, decryptSource, getUsableCredentials };
}

export type SourceServiceErrorCode = "SOURCE_NOT_FOUND";

export class SourceServiceError extends Error {
  constructor(readonly code: SourceServiceErrorCode, message: string) {
    super(message);
    this.name = "SourceServiceError";
  }
}
