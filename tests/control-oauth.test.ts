import { createHash } from "node:crypto";

import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import {
  ControlOAuthServiceError,
  createControlOAuthService,
  createSealedSessionCodec,
  decryptProviderToken
} from "@cloudframe/server";
import { describe, expect, it } from "vitest";

import { controlStoreHarness } from "../packages/server/src/control-plane/memory";
import {
  TEST_NOW,
  testAeadKeyring,
  testControlDocument
} from "./helpers/control-plane";

const REDIRECT_URI =
  "https://app.test/api/admin/sources/google/callback";
const ACCESS_EXPIRES_AT = new Date(TEST_NOW.getTime() + 45 * 60_000);

class MemoryReplayCache {
  readonly values = new Map<string, unknown>();
  readonly sets: Array<{
    key: string;
    value: unknown;
    options: { ttl?: number } | undefined;
  }> = [];
  synchronizeNextSets = 0;
  private synchronizedSets = 0;
  private releaseSynchronizedSets: (() => void) | undefined;
  private synchronizedSetGate: Promise<void> | undefined;

  async get(key: string): Promise<unknown | null> {
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }

  async set(
    key: string,
    value: unknown,
    options?: { ttl?: number }
  ): Promise<void> {
    this.sets.push({ key, value: structuredClone(value), options });
    this.values.set(key, structuredClone(value));
    if (this.synchronizeNextSets > 0) {
      this.synchronizedSets += 1;
      if (!this.synchronizedSetGate) {
        this.synchronizedSetGate = new Promise<void>((resolve) => {
          this.releaseSynchronizedSets = resolve;
        });
      }
      if (this.synchronizedSets === this.synchronizeNextSets) {
        this.releaseSynchronizedSets?.();
      }
      await this.synchronizedSetGate;
    }
  }
}

interface ProviderHarness {
  adapter: ProviderAdapter;
  beginInputs: Parameters<ProviderAdapter["beginAuthorization"]>[0][];
  completeInputs: Parameters<ProviderAdapter["completeAuthorization"]>[0][];
  account: ProviderAccount;
  root: ProviderNode;
  completeError: Error | null;
}

function providerHarness(): ProviderHarness {
  const harness: ProviderHarness = {
    beginInputs: [],
    completeInputs: [],
    account: {
      accountId: "account-new",
      accountLabel: "new@example.test",
      credentials: {
        accessToken: "bootstrap-access",
        refreshToken: "refresh-new",
        accessTokenExpiresAt: ACCESS_EXPIRES_AT
      }
    },
    root: {
      providerNodeId: "provider-root-new",
      parentProviderId: null,
      name: "My Drive",
      kind: "folder",
      mimeType: "application/vnd.google-apps.folder",
      size: null,
      width: null,
      height: null,
      capturedAt: null,
      createdAt: null,
      modifiedAt: null,
      thumbnailRevision: null,
      hasPreview: false
    },
    completeError: null,
    adapter: undefined as unknown as ProviderAdapter
  };
  harness.adapter = {
    async beginAuthorization(input) {
      harness.beginInputs.push(structuredClone(input));
      return {
        authorizationUrl: `https://accounts.example.test/authorize?state=${encodeURIComponent(input.state)}`
      };
    },
    async completeAuthorization(input) {
      harness.completeInputs.push(structuredClone(input));
      if (harness.completeError) throw harness.completeError;
      return structuredClone(harness.account);
    },
    async getRoot() {
      return structuredClone(harness.root);
    },
    async refreshCredentials() {
      throw new Error("unused");
    },
    async getNode() {
      throw new Error("unused");
    },
    async listFolder() {
      throw new Error("unused");
    },
    async getChanges() {
      throw new Error("unused");
    },
    async getThumbnailUrl() {
      throw new Error("unused");
    },
    async getMediaUrl() {
      throw new Error("unused");
    }
  };
  return harness;
}

function stateFromAuthorizationUrl(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get("state")!;
}

function sealedCookieValue(stateCookie: string): string {
  return decodeURIComponent(stateCookie.split(";", 1)[0].split("=", 2)[1]);
}

