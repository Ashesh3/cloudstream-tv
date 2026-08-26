import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import type { AssignedRoot, OAuthState, ProviderKind, Source } from "@cloudframe/shared";
import type { ProviderRegistry } from "@cloudframe/providers";
import {
  decryptProviderToken,
  encryptProviderToken,
  type ProviderTokenKeyring
} from "../crypto/provider-tokens";
import { hashOpaqueToken } from "../auth/tokens";
import type { AppRepository } from "../firestore/repository";
import { assignedRootDocumentId } from "../firestore/repository";
import { createSourceService } from "./sources";

const STATE_BYTES = 32;
const VERIFIER_BYTES = 48;
const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthBeginInput {
  householdId: string;
  adminSessionId: string;
  provider: ProviderKind;
  redirectUri: string;
  reconnectSourceId?: string;
}

export interface OAuthCompleteInput {
  householdId: string;
  adminSessionId: string;
  provider: ProviderKind;
  redirectUri: string;
  state: string;
  code?: string;
  providerError?: string;
}

export interface OAuthServiceDependencies {
  repository: AppRepository;
  providers: ProviderRegistry;
  keyring: ProviderTokenKeyring;
  now: () => Date;
  createId: () => string;
  randomBytes?: (size: number) => Uint8Array;
  startInitialSync: (sourceId: string) => Promise<void>;
  logger?: (event: { code: string; provider: ProviderKind }) => void;
}

export function createOAuthService(dependencies: OAuthServiceDependencies) {
  const {
    repository,
    providers,
    keyring,
    now,
    createId,
    startInitialSync
  } = dependencies;
  const randomBytes = dependencies.randomBytes ?? (size => nodeRandomBytes(size));
  const sourceService = createSourceService({ repository, providers, keyring, now });

  async function beginAuthorization(input: OAuthBeginInput) {
    let reconnectSource: Source | null = null;
    if (input.reconnectSourceId) {
      reconnectSource = await repository.getSource(input.reconnectSourceId);
      if (
        !reconnectSource ||
        reconnectSource.householdId !== input.householdId ||
        reconnectSource.provider !== input.provider
      ) {
        throw new OAuthServiceError("SOURCE_NOT_FOUND", "Source not found.");
      }
    }

    const rawState = base64url(randomBytes(STATE_BYTES));
    const codeVerifier = base64url(randomBytes(VERIFIER_BYTES));
    const createdAt = now();
    const stateHash = hashOpaqueToken(rawState);
    const record: OAuthState = {
      id: stateHash,
      stateHash,
      householdId: input.householdId,
      adminSessionId: input.adminSessionId,
      provider: input.provider,
      redirectUri: input.redirectUri,
      reconnectSourceId: reconnectSource?.id ?? null,
      encryptedCodeVerifier: encryptProviderToken(codeVerifier, keyring),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + STATE_TTL_MS),
      consumedAt: null
    };
    await repository.createOAuthState(record);
    try {
      return await providers.get(input.provider).beginAuthorization({
        state: rawState,
        redirectUri: input.redirectUri,
        codeChallenge: sha256Base64Url(codeVerifier)
      });
    } catch (error) {
      await repository.consumeOAuthState({
        stateHash: record.stateHash,
        householdId: record.householdId,
        adminSessionId: record.adminSessionId,
        provider: record.provider,
        redirectUri: record.redirectUri,
        now: createdAt
      });
      throw error;
    }
  }

  async function completeAuthorization(input: OAuthCompleteInput) {
    const consumed = await repository.consumeOAuthState({
      stateHash: hashOpaqueToken(input.state),
      householdId: input.householdId,
      adminSessionId: input.adminSessionId,
      provider: input.provider,
      redirectUri: input.redirectUri,
      now: now()
    });
    if (!consumed) {
      throw new OAuthServiceError(
        "OAUTH_STATE_INVALID",
        "OAuth state is invalid or expired."
      );
    }
    if (input.providerError) {
      throw new OAuthServiceError(
        input.providerError === "access_denied" ? "OAUTH_CANCELLED" : "OAUTH_PROVIDER_ERROR",
        input.providerError === "access_denied"
          ? "Cloud authorization was cancelled."
          : "Cloud authorization failed."
      );
    }
    if (!input.code) {
      throw new OAuthServiceError(
        "OAUTH_PROVIDER_ERROR",
        "Cloud authorization failed."
      );
    }

    const codeVerifier = decryptProviderToken(
      consumed.encryptedCodeVerifier,
      keyring.keys
    );
    const account = await providers.get(input.provider).completeAuthorization({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier
    });

    let source: Source;
    let initialRoot: AssignedRoot | null = null;
    if (consumed.reconnectSourceId) {
      const existing = await repository.getSource(consumed.reconnectSourceId);
      if (
        !existing ||
        existing.householdId !== consumed.householdId ||
        existing.provider !== consumed.provider
      ) {
        throw new OAuthServiceError("SOURCE_NOT_FOUND", "Source not found.");
      }
      if (
        !existing.providerAccountId ||
        existing.providerAccountId !== account.accountId
      ) {
        throw new OAuthServiceError(
          "OAUTH_ACCOUNT_MISMATCH",
          "Reconnect must use the same cloud account."
        );
      }
      const current = sourceService.decryptSource(existing).credentials;
      const refreshToken = account.credentials.refreshToken ?? current.refreshToken;
      if (!refreshToken) {
        throw new OAuthServiceError(
          "OAUTH_PROVIDER_ERROR",
          "Cloud authorization did not include renewable access."
        );
      }
      source = {
        ...existing,
        accountLabel: account.accountLabel,
        encryptedRefreshToken: encryptProviderToken(refreshToken, keyring),
        encryptedAccessToken: encryptProviderToken(
          account.credentials.accessToken,
          keyring
        ),
        accessTokenExpiresAt: account.credentials.accessTokenExpiresAt,
        status: "syncing",
        lastSyncErrorCode: null
      };
    } else {
      source = sourceService.encryptSource({
        id: createId(),
        householdId: consumed.householdId,
        provider: consumed.provider,
        providerAccountId: account.accountId,
        accountLabel: account.accountLabel,
        credentials: account.credentials,
        createdAt: now()
      });
      const providerRoot = await providers
        .get(consumed.provider)
        .getRoot(account.credentials);
      if (providerRoot.kind !== "folder" || providerRoot.parentProviderId !== null) {
        throw new OAuthServiceError("OAUTH_PROVIDER_ERROR", "Cloud authorization failed.");
      }
      initialRoot = {
        id: assignedRootDocumentId(consumed.householdId, source.id, providerRoot.providerNodeId),
        householdId: consumed.householdId,
        sourceId: source.id,
        providerNodeId: providerRoot.providerNodeId,
        displayName: providerRoot.name || account.accountLabel,
        ancestryProviderIds: [],
        enabled: true,
        createdAt: now()
      };
    }

    if (initialRoot) {
      await repository.connectSourceWithRoot({ source, root: initialRoot });
    } else {
      await repository.putSource(source);
    }
    await startInitialSync(source.id);
    return { sourceId: source.id, status: "connected" as const };
  }

  return { beginAuthorization, completeAuthorization };
}

export type OAuthServiceErrorCode =
  | "OAUTH_STATE_INVALID"
  | "OAUTH_CANCELLED"
  | "OAUTH_PROVIDER_ERROR"
  | "OAUTH_ACCOUNT_MISMATCH"
  | "SOURCE_NOT_FOUND";

export class OAuthServiceError extends Error {
  constructor(readonly code: OAuthServiceErrorCode, message: string) {
    super(message);
    this.name = "OAuthServiceError";
  }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}
