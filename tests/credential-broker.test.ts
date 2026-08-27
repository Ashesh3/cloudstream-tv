import type {
  ProviderAdapter,
  ProviderRegistry,
  Source as ProviderSource,
} from "@cloudframe/providers";
import { ProviderError, createGoogleDriveAdapter } from "@cloudframe/providers";
import type {
  ControlPlaneDocumentV2,
  ControlPlaneSource,
} from "@cloudframe/shared";
import {
  CredentialBrokerError,
  controlStoreHarness,
  createCredentialBroker,
  decryptProviderToken,
  encryptProviderToken,
  type ControlMutationReducer,
  type ControlPlaneStore,
  type CredentialRuntimeCache,
  type ProviderTokenKeyring,
} from "@cloudframe/server";
import { describe, expect, it } from "vitest";

import { TEST_NOW, testControlDocument } from "./helpers/control-plane";

const providerTokenKeyring: ProviderTokenKeyring = {
  currentVersion: "v1",
  keys: { v1: Buffer.alloc(32, 11) },
};

class MemoryCredentialCache implements CredentialRuntimeCache {
  readonly values = new Map<string, unknown>();
  readonly sets: Array<{
    key: string;
    value: unknown;
    options: { ttl?: number; tags?: string[]; name?: string } | undefined;
  }> = [];
  getFailures = 0;
  setFailures = 0;
  ignoredSets = 0;
  deleteFailures = 0;
  readonly deletes: string[] = [];

  async get(key: string): Promise<unknown | null> {
    if (this.getFailures > 0) {
      this.getFailures -= 1;
      throw new Error("Injected cache get failure");
    }
    return structuredClone(this.values.get(key) ?? null);
  }

  async set(
    key: string,
    value: unknown,
    options?: { ttl?: number; tags?: string[]; name?: string },
  ): Promise<void> {
    this.sets.push({ key, value: structuredClone(value), options });
    if (this.ignoredSets > 0) {
      this.ignoredSets -= 1;
      return;
    }
    this.values.set(key, structuredClone(value));
    if (this.setFailures > 0) {
      this.setFailures -= 1;
      throw new Error("Injected cache set failure after acceptance");
    }
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.deleteFailures > 0) {
      this.deleteFailures -= 1;
      throw new Error("Injected cache delete failure");
    }
    this.values.delete(key);
  }
}

class RefreshProvider {
  refreshCalls = 0;
  refreshToken: string | null = "refresh-token";
  accessToken = "fresh-access";
  expiresAt = new Date(TEST_NOW.getTime() + 3_661_000);
  error: unknown;
  pending: Promise<void> | null = null;
  readonly inputs: ProviderSource[] = [];

  readonly adapter: ProviderAdapter = {
    beginAuthorization: async () => unexpected("beginAuthorization"),
    completeAuthorization: async () => unexpected("completeAuthorization"),
    refreshCredentials: async (source) => {
      this.refreshCalls += 1;
      this.inputs.push(structuredClone(source));
      if (this.pending) await this.pending;
      if (this.error) throw this.error;
      return {
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        accessTokenExpiresAt: new Date(this.expiresAt),
      };
    },
    getRoot: async () => unexpected("getRoot"),
    getNode: async () => unexpected("getNode"),
    listFolder: async () => unexpected("listFolder"),
    getThumbnailUrl: async () => unexpected("getThumbnailUrl"),
    getMediaUrl: async () => unexpected("getMediaUrl"),
  };
}

function unexpected(operation: string): never {
  throw new Error(`Unexpected provider operation: ${operation}`);
}

function sourceWithCredentials(
  overrides: Partial<ControlPlaneSource> = {},
): ControlPlaneSource {
  return {
    ...testControlDocument().sources["source-1"],
    encryptedRefreshToken: encryptProviderToken(
      "refresh-token",
      providerTokenKeyring,
    ),
    encryptedBootstrapAccessToken: null,
    bootstrapAccessTokenExpiresAt: null,
    ...overrides,
  };
}

function documentWithSource(
  source: ControlPlaneSource = sourceWithCredentials(),
): ControlPlaneDocumentV2 {
  const document = testControlDocument();
  return { ...document, sources: { [source.id]: source } };
}

