import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ProviderAccount,
  ProviderAdapter,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import {
  ControlOAuthServiceError,
  createSqliteOAuthReplayCache,
  createControlOAuthService,
  createSealedSessionCodec,
  decryptProviderToken,
  openLocalDatabase,
  type AuthenticatedControlAdmin,
  type ControlRequestContext
} from "@cloudframe/server";
import type { ControlPlaneStore } from "../packages/server/src/control-plane/store";
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

class InterleavedReplayCache {
  private value: unknown | null = null;
  private initialReads = 0;
  private readonly initialReadGate: Promise<void>;
  private releaseInitialReads!: () => void;
  private markerReads = 0;
  readonly firstMarkerVerified: Promise<void>;
  private releaseFirstMarker!: () => void;

  constructor() {
    this.initialReadGate = new Promise<void>((resolve) => {
      this.releaseInitialReads = resolve;
    });
    this.firstMarkerVerified = new Promise<void>((resolve) => {
      this.releaseFirstMarker = resolve;
    });
  }

  async get(): Promise<unknown | null> {
    if (this.initialReads < 2) {
      this.initialReads += 1;
      if (this.initialReads === 2) this.releaseInitialReads();
      await this.initialReadGate;
      return null;
    }
    this.markerReads += 1;
    const value = this.value;
    if (this.markerReads === 1) this.releaseFirstMarker();
    return value;
  }

