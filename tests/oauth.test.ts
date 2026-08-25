import type { Household } from "@cloudframe/shared";
import {
  MemoryRepository,
  createOAuthService,
  createSourceService
} from "@cloudframe/server";
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderRegistry
} from "@cloudframe/providers";
import { describe, expect, it, vi } from "vitest";

const now = new Date("2026-08-26T00:00:00.000Z");
const household: Household = {
  id: "household-a",
  createdAt: now,
  allowNewDeviceRequests: true,
  defaultMediaOrder: "captured-desc",
  defaultSlideshowSeconds: 10,
  adminPassphraseHash: "synthetic-passphrase-hash",
  adminPassphraseVersion: 1
};
const keyring = {
  currentVersion: "v1",
  keys: { v1: new Uint8Array(32).fill(7) }
};
const redirectUri = "https://app.synthetic.invalid/api/admin/oauth/google/callback";

function adapter(provider: "google" | "onedrive" = "google"): ProviderAdapter {
  return {
    beginAuthorization: vi.fn(async input => ({
      authorizationUrl: `https://authorize.synthetic.invalid/${provider}?state=${encodeURIComponent(input.state)}`
    })),
    completeAuthorization: vi.fn(async () => ({
      accountId: "synthetic-account-a",
      accountLabel: "Family cloud",
      credentials: {
        accessToken: "synthetic-access-token",
        refreshToken: "synthetic-refresh-token",
        accessTokenExpiresAt: new Date(now.getTime() + 60 * 60 * 1000)
      }
    })),
    refreshCredentials: vi.fn(async source => ({
      ...source.credentials,
      accessToken: "synthetic-refreshed-access",
      accessTokenExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000)
    })),
    listFolder: vi.fn(),
    getChanges: vi.fn(),
    getThumbnailUrl: vi.fn(),
    getMediaUrl: vi.fn()
  };
}

function registry(google = adapter("google"), onedrive = adapter("onedrive")): ProviderRegistry {
  return {
    get(provider) {
      return provider === "google" ? google : onedrive;
    }
  };
}

async function setup() {
  const repository = new MemoryRepository();
  await repository.putHousehold(household);
  const google = adapter("google");
  const startInitialSync = vi.fn(async (sourceId: string) => {
    expect(await repository.getSource(sourceId)).toMatchObject({ status: "syncing" });
  });
  let id = 0;
  let random = 0;
  let currentNow = now;
  const service = createOAuthService({
    repository,
    providers: registry(google),
    keyring,
    now: () => currentNow,
    createId: () => `source-${++id}`,
    randomBytes: size => new Uint8Array(size).fill(++random),
    startInitialSync
  });
  return {
    repository,
    google,
    startInitialSync,
    service,
    setNow(value: Date) {
      currentNow = value;
    }
  };
}