function createHarness(
  options: {
    document?: ControlPlaneDocumentV2;
    cache?: MemoryCredentialCache;
    provider?: RefreshProvider;
    store?: ControlPlaneStore;
  } = {},
) {
  let activeDocument = options.document ?? documentWithSource();
  const control = controlStoreHarness(activeDocument);
  const cache = options.cache ?? new MemoryCredentialCache();
  const provider = options.provider ?? new RefreshProvider();
  let loadCount = 0;
  let mutationCount = 0;
  const baseStore = options.store ?? control.store;
  const store: ControlPlaneStore = {
    async load() {
      loadCount += 1;
      return baseStore.load();
    },
    async mutate<T>(name: string, reducer: ControlMutationReducer<T>) {
      mutationCount += 1;
      return baseStore.mutate(name, reducer);
    },
  };
  const providers: ProviderRegistry = { get: () => provider.adapter };
  const broker = createCredentialBroker({
    controlStore: store,
    controlState: () => ({
      document: activeDocument,
      revision: activeDocument.revision,
    }),
    cache,
    providers,
    providerTokenKeyring,
    now: () => new Date(TEST_NOW),
  });

  return {
    broker,
    cache,
    control,
    provider,
    get loadCount() {
      return loadCount;
    },
    get mutationCount() {
      return mutationCount;
    },
    setActiveDocument(document: ControlPlaneDocumentV2) {
      activeDocument = document;
    },
  };
}

function cachedAccess(
  accessToken: string,
  expiresAt = new Date(TEST_NOW.getTime() + 30 * 60_000),
) {
  return {
    encryptedAccessToken: encryptProviderToken(
      accessToken,
      providerTokenKeyring,
    ),
    accessTokenExpiresAt: expiresAt.toISOString(),
  };
}