  async set(_key: string, value: unknown): Promise<void> {
    this.value = structuredClone(value);
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
      contentRevision: null,
      hasPreview: false
    },
    completeError: null,
    adapter: undefined as unknown as ProviderAdapter
  };
  harness.adapter = {
    async beginAuthorization(input) {
      harness.beginInputs.push(structuredClone(input));
      return {
        authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(input.state)}`
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
  const admin: AuthenticatedControlAdmin = {
    householdId: "h1",
    sessionId: "admin-1",
    adminPassphraseVersion: 1,
    csrfToken: "csrf-token"
  };
  const context = (): ControlRequestContext => {
    const document = structuredClone(control.durable.currentDocument!);
    return { document, revision: document.revision };
  };
  let serviceStoreLoadCount = 0;
  const serviceStore: ControlPlaneStore = {
    async load() {
      serviceStoreLoadCount += 1;
      return control.store.load();
    },
    mutate: (name, reducer) => control.store.mutate(name, reducer)
  };
  let randomByte = 1;
  const createOAuth = (
    sourceId = "source-new",
    store = serviceStore,
    cache: MemoryReplayCache | InterleavedReplayCache = replayCache
  ) =>
    createControlOAuthService({
      store,
      codec,
      providers,
      keyring,
      redirectUris: {
        google: REDIRECT_URI,
        onedrive: "https://app.test/api/admin/sources/onedrive/callback"
      },
      runtimeCache: cache,
      now: () => TEST_NOW,
      createId: () => sourceId,
      randomBytes: (size) => Buffer.alloc(size, randomByte++)
    });
  const oauth = createOAuth();

  async function beginGoogle(reconnectSourceId?: string) {
    return oauth.beginAuthorization({
      admin,
      context: context(),
      provider: "google",
      ...(reconnectSourceId === undefined ? {} : { reconnectSourceId })
    });
  }

  function callback(
    started: Awaited<ReturnType<typeof beginGoogle>>,
    overrides: Partial<Parameters<typeof oauth.completeAuthorization>[0]> = {}
  ) {
    return {
      admin,
      context: context(),
      provider: "google" as const,
      state: stateFromAuthorizationUrl(started.authorizationUrl),
      code: "provider-code",
      stateCookie: started.stateCookie,
      ...overrides
    };
  }

  return {
    admin,
    callback,
    codec,
    control,
    context,
    createOAuth,
    keyring,
    oauth,
    provider,
    replayCache,
    serviceStoreLoadCount: () => serviceStoreLoadCount,
    beginGoogle
  };
}

describe("sealed control OAuth", () => {
  it("preserves safe provider error identity while normalizing OAuth completion", async () => {
    const harness = setup();
    harness.provider.adapter.beginAuthorization = async input => ({
      authorizationUrl: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=${encodeURIComponent(input.state)}`
    });
    const started = await harness.oauth.beginAuthorization({
      admin: harness.admin,
      context: harness.context(),
      provider: "onedrive"
    });
    const providerError = Object.assign(new Error("secret Microsoft response"), {
      name: "ProviderError",
      code: "PROVIDER_BAD_RESPONSE"
    });
    harness.provider.adapter.completeAuthorization = async () => {
      throw providerError;
    };

    const error = await harness.oauth.completeAuthorization({
      admin: harness.admin,
      context: harness.context(),
      provider: "onedrive",
      state: stateFromAuthorizationUrl(started.authorizationUrl),
      stateCookie: started.stateCookie,
      code: "provider-code"
    }).catch(value => value);

    expect(error).toMatchObject({ code: "OAUTH_PROVIDER_ERROR", cause: providerError });
  });

  it("rejects off-provider authorization URLs before returning them", async () => {
    const hostile = [
      "https://evil.test/o/oauth2/v2/auth",
      "https://accounts.google.com:444/o/oauth2/v2/auth",
      "https://user:pass@accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com/o/oauth2/v2/auth#fragment",
      "https://accounts.google.com/o/oauth2/v2/auth/../token"
    ];
    for (const authorizationUrl of hostile) {
      const harness = setup();
      harness.provider.adapter.beginAuthorization = async () => ({ authorizationUrl });
      await expect(harness.beginGoogle()).rejects.toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    }
  });

  it("accepts exactly one safe Microsoft tenant segment", async () => {
    for (const authorizationUrl of [
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=one",
      "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize"
    ]) {
      const harness = setup();
      harness.provider.adapter.beginAuthorization = async () => ({ authorizationUrl });
      await expect(harness.oauth.beginAuthorization({ admin: harness.admin, context: harness.context(), provider: "onedrive" })).resolves.toMatchObject({ authorizationUrl });
    }
    for (const authorizationUrl of [
      "https://login.microsoftonline.com//oauth2/v2.0/authorize",
      "https://login.microsoftonline.com/common/extra/oauth2/v2.0/authorize",
      "https://login.microsoftonline.com/common%2Fevil/oauth2/v2.0/authorize",
      "https://login.microsoftonline.com/../common/oauth2/v2.0/authorize"
    ]) {
      const harness = setup();
      harness.provider.adapter.beginAuthorization = async () => ({ authorizationUrl });
      await expect(harness.oauth.beginAuthorization({ admin: harness.admin, context: harness.context(), provider: "onedrive" })).rejects.toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    }
  });

  it("allows only documented Microsoft tenant forms", async () => {
    for (const tenant of [
      "common",
      "organizations",
      "consumers",
      "01234567-89ab-cdef-0123-456789abcdef",
      "tenant-name.onmicrosoft.com",
      "example.com"
    ]) {
      const harness = setup();
      const authorizationUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`;
      harness.provider.adapter.beginAuthorization = async () => ({ authorizationUrl });
      await expect(harness.oauth.beginAuthorization({ admin: harness.admin, context: harness.context(), provider: "onedrive" })).resolves.toMatchObject({ authorizationUrl });
    }
    for (const tenant of ["common.", "tenant..name", "tenant_name", "tenant~name", "%63ommon", ".", "..", "-tenant", "tenant-"]) {
      const harness = setup();
      harness.provider.adapter.beginAuthorization = async () => ({ authorizationUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize` });
      await expect(harness.oauth.beginAuthorization({ admin: harness.admin, context: harness.context(), provider: "onedrive" })).rejects.toMatchObject({ code: "OAUTH_PROVIDER_ERROR" });
    }
  });

  it("stores PKCE state only in a sealed ten-minute HttpOnly cookie", async () => {
    const harness = setup();

    const started = await harness.oauth.beginAuthorization({
      admin: harness.admin,
      context: harness.context(),
      provider: "google",
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
      sourceId: "source-new",
      expectedControlRevision: 1,
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
    expect(harness.serviceStoreLoadCount()).toBe(0);
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

  it("uses the local mutation boundary when both instances pass the non-atomic replay marker", async () => {
    const harness = setup();
    const interleavedCache = new InterleavedReplayCache();
    let releaseFirstMutation!: () => void;
    let firstMutationStarted!: () => void;
    const firstMutationGate = new Promise<void>((resolve) => {
      releaseFirstMutation = resolve;
    });
    const mutationStarted = new Promise<void>((resolve) => {
      firstMutationStarted = resolve;
    });
    const delayedStore: ControlPlaneStore = {
      load: () => harness.control.store.load(),
      async mutate(name, reducer) {
        firstMutationStarted();
        await firstMutationGate;
        return harness.control.store.mutate(name, reducer);
      }
    };
    const firstOAuth = harness.createOAuth(
      "unused-a",
      delayedStore,
      interleavedCache
    );
    const secondOAuth = harness.createOAuth(
      "unused-b",
      undefined,
      interleavedCache
    );
    const started = await harness.beginGoogle();
    const originalComplete = harness.provider.adapter.completeAuthorization;
    harness.provider.adapter.completeAuthorization = async (input) => {
      if (input.code === "second-code") {
        await interleavedCache.firstMarkerVerified;
      }
      return originalComplete(input);
    };

    const first = firstOAuth.completeAuthorization(
      harness.callback(started, { code: "first-code" })
    );
    const secondPromise = secondOAuth.completeAuthorization(
      harness.callback(started, { code: "second-code" })
    );
    await mutationStarted;
    const second = await secondPromise;
    releaseFirstMutation();

    await expect(first).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(second).toEqual({ sourceId: "source-new", status: "connected" });
    expect(harness.control.durable.writeAttempts).toBe(1);
  });

  it("rejects a new-source replay through local state after its cache marker is lost", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();

    await harness.oauth.completeAuthorization(harness.callback(started));
    harness.replayCache.values.clear();

    await expect(
      harness.createOAuth().completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(harness.control.durable.writeAttempts).toBe(1);
    expect(harness.provider.completeInputs).toHaveLength(1);
  });

  it("cannot recreate a removed source after completion and marker loss", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();

    await harness.oauth.completeAuthorization(harness.callback(started));
    await harness.control.store.mutate("remove-connected-source", (current) => {
      const next = structuredClone(current);
      delete next.sources["source-new"];
      return {
        changed: true,
        next: { ...next, revision: current.revision + 1 },
        result: undefined
      };
    });
    harness.replayCache.values.clear();

    await expect(
      harness.createOAuth().completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(harness.control.durable.currentDocument?.sources["source-new"]).toBeUndefined();
    expect(harness.provider.completeInputs).toHaveLength(1);
  });

  it("invalidates OAuth before provider exchange after any intervening control mutation", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();
    await harness.control.store.mutate("intervening-settings", (current) => ({
      changed: true,
      next: {
        ...current,
        revision: current.revision + 1,
        household: {
          ...current.household,
          allowNewDeviceRequests: !current.household.allowNewDeviceRequests
        }
      },
      result: undefined
    }));

    await expect(
      harness.oauth.completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(harness.provider.completeInputs).toEqual([]);
    expect(harness.replayCache.sets).toEqual([]);
  });

  it("rejects cookie, state, and callback binding changes before provider exchange", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();

    for (const overrides of [
      {
        admin: { ...harness.admin, sessionId: "admin-other" }
      },
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

  it("rejects forged or stale admin context before provider work", async () => {
    const harness = setup();
    const validContext = harness.context();
    const cases = [
      {
        admin: { ...harness.admin, householdId: "other-household" },
        context: validContext
      },
      {
        admin: harness.admin,
        context: { ...validContext, revision: validContext.revision + 1 }
      },
      {
        admin: { ...harness.admin, adminPassphraseVersion: 2 },
        context: validContext
      }
    ];

    for (const invalid of cases) {
      await expect(
        harness.oauth.beginAuthorization({
          ...invalid,
          provider: "google"
        })
      ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    }

    expect(harness.provider.beginInputs).toEqual([]);
    expect(harness.serviceStoreLoadCount()).toBe(0);
  });

  it("derives the redirect URI from trusted configuration", async () => {
    const harness = setup();
    const started = await harness.oauth.beginAuthorization({
      admin: harness.admin,
      context: harness.context(),
      provider: "google",
      redirectUri: "https://attacker.test/callback"
    } as Parameters<typeof harness.oauth.beginAuthorization>[0] & {
      redirectUri: string;
    });

    expect(harness.provider.beginInputs[0].redirectUri).toBe(REDIRECT_URI);
    const claims = harness.codec.openOAuthState(
      sealedCookieValue(started.stateCookie)
    );
    expect(claims.redirectUri).toBe(REDIRECT_URI);
  });

  it("rejects a forged or stale admin callback before provider exchange", async () => {
    const harness = setup();
    const started = await harness.beginGoogle();
    const validContext = harness.context();
    const cases = [
      {
        admin: { ...harness.admin, sessionId: "admin-forged" },
        context: validContext
      },
      {
        admin: harness.admin,
        context: { ...validContext, revision: validContext.revision + 1 }
      },
      {
        admin: { ...harness.admin, adminPassphraseVersion: 2 },
        context: validContext
      }
    ];

    for (const invalid of cases) {
      await expect(
        harness.oauth.completeAuthorization(
          harness.callback(started, invalid)
        )
      ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    }

    expect(harness.provider.completeInputs).toEqual([]);
    expect(harness.serviceStoreLoadCount()).toBe(0);
  });

  it("rejects a reconnect source for another provider before authorization begins", async () => {
    const harness = setup();

    await expect(
      harness.oauth.beginAuthorization({
        admin: harness.admin,
        context: harness.context(),
        provider: "onedrive",
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
      sourceId: "source-new",
      expectedControlRevision: 1,
      pkceVerifier: "overlong-verifier",
      stateHash: createHash("sha256").update(rawState).digest("hex"),
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 10 * 60_000 + 1
    });

    await expect(
      harness.oauth.completeAuthorization({
        admin: harness.admin,
        context: harness.context(),
        provider: "google",
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
    const claims = harness.codec.openOAuthState(
      sealedCookieValue(started.stateCookie)
    );
    expect(claims).toMatchObject({
      sourceId: "source-1",
      expectedControlRevision: 1,
      reconnectSourceId: "source-1",
      expectedCredentialVersion: 1
    });

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

  it("rejects reconnect replay through credential-version CAS after marker loss", async () => {
    const harness = setup();
    const original = harness.control.durable.currentDocument!.sources["source-1"];
    harness.provider.account = {
      ...harness.provider.account,
      accountId: original.providerAccountId
    };
    harness.provider.root = {
      ...harness.provider.root,
      providerNodeId: original.providerRootId
    };
    const started = await harness.beginGoogle("source-1");

    await harness.oauth.completeAuthorization(harness.callback(started));
    harness.replayCache.values.clear();

    await expect(
      harness.createOAuth().completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(
      harness.control.durable.currentDocument!.sources["source-1"]
        .credentialVersion
    ).toBe(2);
    expect(harness.control.durable.writeAttempts).toBe(1);
    expect(harness.provider.completeInputs).toHaveLength(1);
  });

  it("normalizes a reconnect target removed after begin as invalid state", async () => {
    const harness = setup();
    const started = await harness.beginGoogle("source-1");
    const changed = structuredClone(harness.control.durable.currentDocument!);
    delete changed.sources["source-1"];
    delete changed.roots["root-1"];
    changed.devices["device-1"].assignedRootIds = [];
    changed.revision += 1;
    harness.control.durable.replaceOutOfBand(changed);

    await expect(
      harness.createOAuth().completeAuthorization(harness.callback(started))
    ).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
    expect(harness.provider.completeInputs).toEqual([]);
    expect(harness.replayCache.sets).toEqual([]);
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

describe("SQLite OAuth replay cache", () => {
  it("persists replay ownership across database reopen and deletes it after expiry", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-oauth-replay-"));
    let clock = TEST_NOW.getTime();
    try {
      const first = await openLocalDatabase({ dataDir, now: () => new Date(clock) });
      await createSqliteOAuthReplayCache(first.connection, () => new Date(clock))
        .set("oauth-used:state", "owner-1", { ttl: 2 });
      first.close();

      const second = await openLocalDatabase({ dataDir, now: () => new Date(clock) });
      const cache = createSqliteOAuthReplayCache(
        second.connection,
        () => new Date(clock),
      );
      expect(await cache.get("oauth-used:state")).toBe("owner-1");

      clock += 2_001;
      expect(await cache.get("oauth-used:state")).toBeNull();
      expect(second.connection.prepare(
        "SELECT COUNT(*) AS count FROM oauth_replay",
      ).get()).toEqual({ count: 0 });
      second.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