describe("OAuth state and encrypted source lifecycle", () => {
  it("persists only a hash of single-use ten-minute state bound to the admin session", async () => {
    const { repository, google, service } = await setup();
    const start = await service.beginAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri
    });

    expect(start.authorizationUrl).toContain("https://authorize.synthetic.invalid/google");
    const rawState = new URL(start.authorizationUrl).searchParams.get("state")!;
    expect(rawState).toBeTruthy();
    const states = await repository.listOAuthStates(household.id);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      consumedAt: null
    });
    expect(states[0].stateHash).not.toBe(rawState);
    expect(JSON.stringify(states[0])).not.toContain(rawState);
    expect(JSON.stringify(states[0])).not.toContain("synthetic-access-token");
    expect(google.beginAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ state: rawState, codeChallenge: expect.any(String) })
    );
  });

  it("does not expose or persist authorization URLs through an optional logger", async () => {
    const repository = new MemoryRepository();
    await repository.putHousehold(household);
    const google = adapter("google");
    const logger = vi.fn();
    const service = createOAuthService({
      repository,
      providers: registry(google),
      keyring,
      now: () => now,
      createId: () => "source-a",
      randomBytes: size => new Uint8Array(size).fill(9),
      startInitialSync: async () => undefined,
      logger
    });

    const start = await service.beginAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri
    });

    expect(start.authorizationUrl).toContain("authorize.synthetic.invalid");
    expect(logger).not.toHaveBeenCalled();
    expect(JSON.stringify(await repository.listOAuthStates(household.id))).not.toContain(
      "authorize.synthetic.invalid"
    );
  });

  it("atomically consumes state before exchange, encrypts credentials, persists, then starts sync", async () => {
    const { repository, google, startInitialSync, service } = await setup();
    const start = await service.beginAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    vi.mocked(google.completeAuthorization).mockImplementationOnce(async () => {
      const stored = (await repository.listOAuthStates(household.id))[0]!;
      expect(stored.consumedAt).toEqual(now);
      return {
        accountId: "synthetic-account-a",
        accountLabel: "Family cloud",
        credentials: {
          accessToken: "synthetic-access-token",
          refreshToken: "synthetic-refresh-token",
          accessTokenExpiresAt: new Date(now.getTime() + 60 * 60 * 1000)
        }
      };
    });

    const result = await service.completeAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri,
      state,
      code: "synthetic-code"
    });

    expect(result).toEqual({ sourceId: "source-1", status: "connected" });
    const verifier = vi.mocked(google.completeAuthorization).mock.calls[0]?.[0]
      .codeVerifier;
    const challenge = vi.mocked(google.beginAuthorization).mock.calls[0]?.[0]
      .codeChallenge;
    expect(verifier).toBeTruthy();
    expect(await sha256Base64Url(verifier!)).toBe(challenge);
    const source = await repository.getSource("source-1");
    expect(source).toMatchObject({
      householdId: household.id,
      provider: "google",
      accountLabel: "Family cloud",
      status: "syncing"
    });
    expect(JSON.stringify(source)).not.toContain("synthetic-access-token");
    expect(JSON.stringify(source)).not.toContain("synthetic-refresh-token");
    expect(startInitialSync).toHaveBeenCalledWith("source-1");
  });

  it("rejects replay, expiry, provider mismatch, session mismatch, household mismatch, and redirect mismatch", async () => {
    const cases = [
      { name: "expired", mutateTime: true },
      { name: "provider", patch: { provider: "onedrive" as const } },
      { name: "session", patch: { adminSessionId: "admin-session-b" } },
      { name: "household", patch: { householdId: "household-b" } },
      { name: "redirect", patch: { redirectUri: `${redirectUri}/wrong` } }
    ];

    for (const scenario of cases) {
      const { google, service, setNow } = await setup();
      const start = await service.beginAuthorization({
        householdId: household.id,
        adminSessionId: "admin-session-a",
        provider: "google",
        redirectUri
      });
      const state = new URL(start.authorizationUrl).searchParams.get("state")!;
      const input = {
        householdId: household.id,
        adminSessionId: "admin-session-a",
        provider: "google" as const,
        redirectUri,
        state,
        code: "synthetic-code",
        ...(scenario.patch ?? {})
      };
      if (scenario.mutateTime) {
        setNow(new Date(now.getTime() + 10 * 60 * 1000 + 1));
      }

      await expect(service.completeAuthorization(input)).rejects.toMatchObject({
        code: "OAUTH_STATE_INVALID"
      });
      expect(google.completeAuthorization).not.toHaveBeenCalled();
    }

    const { google, service } = await setup();
    const start = await service.beginAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    const callback = {
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google" as const,
      redirectUri,
      state,
      code: "synthetic-code"
    };
    await service.completeAuthorization(callback);
    await expect(service.completeAuthorization(callback)).rejects.toMatchObject({
      code: "OAUTH_STATE_INVALID"
    });
    expect(google.completeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("consumes state and maps provider cancellation without exchanging a code", async () => {
    const { repository, google, service } = await setup();
    const start = await service.beginAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;

    await expect(
      service.completeAuthorization({
        householdId: household.id,
        adminSessionId: "admin-session-a",
        provider: "google",
        redirectUri,
        state,
        providerError: "access_denied"
      })
    ).rejects.toMatchObject({ code: "OAUTH_CANCELLED" });
    expect(google.completeAuthorization).not.toHaveBeenCalled();
    expect((await repository.listOAuthStates(household.id))[0]?.consumedAt).toEqual(now);
  });

  it("reconnects only a matching household/provider source and retains refresh token when omitted", async () => {
    const { repository, google, service } = await setup();
    const sourceService = createSourceService({
      repository,
      providers: registry(google),
      keyring,
      now: () => now
    });
    await repository.putSource(
      sourceService.encryptSource({
        id: "source-existing",
        householdId: household.id,
        provider: "google",
        accountLabel: "Old label",
        credentials: {
          accessToken: "synthetic-old-access",
          refreshToken: "synthetic-old-refresh",
          accessTokenExpiresAt: new Date(now.getTime() + 1000)
        },
        createdAt: new Date("2025-01-01T00:00:00.000Z")
      })
    );
    vi.mocked(google.completeAuthorization).mockResolvedValueOnce({
      accountId: "synthetic-account-a",
      accountLabel: "New label",
      credentials: {
        accessToken: "synthetic-new-access",
        refreshToken: null,
        accessTokenExpiresAt: new Date(now.getTime() + 60 * 60 * 1000)
      }
    });
    const start = await service.beginAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri,
      reconnectSourceId: "source-existing"
    });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    await service.completeAuthorization({
      householdId: household.id,
      adminSessionId: "admin-session-a",
      provider: "google",
      redirectUri,
      state,
      code: "synthetic-code"
    });

    const updated = await repository.getSource("source-existing");
    const decrypted = sourceService.decryptSource(updated!);
    expect(updated).toMatchObject({ accountLabel: "New label", status: "syncing" });
    expect(decrypted.credentials).toMatchObject({
      accessToken: "synthetic-new-access",
      refreshToken: "synthetic-old-refresh"
    });

    await expect(
      service.beginAuthorization({
        householdId: "household-b",
        adminSessionId: "admin-session-a",
        provider: "google",
        redirectUri,
        reconnectSourceId: "source-existing"
      })
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });
});

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("base64url");
}