describe("credential broker", () => {
  it("returns an encrypted Runtime Cache hit without loading or mutating control state", async () => {
    const harness = createHarness();
    const key = "source:source-1:credentials:1";
    harness.cache.values.set(key, cachedAccess("cached-access"));

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials).toEqual({
      accessToken: "cached-access",
      refreshToken: null,
      accessTokenExpiresAt: new Date(TEST_NOW.getTime() + 30 * 60_000),
    });
    expect(harness.provider.refreshCalls).toBe(0);
    expect(harness.loadCount).toBe(0);
    expect(harness.mutationCount).toBe(0);
    expect(harness.control.mirror.writeCount).toBe(0);
  });

  it("rejects an empty decrypted cache token and refreshes instead", async () => {
    const harness = createHarness();
    harness.cache.values.set("source:source-1:credentials:1", cachedAccess(""));

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("fresh-access");
    expect(harness.provider.refreshCalls).toBe(1);
  });

  it("uses a still-valid bootstrap token and caches only encrypted access credentials", async () => {
    const expiresAt = new Date(TEST_NOW.getTime() + 3_661_000);
    const source = sourceWithCredentials({
      encryptedBootstrapAccessToken: encryptProviderToken(
        "bootstrap-access",
        providerTokenKeyring,
      ),
      bootstrapAccessTokenExpiresAt: expiresAt.toISOString(),
    });
    const harness = createHarness({ document: documentWithSource(source) });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("bootstrap-access");
    expect(credentials.refreshToken).toBeNull();
    expect(harness.provider.refreshCalls).toBe(0);
    expect(harness.cache.sets).toHaveLength(1);
    expect(harness.cache.sets[0]).toMatchObject({
      key: "source:source-1:credentials:1",
      options: { ttl: 3_601 },
    });
    expect(Object.keys(harness.cache.sets[0].value as object).sort()).toEqual([
      "accessTokenExpiresAt",
      "encryptedAccessToken",
    ]);
    expect(JSON.stringify(harness.cache.sets[0].value)).not.toContain(
      "bootstrap-access",
    );
  });

  it("refreshes an expired access token without loading or mutating control state", async () => {
    const harness = createHarness();

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("fresh-access");
    expect(credentials.refreshToken).toBeNull();
    expect(harness.provider.refreshCalls).toBe(1);
    expect(harness.provider.inputs[0].credentials).toEqual({
      accessToken: "",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: new Date(0),
    });
    expect(harness.loadCount).toBe(0);
    expect(harness.mutationCount).toBe(0);
    expect(harness.control.durable.readCount).toBe(0);
    expect(harness.control.mirror.writeCount).toBe(0);
    expect(JSON.stringify(harness.cache.sets[0].value)).not.toContain(
      "refresh-token",
    );
  });

  it("lets downstream callers force one access refresh after a provider rejection", async () => {
    const harness = createHarness();
    harness.cache.values.set(
      "source:source-1:credentials:1",
      cachedAccess("provider-rejected-access"),
    );

    const credentials = await harness.broker.refresh("source-1", "h1");

    expect(credentials.accessToken).toBe("fresh-access");
    expect(harness.provider.refreshCalls).toBe(1);
    expect(harness.mutationCount).toBe(0);
  });

  it("deduplicates concurrent refreshes within one process", async () => {
    let release!: () => void;
    const provider = new RefreshProvider();
    provider.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({ provider });

    const first = harness.broker.get("source-1", "h1");
    const second = harness.broker.get("source-1", "h1");
    while (provider.refreshCalls === 0) await Promise.resolve();
    expect(provider.refreshCalls).toBe(1);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ accessToken: "fresh-access" }),
      expect.objectContaining({ accessToken: "fresh-access" }),
    ]);
    expect(provider.refreshCalls).toBe(1);
  });

  it("persists exactly one control mutation when the provider rotates the refresh token", async () => {
    const harness = createHarness();
    harness.provider.refreshToken = "rotated-refresh";

    const credentials = await harness.broker.get("source-1", "h1");
    await harness.control.deferred.flush();

    expect(credentials.accessToken).toBe("fresh-access");
    expect(harness.mutationCount).toBe(1);
    expect(
      harness.control.durable.currentDocument?.sources["source-1"],
    ).toMatchObject({ credentialVersion: 2 });
    expect(
      decryptProviderToken(
        harness.control.durable.currentDocument!.sources["source-1"]
          .encryptedRefreshToken,
        providerTokenKeyring.keys,
      ),
    ).toBe("rotated-refresh");
    expect(harness.control.mirror.writeCount).toBe(1);
    expect(harness.cache.sets.at(-1)?.key).toBe(
      "source:source-1:credentials:2",
    );
  });

  it("uses a concurrent rotation winner instead of overwriting it", async () => {
    const initial = documentWithSource();
    const winningSource = sourceWithCredentials({
      encryptedRefreshToken: encryptProviderToken(
        "winning-refresh",
        providerTokenKeyring,
      ),
      credentialVersion: 2,
    });
    const winningDocument = {
      ...initial,
      revision: 2,
      sources: { "source-1": winningSource },
    };
    let mutateCalls = 0;
    const concurrentStore: ControlPlaneStore = {
      async load() {
        throw new Error("Routine broker path must not load control state");
      },
      async mutate<T>(_name: string, reducer: ControlMutationReducer<T>) {
        mutateCalls += 1;
        return reducer(winningDocument).result;
      },
    };
    const cache = new MemoryCredentialCache();
    cache.values.set(
      "source:source-1:credentials:2",
      cachedAccess("winning-access"),
    );
    const provider = new RefreshProvider();
    provider.refreshToken = "losing-refresh";
    provider.accessToken = "losing-access";
    const harness = createHarness({
      document: initial,
      cache,
      provider,
      store: concurrentStore,
    });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("winning-access");
    expect(provider.refreshCalls).toBe(1);
    expect(mutateCalls).toBe(1);
    expect(cache.sets.some((entry) => entry.key.endsWith(":1"))).toBe(false);
    const winningCache = cache.values.get(
      "source:source-1:credentials:2",
    ) as ReturnType<typeof cachedAccess>;
    expect(
      decryptProviderToken(
        winningCache.encryptedAccessToken,
        providerTokenKeyring.keys,
      ),
    ).toBe("winning-access");
  });

  it("refreshes with a concurrent rotation winner when its cache entry is absent", async () => {
    const initial = documentWithSource();
    const winningSource = sourceWithCredentials({
      encryptedRefreshToken: encryptProviderToken(
        "winning-refresh",
        providerTokenKeyring,
      ),
      credentialVersion: 2,
    });
    const winningDocument = {
      ...initial,
      revision: 2,
      sources: { "source-1": winningSource },
    };
    let mutateCalls = 0;
    const store: ControlPlaneStore = {
      async load() {
        throw new Error("Routine broker path must not load control state");
      },
      async mutate<T>(_name: string, reducer: ControlMutationReducer<T>) {
        mutateCalls += 1;
        return reducer(winningDocument).result;
      },
    };
    const cache = new MemoryCredentialCache();
    const provider = new RefreshProvider();
    provider.adapter.refreshCredentials = async (source) => {
      provider.refreshCalls += 1;
      provider.inputs.push(structuredClone(source));
      if (source.credentials.refreshToken === "refresh-token") {
        return {
          accessToken: "losing-access",
          refreshToken: "losing-refresh",
          accessTokenExpiresAt: new Date(provider.expiresAt),
        };
      }
      return {
        accessToken: "winning-access",
        refreshToken: "winning-refresh",
        accessTokenExpiresAt: new Date(provider.expiresAt),
      };
    };
    const harness = createHarness({
      document: initial,
      cache,
      provider,
      store,
    });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("winning-access");
    expect(provider.refreshCalls).toBe(2);
    expect(mutateCalls).toBe(1);
    expect(cache.sets.at(-1)?.key).toBe("source:source-1:credentials:2");
    expect(
      provider.inputs.map((input) => input.credentials.refreshToken),
    ).toEqual(["refresh-token", "winning-refresh"]);
  });

  it("marks a source reauthorization-required after a definitive invalid grant", async () => {
    const harness = createHarness();
    harness.provider.error = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "safe",
      { retryable: false, reauthReason: "invalid_grant" },
    );

    await expect(harness.broker.get("source-1", "h1")).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
    });
    await harness.control.deferred.flush();

    expect(harness.mutationCount).toBe(1);
    expect(
      harness.control.durable.currentDocument?.sources["source-1"].status,
    ).toBe("reauth-required");
    expect(harness.control.mirror.writeCount).toBe(1);
  });

  it("does not persist reauthorization for a same-code error without definitive invalid grant", async () => {
    const harness = createHarness();
    harness.provider.error = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "safe",
      { retryable: false },
    );

    await expect(harness.broker.get("source-1", "h1")).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      reauthReason: null,
    });

    expect(harness.mutationCount).toBe(0);
    expect(harness.control.mirror.writeCount).toBe(0);
    expect(
      harness.control.durable.currentDocument?.sources["source-1"].status,
    ).toBe("healthy");
  });

  it("does not persist reauthorization for a generic provider HTTP 401", async () => {
    const provider = new RefreshProvider();
    provider.adapter.refreshCredentials = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { message: "synthetic private upstream payload" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
      now: () => new Date(TEST_NOW),
    }).refreshCredentials;
    const harness = createHarness({ provider });

    const error = await harness.broker
      .get("source-1", "h1")
      .catch((value) => value);

    expect(error).toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      reauthReason: null,
    });
    expect(String(error)).not.toContain("private upstream payload");
    expect(harness.mutationCount).toBe(0);
    expect(harness.control.mirror.writeCount).toBe(0);
    expect(
      harness.control.durable.currentDocument?.sources["source-1"].status,
    ).toBe("healthy");
  });

  it("uses a concurrent credential winner when an invalid grant loses the condition", async () => {
    const initial = documentWithSource();
    const winningSource = sourceWithCredentials({
      encryptedRefreshToken: encryptProviderToken(
        "winning-refresh",
        providerTokenKeyring,
      ),
      credentialVersion: 2,
    });
    const winningDocument = {
      ...initial,
      revision: 2,
      sources: { "source-1": winningSource },
    };
    const store: ControlPlaneStore = {
      async load() {
        throw new Error("Routine broker path must not load control state");
      },
      async mutate<T>(_name: string, reducer: ControlMutationReducer<T>) {
        return reducer(winningDocument).result;
      },
    };
    const cache = new MemoryCredentialCache();
    cache.values.set(
      "source:source-1:credentials:2",
      cachedAccess("winning-access"),
    );
    const provider = new RefreshProvider();
    provider.error = new ProviderError("PROVIDER_REAUTH_REQUIRED", "safe", {
      retryable: false,
      reauthReason: "invalid_grant",
    });
    const harness = createHarness({
      document: initial,
      cache,
      provider,
      store,
    });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("winning-access");
    expect(provider.refreshCalls).toBe(1);
  });

  it("refreshes once with the concurrent winner when an invalid grant loses and no cache entry exists", async () => {
    const initial = documentWithSource();
    const winningSource = sourceWithCredentials({
      encryptedRefreshToken: encryptProviderToken(
        "winning-refresh",
        providerTokenKeyring,
      ),
      credentialVersion: 2,
    });
    const winningDocument = {
      ...initial,
      revision: 2,
      sources: { "source-1": winningSource },
    };
    const store: ControlPlaneStore = {
      async load() {
        throw new Error("Routine broker path must not load control state");
      },
      async mutate<T>(_name: string, reducer: ControlMutationReducer<T>) {
        return reducer(winningDocument).result;
      },
    };
    const provider = new RefreshProvider();
    provider.error = new ProviderError("PROVIDER_REAUTH_REQUIRED", "safe", {
      retryable: false,
      reauthReason: "invalid_grant",
    });
    provider.adapter.refreshCredentials = async (source) => {
      provider.refreshCalls += 1;
      provider.inputs.push(structuredClone(source));
      if (source.credentials.refreshToken === "refresh-token") {
        throw provider.error;
      }
      return {
        accessToken: "winning-access",
        refreshToken: "winning-refresh",
        accessTokenExpiresAt: new Date(provider.expiresAt),
      };
    };
    const harness = createHarness({ document: initial, provider, store });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("winning-access");
    expect(provider.refreshCalls).toBe(2);
    expect(
      provider.inputs.map((input) => input.credentials.refreshToken),
    ).toEqual(["refresh-token", "winning-refresh"]);
  });

  it("does not mutate control state for transient provider failures", async () => {
    const harness = createHarness();
    harness.provider.error = new ProviderError("PROVIDER_UNAVAILABLE", "safe", {
      retryable: true,
    });

    await expect(harness.broker.get("source-1", "h1")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });

    expect(harness.mutationCount).toBe(0);
    expect(harness.control.mirror.writeCount).toBe(0);
  });

  it("rejects a provider refresh response whose access token is already expired", async () => {
    const provider = new RefreshProvider();
    provider.expiresAt = new Date(TEST_NOW.getTime() - 1);
    const harness = createHarness({ provider });

    await expect(harness.broker.get("source-1", "h1")).rejects.toMatchObject({
      code: "PROVIDER_BAD_RESPONSE",
    });
    expect(provider.refreshCalls).toBe(1);
    expect(harness.cache.sets).toHaveLength(0);
    expect(harness.mutationCount).toBe(0);
  });

  it.each([
    ["missing", documentWithSource(), "unknown", "h1"],
    ["household mismatch", documentWithSource(), "source-1", "other"],
    [
      "disabled",
      documentWithSource(sourceWithCredentials({ status: "disabled" })),
      "source-1",
      "h1",
    ],
  ])(
    "fails closed for a %s source",
    async (_case, document, sourceId, householdId) => {
      const harness = createHarness({ document });

      await expect(harness.broker.get(sourceId, householdId)).rejects.toEqual(
        new CredentialBrokerError("SOURCE_NOT_FOUND"),
      );
      expect(harness.provider.refreshCalls).toBe(0);
      expect(harness.loadCount).toBe(0);
      expect(harness.mutationCount).toBe(0);
    },
  );

  it("rejects a source already requiring reauthorization without refreshing", async () => {
    const harness = createHarness({
      document: documentWithSource(
        sourceWithCredentials({ status: "reauth-required" }),
      ),
    });

    await expect(harness.broker.get("source-1", "h1")).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
    });
    expect(harness.provider.refreshCalls).toBe(0);
    expect(harness.mutationCount).toBe(0);
  });

  it("treats cache failures as misses without exposing secrets or weakening source checks", async () => {
    const cache = new MemoryCredentialCache();
    cache.getFailures = 1;
    cache.setFailures = 1;
    const harness = createHarness({ cache });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: null,
    });
    expect(harness.provider.refreshCalls).toBe(1);
    expect(JSON.stringify(cache.sets)).not.toContain("refresh-token");
    expect(JSON.stringify(cache.sets)).not.toContain("fresh-access");

    await expect(harness.broker.get("missing", "h1")).rejects.toMatchObject({
      code: "SOURCE_NOT_FOUND",
    });
  });

  it("verifies a swallowed Runtime Cache write and deletes an unverified entry", async () => {
    const cache = new MemoryCredentialCache();
    cache.ignoredSets = 1;
    const harness = createHarness({ cache });

    const credentials = await harness.broker.get("source-1", "h1");

    expect(credentials.accessToken).toBe("fresh-access");
    expect(cache.deletes).toContain("source:source-1:credentials:1");
    expect(cache.values.size).toBe(0);
  });

  it("clamps credential cache TTL to one second", async () => {
    const provider = new RefreshProvider();
    provider.expiresAt = new Date(TEST_NOW.getTime() + 30_000);
    const harness = createHarness({ provider });

    await harness.broker.get("source-1", "h1");

    expect(harness.cache.sets[0].options?.ttl).toBe(1);
  });
});