function setup(options: { replaceFailures?: number } = {}) {
  const document = testControlDocument();
  document.pendingDeviceRequests = {};
  const control = controlStoreHarness(document, options);
  const provider = providerHarness();
  const providers: ProviderRegistry = { get: () => provider.adapter };
  const replayCache = new MemoryReplayCache();
  const codec = createSealedSessionCodec(testAeadKeyring(), () => TEST_NOW);
  const keyring = {
    currentVersion: "provider-v1",
    keys: { "provider-v1": Buffer.alloc(32, 9) }
  };
  let randomByte = 1;
  const createOAuth = (sourceId = "source-new") =>
    createControlOAuthService({
      store: control.store,
      codec,
      providers,
      keyring,
      runtimeCache: replayCache,
      now: () => TEST_NOW,
      createId: () => sourceId,
      randomBytes: (size) => Buffer.alloc(size, randomByte++)
    });
  const oauth = createOAuth();

  async function beginGoogle(reconnectSourceId?: string) {
    return oauth.beginAuthorization({
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google",
      redirectUri: REDIRECT_URI,
      ...(reconnectSourceId === undefined ? {} : { reconnectSourceId })
    });
  }

  function callback(
    started: Awaited<ReturnType<typeof beginGoogle>>,
    overrides: Partial<Parameters<typeof oauth.completeAuthorization>[0]> = {}
  ) {
    return {
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google" as const,
      redirectUri: REDIRECT_URI,
      state: stateFromAuthorizationUrl(started.authorizationUrl),
      code: "provider-code",
      stateCookie: started.stateCookie,
      ...overrides
    };
  }

  return {
    callback,
    codec,
    control,
    createOAuth,
    keyring,
    oauth,
    provider,
    replayCache,
    beginGoogle
  };
}