describe("source credential refresh", () => {
  it("decrypts only inside the service boundary, refreshes, and re-encrypts tokens", async () => {
    const repository = new MemoryRepository();
    const google = adapter("google");
    const service = createSourceService({
      repository,
      providers: registry(google),
      keyring,
      now: () => now
    });
    const source = service.encryptSource({
      id: "source-a",
      householdId: household.id,
      provider: "google",
      accountLabel: "Family cloud",
      credentials: {
        accessToken: "synthetic-stale-access",
        refreshToken: "synthetic-refresh-token",
        accessTokenExpiresAt: new Date(now.getTime() + 30 * 1000)
      },
      createdAt: now
    });
    await repository.putSource(source);

    const usable = await service.getUsableCredentials("source-a", household.id);

    expect(usable.accessToken).toBe("synthetic-refreshed-access");
    expect(google.refreshCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "source-a",
        provider: "google",
        credentials: expect.objectContaining({ refreshToken: "synthetic-refresh-token" })
      })
    );
    const stored = await repository.getSource("source-a");
    expect(JSON.stringify(stored)).not.toContain("synthetic-refreshed-access");
    expect(service.decryptSource(stored!).credentials.accessToken).toBe(
      "synthetic-refreshed-access"
    );
  });

  it("marks the source reauth-required without exposing an invalid-grant payload", async () => {
    const repository = new MemoryRepository();
    const google = adapter("google");
    vi.mocked(google.refreshCredentials).mockRejectedValueOnce(
      new ProviderError("PROVIDER_REAUTH_REQUIRED", "Provider authorization is required.", {
        retryable: false
      })
    );
    const service = createSourceService({
      repository,
      providers: registry(google),
      keyring,
      now: () => now
    });
    await repository.putSource(
      service.encryptSource({
        id: "source-a",
        householdId: household.id,
        provider: "google",
        accountLabel: "Family cloud",
        credentials: {
          accessToken: "synthetic-stale-access",
          refreshToken: "synthetic-refresh-token",
          accessTokenExpiresAt: new Date(now.getTime() - 1000)
        },
        createdAt: now
      })
    );

    await expect(service.getUsableCredentials("source-a", household.id)).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED"
    });
    expect(await repository.getSource("source-a")).toMatchObject({
      status: "reauth-required",
      lastSyncErrorCode: "PROVIDER_REAUTH_REQUIRED"
    });
  });
});