describe("sealed control OAuth", () => {
  it("stores PKCE state only in a sealed ten-minute HttpOnly cookie", async () => {
    const harness = setup();

    const started = await harness.oauth.beginAuthorization({
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google",
      redirectUri: REDIRECT_URI
    });

    expect(started.stateCookie).not.toMatch(/verifier|admin-1|google/);
    expect(started.stateCookie).toContain("oauth_state=");
    expect(started.stateCookie).toContain("HttpOnly");
    expect(started.stateCookie).toContain("Secure");
    expect(started.stateCookie).toContain("SameSite=Lax");
    expect(started.stateCookie).toContain(
      "Expires=Thu, 27 Aug 2026 08:10:00 GMT"
    );
    const claims = harness.codec.openOAuthState(
      sealedCookieValue(started.stateCookie)
    );
    expect(claims).toMatchObject({
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google",
      redirectUri: REDIRECT_URI,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 10 * 60_000
    });
    const rawState = stateFromAuthorizationUrl(started.authorizationUrl);
    expect(claims.stateHash).toBe(
      createHash("sha256").update(rawState).digest("hex")
    );
    expect(harness.provider.beginInputs).toEqual([
      {
        state: rawState,
        redirectUri: REDIRECT_URI,
        codeChallenge: createHash("sha256")
          .update(claims.pkceVerifier)
          .digest("base64url")
      }
    ]);
    expect(harness.control.durable.currentDocument?.pendingDeviceRequests).toEqual(
      {}
    );
    expect(harness.control.durable.writeAttempts).toBe(0);
    expect(harness.control.mirror.writeCount).toBe(0);
  });

  it("rejects replay through the Runtime Cache replay marker", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();

    await harness.oauth.completeAuthorization(harness.callback(started));
    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });

    const stateHash = createHash("sha256")
      .update(stateFromAuthorizationUrl(started.authorizationUrl))
      .digest("hex");
    expect(harness.replayCache.sets).toHaveLength(1);
    expect(harness.replayCache.sets[0]).toMatchObject({
      key: `oauth-used:${stateHash}`,
      options: { ttl: 600 }
    });
    expect(harness.provider.completeInputs).toHaveLength(1);
  });

  it("allows only one concurrent completion to commit the sealed state", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchange = resolve;
    });
    const originalComplete = harness.provider.adapter.completeAuthorization;
    harness.provider.adapter.completeAuthorization = async (input) => {
      await exchangeGate;
      return originalComplete(input);
    };

    const first = harness.oauth.completeAuthorization(harness.callback(started));
    const second = harness.oauth.completeAuthorization(harness.callback(started));
    releaseExchange();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "OAUTH_STATE_INVALID" })
      })
    ]);
    expect(harness.control.durable.writeAttempts).toBe(1);
  });

  it("allows only the Runtime Cache marker owner to complete across service instances", async () => {
    const harness = setup();
    const otherOAuth = harness.createOAuth("source-other");
    const started = await harness.beginGoogle();
    harness.replayCache.synchronizeNextSets = 2;

    const results = await Promise.allSettled([
      harness.oauth.completeAuthorization(harness.callback(started)),
      otherOAuth.completeAuthorization(harness.callback(started))
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: "OAUTH_STATE_INVALID" })
      })
    ]);
    const connectedIds = Object.keys(
      harness.control.durable.currentDocument!.sources
    ).filter((sourceId) => sourceId !== "source-1");
    expect(connectedIds).toHaveLength(1);
    expect(["source-new", "source-other"]).toContain(connectedIds[0]);
  });

  it("rejects cookie, state, and callback binding changes before provider exchange", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();

    for (const overrides of [
      { adminSessionId: "admin-other" },
      { redirectUri: `${REDIRECT_URI}/other` },
      { state: "tampered-state" }
    ]) {
      await expect(
        harness.oauth.completeAuthorization(
          harness.callback(started, overrides)
        )
      ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    }

    expect(harness.provider.completeInputs).toEqual([]);
    expect(harness.replayCache.sets).toEqual([]);
  });

  it("rejects a reconnect source for another provider before authorization begins", async () => {
    const harness = setup();

    await expect(
      harness.oauth.beginAuthorization({
        householdId: "h1",
        adminSessionId: "admin-1",
        provider: "onedrive",
        redirectUri: REDIRECT_URI,
        reconnectSourceId: "source-1"
      })
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    expect(harness.provider.beginInputs).toEqual([]);
  });

  it("rejects a validly sealed state whose lifetime exceeds ten minutes", async () => {
    const harness = setup();
    const rawState = "overlong-state";
    const stateCookie = harness.codec.issueOAuthState({
      version: 2,
      householdId: "h1",
      adminSessionId: "admin-1",
      provider: "google",
      redirectUri: REDIRECT_URI,
      pkceVerifier: "overlong-verifier",
      stateHash: createHash("sha256").update(rawState).digest("hex"),
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 10 * 60_000 + 1
    });

    await expect(
      harness.oauth.completeAuthorization({
        householdId: "h1",
        adminSessionId: "admin-1",
        provider: "google",
        redirectUri: REDIRECT_URI,
        state: rawState,
        code: "provider-code",
        stateCookie
      })
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(harness.provider.completeInputs).toEqual([]);
  });

  it("does not consume state for an invalid provider account or root response", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();
    harness.provider.root = { ...harness.provider.root, parentProviderId: "parent" };

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    expect(harness.replayCache.sets).toEqual([]);

    harness.provider.root = {
      ...harness.provider.root,
      parentProviderId: null
    };
    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).resolves.toEqual({ sourceId: "source-new", status: "connected" });
  });

  it("does not mark an account label invalid for the control document as used", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();
    harness.provider.account = {
      ...harness.provider.account,
      accountLabel: ` ${"x".repeat(120)}`
    };

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    expect(harness.replayCache.sets).toEqual([]);
    expect(harness.control.durable.writeAttempts).toBe(0);
  });

  it("keeps the replay marker when the committed control mutation fails", async () => {
    const harness = setup({ replaceFailures: 1 });
    const started = await harness.beginGoogle();

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });
    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(harness.provider.completeInputs).toHaveLength(1);
    expect(harness.replayCache.sets).toHaveLength(1);
  });

  it("connects a healthy encrypted source without creating a root or sync state", async () => {
    const harness = setup();
    const rootsBefore = structuredClone(
      harness.control.durable.currentDocument?.roots
    );
    const started = await harness.beginGoogle();

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).resolves.toEqual({ sourceId: "source-new", status: "connected" });
    const stored = harness.control.durable.currentDocument?.sources["source-new"];
    expect(stored).toMatchObject({
      id: "source-new",
      provider: "google",
      providerAccountId: "account-new",
      providerRootId: "provider-root-new",
      accountLabel: "new@example.test",
      bootstrapAccessTokenExpiresAt: ACCESS_EXPIRES_AT.toISOString(),
      credentialVersion: 1,
      status: "healthy",
      createdAt: TEST_NOW.toISOString()
    });
    expect(stored).not.toHaveProperty("lastSyncAt");
    expect(stored).not.toHaveProperty("lastSyncErrorCode");
    expect(harness.control.durable.currentDocument?.roots).toEqual(rootsBefore);
    expect(
      decryptProviderToken(stored!.encryptedRefreshToken, harness.keyring.keys)
    ).toBe("refresh-new");
    expect(
      decryptProviderToken(
        stored!.encryptedBootstrapAccessToken!,
        harness.keyring.keys
      )
    ).toBe("bootstrap-access");
  });

  it("requires renewable refresh access for a new source before marking state used", async () => {
    const harness = setup();
    harness.provider.account = {
      ...harness.provider.account,
      credentials: {
        ...harness.provider.account.credentials,
        refreshToken: null
      }
    };
    const started = await harness.beginGoogle();

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    expect(harness.replayCache.sets).toEqual([]);
    expect(harness.control.durable.writeAttempts).toBe(0);
  });

  it("reconnects only the bound identity and retains an omitted refresh token", async () => {
    const harness = setup();
    const original = harness.control.durable.currentDocument!.sources["source-1"];
    harness.provider.account = {
      ...harness.provider.account,
      accountId: original.providerAccountId,
      accountLabel: "renamed@example.test",
      credentials: {
        ...harness.provider.account.credentials,
        refreshToken: null
      }
    };
    harness.provider.root = {
      ...harness.provider.root,
      providerNodeId: original.providerRootId
    };
    const started = await harness.beginGoogle("source-1");

    await harness.oauth.completeAuthorization(harness.callback(started));

    const reconnected =
      harness.control.durable.currentDocument!.sources["source-1"];
    expect(reconnected).toMatchObject({
      providerAccountId: original.providerAccountId,
      providerRootId: original.providerRootId,
      accountLabel: "renamed@example.test",
      credentialVersion: 2,
      status: "healthy"
    });
    expect(reconnected.encryptedRefreshToken).toEqual(
      original.encryptedRefreshToken
    );
    expect(
      decryptProviderToken(
        reconnected.encryptedBootstrapAccessToken!,
        harness.keyring.keys
      )
    ).toBe("bootstrap-access");
  });

  it("does not mark a reconnect used until provider account and root identity match", async () => {
    const harness = setup();
    const original = harness.control.durable.currentDocument!.sources["source-1"];
    const started = await harness.beginGoogle("source-1");

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_ACCOUNT_MISMATCH" });
    expect(harness.replayCache.sets).toEqual([]);

    harness.provider.account = {
      ...harness.provider.account,
      accountId: original.providerAccountId
    };
    harness.provider.root = {
      ...harness.provider.root,
      providerNodeId: original.providerRootId
    };
    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).resolves.toEqual({ sourceId: "source-1", status: "connected" });
  });

  it("normalizes provider failures without exposing tokens or URLs", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();
    harness.provider.completeError = new Error(
      "https://provider.example.test/callback?access_token=private-access"
    );

    const error = await harness.oauth
      .completeAuthorization(harness.callback(started))
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(ControlOAuthServiceError);
    expect(error).toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    expect(String(error)).not.toMatch(/provider\.example|private-access/);
    expect(harness.replayCache.sets).toEqual([]);
  });
});
