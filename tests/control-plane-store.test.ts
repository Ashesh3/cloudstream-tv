import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createControlPlaneStore,
  encryptControlPlaneDocument
} from "@cloudframe/server";
import { BlobPreconditionFailedError } from "@vercel/blob";
import {
  createMemoryControlHotCache,
  MemoryControlDurableStore,
  MemoryDeferredTasks,
  MemoryRecoveryMirror,
  controlStoreHarness
} from "../packages/server/src/control-plane/memory";
import {
  createVercelBlobControlStore
} from "../packages/server/src/control-plane/vercel-blob";
import {
  createVercelRuntimeControlCache
} from "../packages/server/src/control-plane/runtime-cache";
import { testAeadKeyring, testControlDocument, testDocumentAtRevision } from "./helpers/control-plane";

const blobSdk = vi.hoisted(() => ({
  get: vi.fn(),
  head: vi.fn(),
  put: vi.fn()
}));

const runtimeCacheSdk = vi.hoisted(() => ({
  getCache: vi.fn()
}));

vi.mock("@vercel/blob", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vercel/blob")>();
  return { ...original, get: blobSdk.get, head: blobSdk.head, put: blobSdk.put };
});

vi.mock("@vercel/functions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vercel/functions")>();
  return { ...original, getCache: runtimeCacheSdk.getCache };
});

describe("control-plane store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T09:30:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads Blob on a Runtime Cache miss and never asks the mirror to read", async () => {
    const harness = controlStoreHarness(testControlDocument());
    await harness.cache.delete(harness.cacheKey);

    const loaded = await harness.store.load();

    expect(loaded.document.revision).toBe(1);
    expect(harness.durable.readCount).toBe(1);
    expect(harness.mirror.writeCount).toBe(0);
    expect("read" in harness.mirror).toBe(false);
  });

  it("conditionally revalidates a cached snapshot and replaces stale state", async () => {
    const harness = controlStoreHarness(testControlDocument());
    await harness.store.load();
    const cachedEtag = harness.cache.currentEtag;
    harness.durable.replaceOutOfBand(testDocumentAtRevision(2));

    const loaded = await harness.store.load();

    expect(harness.durable.lastIfNoneMatch).toBe(cachedEtag);
    expect(loaded.document.revision).toBe(2);
    expect(harness.cache.currentRevision).toBe(2);
  });

  it("deletes a corrupt cache entry and retries one complete Blob read", async () => {
    const harness = controlStoreHarness(testControlDocument());
    harness.cache.replaceOutOfBand({
      envelope: { broken: "ciphertext" },
      etag: harness.cache.currentEtag
    });

    const loaded = await harness.store.load();

    expect(loaded.document.revision).toBe(1);
    expect(harness.durable.ifNoneMatches).toEqual([harness.durable.currentEtag, undefined]);
    expect(harness.cache.deleteCount).toBe(1);
  });

  it("does not retry a corrupt fresh Blob body", async () => {
    const harness = controlStoreHarness(testControlDocument());
    harness.durable.replaceOutOfBand(testDocumentAtRevision(2));
    harness.durable.corruptOutOfBand();

    await expect(harness.store.load()).rejects.toMatchObject({
      code: "CONTROL_PLANE_UNAVAILABLE"
    });

    expect(harness.durable.ifNoneMatches).toEqual(["etag-1"]);
    expect(harness.cache.deleteCount).toBe(0);
  });

  it("fails closed when the authoritative Blob snapshot is absent or corrupt", async () => {
    const missing = controlStoreHarness(testControlDocument());
    await missing.cache.delete();
    missing.durable.removeOutOfBand();
    const corrupt = controlStoreHarness(testControlDocument());
    await corrupt.cache.delete();
    corrupt.durable.corruptOutOfBand();

    await expect(missing.store.load()).rejects.toMatchObject({
      code: "CONTROL_PLANE_UNAVAILABLE"
    });
    await expect(corrupt.store.load()).rejects.toMatchObject({
      code: "CONTROL_PLANE_UNAVAILABLE"
    });
  });

  it("returns a validated clone rather than retaining caller state", async () => {
    const harness = controlStoreHarness(testControlDocument());
    const first = await harness.store.load();
    first.document.devices["device-1"].name = "Caller mutation";

    const second = await harness.store.load();

    expect(second.document.devices["device-1"].name).toBe("Living Room");
  });

  it("retries a stale ETag three times without overwriting concurrent work", async () => {
    const harness = controlStoreHarness(testControlDocument(), { conflicts: 3 });

    await expect(harness.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: true
    }))).rejects.toMatchObject({ code: "CONTROL_PLANE_CONFLICT" });

    expect(harness.durable.writeAttempts).toBe(3);
    expect(harness.durable.currentRevision).toBe(1);
    expect(harness.durable.ifNoneMatches).toEqual([harness.cache.currentEtag, undefined, undefined]);
  });

  it("re-runs the reducer against a fresh Blob snapshot after a conflict", async () => {
    const harness = controlStoreHarness(testControlDocument(), { conflicts: 1 });
    const cachedEtag = harness.cache.currentEtag;
    const seenRevisions: number[] = [];

    const result = await harness.store.mutate("settings", current => {
      seenRevisions.push(current.revision);
      return {
        changed: true,
        next: { ...current, revision: current.revision + 1 },
        result: current.revision
      };
    });

    expect(result).toBe(1);
    expect(seenRevisions).toEqual([1, 1]);
    expect(harness.durable.ifNoneMatches).toEqual([cachedEtag, undefined]);
    expect(harness.durable.currentRevision).toBe(2);
  });

  it("sets updatedAt once across CAS attempts and requires exactly one revision increment", async () => {
    const harness = controlStoreHarness(testControlDocument(), { conflicts: 1 });
    const timestamps: string[] = [];

    await harness.store.mutate("settings", current => {
      timestamps.push(new Date().toISOString());
      vi.setSystemTime(new Date("2026-08-27T10:00:00.000Z"));
      return {
        changed: true,
        next: { ...current, revision: current.revision + 1, updatedAt: "ignored" },
        result: undefined
      };
    });

    expect(timestamps).toEqual([
      "2026-08-27T09:30:00.000Z",
      "2026-08-27T10:00:00.000Z"
    ]);
    expect(harness.durable.currentDocument?.updatedAt).toBe("2026-08-27T09:30:00.000Z");

    await expect(harness.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 2 },
      result: undefined
    }))).rejects.toMatchObject({ code: "CONTROL_PLANE_INVALID" });
  });

  it("normalizes durable failures before the Blob commit to unavailable", async () => {
    const harness = controlStoreHarness(testControlDocument(), { replaceFailures: 1 });

    await expect(harness.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: undefined
    }))).rejects.toMatchObject({ code: "CONTROL_PLANE_UNAVAILABLE" });

    expect(harness.durable.currentRevision).toBe(1);
  });

  it("does not persist or mirror an unchanged mutation", async () => {
    const harness = controlStoreHarness(testControlDocument());

    const result = await harness.store.mutate("settings", current => ({
      changed: false,
      next: current,
      result: "unchanged"
    }));
    await harness.deferred.flush();

    expect(result).toBe("unchanged");
    expect(harness.durable.writeAttempts).toBe(0);
    expect(harness.cache.setCount).toBe(0);
    expect(harness.mirror.writeCount).toBe(0);
  });

  it("does not populate or delete cache for an unchanged cold mutation", async () => {
    const harness = controlStoreHarness(testControlDocument());
    await harness.cache.delete();
    const deletesBefore = harness.cache.deleteCount;

    const result = await harness.store.mutate("settings", current => ({
      changed: false,
      next: current,
      result: "unchanged"
    }));

    expect(result).toBe("unchanged");
    expect(harness.durable.readCount).toBe(1);
    expect(harness.cache.setCount).toBe(0);
    expect(harness.cache.deleteCount).toBe(deletesBefore);
    expect(harness.mirror.writeCount).toBe(0);
  });

  it("does not replace stale cache for an unchanged mutation", async () => {
    const harness = controlStoreHarness(testControlDocument());
    harness.durable.replaceOutOfBand(testDocumentAtRevision(2));

    const result = await harness.store.mutate("settings", current => ({
      changed: false,
      next: current,
      result: current.revision
    }));

    expect(result).toBe(2);
    expect(harness.cache.currentRevision).toBe(1);
    expect(harness.cache.setCount).toBe(0);
    expect(harness.cache.deleteCount).toBe(0);
    expect(harness.mirror.writeCount).toBe(0);
  });

  it("does not delete corrupt cache for an unchanged mutation after a fresh validation read", async () => {
    const harness = controlStoreHarness(testControlDocument());
    harness.cache.replaceOutOfBand({
      envelope: { broken: "ciphertext" },
      etag: harness.cache.currentEtag
    });

    const result = await harness.store.mutate("settings", current => ({
      changed: false,
      next: current,
      result: current.revision
    }));

    expect(result).toBe(1);
    expect(harness.durable.ifNoneMatches).toEqual([harness.durable.currentEtag, undefined]);
    expect(harness.cache.setCount).toBe(0);
    expect(harness.cache.deleteCount).toBe(0);
    expect(harness.mirror.writeCount).toBe(0);
  });

  it("rejects a changed mutation that retains the current revision", async () => {
    const harness = controlStoreHarness(testControlDocument());

    await expect(harness.store.mutate("settings", current => ({
      changed: true,
      next: current,
      result: undefined
    }))).rejects.toMatchObject({ code: "CONTROL_PLANE_INVALID" });

    expect(harness.durable.writeAttempts).toBe(0);
  });

  it("commits Blob, verifies the cache revision, and defers one full mirror write", async () => {
    const harness = controlStoreHarness(testControlDocument());

    const result = await harness.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: "saved"
    }));
    await harness.deferred.flush();

    expect(result).toBe("saved");
    expect(harness.cache.currentRevision).toBe(2);
    expect(harness.cache.lastTtlSeconds).toBe(300);
    expect(harness.mirror.writeCount).toBe(1);
    expect(harness.mirror.lastDocument?.revision).toBe(2);
    await expect(harness.cache.getMirrorStatus()).resolves.toEqual({
      status: "current",
      revision: 2
    });
  });

  it("keeps a committed Blob mutation when cache replacement fails", async () => {
    const harness = controlStoreHarness(testControlDocument(), { cacheSetFailures: 1 });

    await expect(harness.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: "committed"
    }))).resolves.toBe("committed");

    expect(harness.durable.currentRevision).toBe(2);
    expect(harness.cache.deleteCount).toBe(1);
  });

  it("keeps a committed Blob mutation when cache cleanup is unverifiable", async () => {
    const keyring = testAeadKeyring();
    const initial = {
      envelope: encryptControlPlaneDocument(testControlDocument(), keyring),
      etag: "etag-1"
    };
    const durable = new MemoryControlDurableStore(initial, 0, keyring.keys);
    const cache = {
      get: vi.fn(async () => structuredClone(initial)),
      set: vi.fn(async () => { throw new Error("cache write failed"); }),
      delete: vi.fn(async () => "unverifiable" as const),
      getMirrorStatus: vi.fn(async () => ({ status: "current" as const, revision: null })),
      setMirrorStatus: vi.fn(async () => undefined)
    };
    const mirror = new MemoryRecoveryMirror();
    const deferred = new MemoryDeferredTasks();
    const store = createControlPlaneStore({ durable, cache, mirror, deferred, keyring });

    await expect(store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: "committed"
    }))).resolves.toBe("committed");

    expect(durable.currentRevision).toBe(2);
    expect(cache.delete).toHaveBeenCalledOnce();
  });

  it("retries a deferred mirror write three times and marks recovery delayed", async () => {
    const harness = controlStoreHarness(testControlDocument(), { mirrorFailures: 3 });

    await harness.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: undefined
    }));
    await harness.deferred.flush();

    expect(harness.mirror.writeCount).toBe(3);
    await expect(harness.cache.getMirrorStatus()).resolves.toEqual({
      status: "delayed",
      revision: 2
    });
  });

  it("emits secret-safe counters for cache, Blob, mirror success, and terminal failure", async () => {
    const successEvents: unknown[] = [];
    const success = controlStoreHarness(testControlDocument(), {
      requestId: "request-1",
      observer: { emit: event => successEvents.push(event) }
    });
    await success.store.load();
    await success.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: undefined
    }));
    await success.deferred.flush();
    expect(successEvents).toEqual(expect.arrayContaining([
      { level: "info", event: "control_plane_cache_hit", requestId: "request-1", householdId: "h1", count: 1 },
      { level: "info", event: "control_plane_blob_read", requestId: "request-1", householdId: "h1", count: 1 },
      { level: "info", event: "control_plane_mirror_write", requestId: "request-1", householdId: "h1", revision: 2, count: 1 }
    ]));

    const failureEvents: unknown[] = [];
    const failure = controlStoreHarness(testControlDocument(), {
      mirrorFailures: 3,
      observer: { emit: event => failureEvents.push(event) }
    });
    failure.mirror.write = async () => {
      failure.mirror.writeCount += 1;
      throw new Error("refresh-token=secret providerNodeId=private");
    };
    await failure.store.mutate("settings", current => ({
      changed: true,
      next: { ...current, revision: current.revision + 1 },
      result: undefined
    }));
    await failure.deferred.flush();
    const terminal = failureEvents.find((event: any) => event.event === "control_plane_mirror_failed");
    expect(terminal).toEqual({
      level: "error",
      event: "control_plane_mirror_failed",
      requestId: "test-request",
      householdId: "h1",
      revision: 2,
      errorCode: "CONTROL_PLANE_MIRROR_FAILED",
      count: 1
    });
    expect(JSON.stringify(terminal)).not.toMatch(/refresh-token|providerNodeId|secret|private/);
  });

  it("ignores telemetry observer failures", async () => {
    const harness = controlStoreHarness(testControlDocument(), {
      observer: { emit: () => { throw new Error("telemetry unavailable"); } }
    });
    await expect(harness.store.load()).resolves.toMatchObject({ document: { householdId: "h1" } });
  });

  it("retains the scheduling request id for mirror telemetry after the request scope exits", async () => {
    const keyring = testAeadKeyring();
    const initial = {
      envelope: encryptControlPlaneDocument(testControlDocument(), keyring),
      etag: "etag-1"
    };
    const durable = new MemoryControlDurableStore(initial, 0, keyring.keys);
    const cache = createMemoryControlHotCache();
    cache.replaceOutOfBand(initial);
    const deferred = new MemoryDeferredTasks();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mirror = { write: vi.fn(async () => gate) };
    const events: unknown[] = [];
    const store = createControlPlaneStore({
      durable,
      cache,
      mirror,
      deferred,
      keyring,
      householdId: "h1"
    });

    await store.withTelemetry!(
      { emit: event => events.push(event) },
      "originating-request",
      () => store.mutate("settings", current => ({
        changed: true,
        next: { ...current, revision: current.revision + 1 },
        result: undefined
      }))
    );
    expect(events.some((event: any) => event.event === "control_plane_mirror_write")).toBe(false);

    release();
    await deferred.flush();

    expect(events).toContainEqual({
      level: "info",
      event: "control_plane_mirror_write",
      requestId: "originating-request",
      householdId: "h1",
      revision: 2,
      count: 1
    });
  });
});

describe("Vercel control-plane adapters", () => {
  it("inspects the deterministic Blob ETag without parsing its body", async () => {
    blobSdk.head.mockResolvedValueOnce({ etag: "etag-1" });
    const durable = createVercelBlobControlStore({
      environment: "preview",
      householdId: "h1",
      storeId: "store-1"
    });

    await expect(durable.inspect()).resolves.toEqual({ status: "present", etag: "etag-1" });
    expect(blobSdk.head).toHaveBeenCalledWith(
      "cloudframe/control-plane/preview/h1.json.enc",
      { storeId: "store-1" }
    );
  });
  it("reads the deterministic private Blob path with origin revalidation", async () => {
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());
    blobSdk.get
      .mockResolvedValueOnce({ statusCode: 304, stream: null, blob: { etag: "etag-1" } })
      .mockResolvedValueOnce({
        statusCode: 200,
        stream: new Response(JSON.stringify(envelope)).body,
        blob: { etag: 'W/"etag-2"' }
      });
    const durable = createVercelBlobControlStore({
      environment: "preview",
      householdId: "h1",
      storeId: "store-1"
    });

    await expect(durable.read("etag-1")).resolves.toEqual({ notModified: true });
    await expect(durable.read()).resolves.toEqual({
      envelope,
      etag: '"etag-2"',
      revalidationEtag: 'W/"etag-2"'
    });
    expect(blobSdk.get).toHaveBeenNthCalledWith(
      1,
      "cloudframe/control-plane/preview/h1.json.enc",
      { access: "private", useCache: false, ifNoneMatch: "etag-1", storeId: "store-1" }
    );
    expect(blobSdk.get).toHaveBeenNthCalledWith(
      2,
      "cloudframe/control-plane/preview/h1.json.enc",
      { access: "private", useCache: false, ifNoneMatch: undefined, storeId: "store-1" }
    );

    blobSdk.put.mockResolvedValueOnce({ etag: '"etag-3"' });
    await expect(durable.replace(envelope, '"etag-2"')).resolves.toEqual({
      etag: '"etag-3"'
    });
    expect(blobSdk.put).toHaveBeenLastCalledWith(
      "cloudframe/control-plane/preview/h1.json.enc",
      JSON.stringify(envelope),
      {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        ifMatch: '"etag-2"',
        storeId: "store-1"
      }
    );

    blobSdk.get.mockResolvedValueOnce({
      statusCode: 304,
      stream: null,
      blob: { etag: "" }
    });
    const cache = createMemoryControlHotCache();
    cache.replaceOutOfBand({
      envelope,
      etag: '"etag-2"',
      revalidationEtag: 'W/"etag-2"'
    });
    const store = createControlPlaneStore({
      durable,
      cache,
      mirror: new MemoryRecoveryMirror(),
      deferred: new MemoryDeferredTasks(),
      keyring: testAeadKeyring()
    });
    await store.load();
    expect(blobSdk.get).toHaveBeenLastCalledWith(
      "cloudframe/control-plane/preview/h1.json.enc",
      {
        access: "private",
        useCache: false,
        ifNoneMatch: 'W/"etag-2"',
        storeId: "store-1"
      }
    );
  });

  it("uses exact private CAS write options and normalizes ETag conflicts", async () => {
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());
    blobSdk.put
      .mockResolvedValueOnce({ etag: "etag-created" })
      .mockResolvedValueOnce({ etag: "etag-replaced" })
      .mockRejectedValueOnce(new BlobPreconditionFailedError())
      .mockRejectedValueOnce(new BlobPreconditionFailedError());
    const durable = createVercelBlobControlStore({
      environment: "production",
      householdId: "h1"
    });

    await expect(durable.create(envelope)).resolves.toEqual({ etag: "etag-created" });
    await expect(durable.replace(envelope, "etag-old")).resolves.toEqual({ etag: "etag-replaced" });
    await expect(durable.replace(envelope, "etag-stale")).rejects.toMatchObject({
      code: "CONTROL_PLANE_CONFLICT"
    });
    await expect(durable.create(envelope)).rejects.toMatchObject({
      code: "CONTROL_PLANE_CONFLICT"
    });
    expect(blobSdk.put).toHaveBeenNthCalledWith(
      1,
      "cloudframe/control-plane/production/h1.json.enc",
      JSON.stringify(envelope),
      {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: false,
        ifMatch: undefined
      }
    );
    expect(blobSdk.put).toHaveBeenNthCalledWith(
      2,
      "cloudframe/control-plane/production/h1.json.enc",
      JSON.stringify(envelope),
      {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
        ifMatch: "etag-old"
      }
    );
  });

  it("uses the exact Runtime Cache namespace, control key, tag, TTL, and status key", async () => {
    const values = new Map<string, unknown>();
    const runtime = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: unknown) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());

    await cache.set({ envelope, etag: "etag-1" }, 300);
    await cache.setMirrorStatus({ status: "delayed", revision: 1 });
    const loaded = await cache.get();

    expect(runtimeCacheSdk.getCache).toHaveBeenCalledWith({ namespace: "cloudframe-control" });
    expect(runtime.set).toHaveBeenNthCalledWith(
      1,
      "v2:preview:h1",
      { envelope, etag: "etag-1" },
      { tags: ["cloudframe-control:preview:h1"], ttl: 300 }
    );
    expect(runtime.set).toHaveBeenNthCalledWith(
      2,
      "mirror-status:v2:preview:h1",
      { status: "delayed", revision: 1 },
      { tags: ["cloudframe-control:preview:h1"], ttl: 300 }
    );
    expect(loaded).toEqual({ envelope, etag: "etag-1" });
  });

  it("detects a swallowed Runtime Cache control write", async () => {
    const runtime = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());

    await expect(cache.set({ envelope, etag: "etag-1" }, 300)).rejects.toMatchObject({
      code: "CONTROL_CACHE_OPERATION_FAILED"
    });
  });

  it("detects a swallowed Runtime Cache mirror-status write", async () => {
    const runtime = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });

    await expect(cache.setMirrorStatus({ status: "delayed", revision: 2 })).rejects.toMatchObject({
      code: "CONTROL_CACHE_OPERATION_FAILED"
    });
  });

  it("rejects a Runtime Cache delete when the residual value remains visible", async () => {
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());
    const stored = { envelope, etag: "etag-1" };
    const runtime = {
      get: vi.fn(async () => stored),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });

    await expect(cache.delete()).rejects.toMatchObject({
      code: "CONTROL_CACHE_OPERATION_FAILED"
    });
  });

  it("surfaces a null Runtime Cache delete probe as unverifiable", async () => {
    const runtime = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });

    await expect(cache.delete()).resolves.toBe("unverifiable");
  });

  it("continues with authoritative Blob after unverifiable corrupt-cache cleanup", async () => {
    const keyring = testAeadKeyring();
    const initial = {
      envelope: encryptControlPlaneDocument(testControlDocument(), keyring),
      etag: "etag-1"
    };
    const corrupt = { ...initial, cleartext: testControlDocument() };
    let cached: unknown = corrupt;
    let getCount = 0;
    const runtime = {
      get: vi.fn(async () => {
        getCount += 1;
        if (getCount === 2) return null;
        return cached;
      }),
      set: vi.fn(async (_key: string, value: unknown) => { cached = value; }),
      delete: vi.fn(async () => undefined),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });
    const durable = new MemoryControlDurableStore(initial, 0, keyring.keys);
    const mirror = new MemoryRecoveryMirror();
    const deferred = new MemoryDeferredTasks();
    const store = createControlPlaneStore({ durable, cache, mirror, deferred, keyring });

    const loaded = await store.load();

    expect(loaded.document.revision).toBe(1);
    expect(durable.ifNoneMatches).toEqual([undefined]);
    expect(runtime.delete).toHaveBeenCalledOnce();
    expect(runtime.set).toHaveBeenCalledOnce();
  });

  it("reports an invalid Runtime Cache value without deleting it inside get", async () => {
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());
    const runtime = {
      get: vi.fn(async () => ({ envelope, etag: "etag-1", cleartext: testControlDocument() })),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      expireTag: vi.fn(async () => undefined)
    };
    runtimeCacheSdk.getCache.mockReturnValue(runtime);
    const cache = createVercelRuntimeControlCache({ environment: "preview", householdId: "h1" });

    await expect(cache.get()).rejects.toMatchObject({ code: "CONTROL_CACHE_CORRUPT" });

    expect(runtime.delete).not.toHaveBeenCalled();
  });

  it("does not retain references in the memory cache", async () => {
    const cache = createMemoryControlHotCache();
    const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());
    const stored = { envelope, etag: "etag-1" };

    await cache.set(stored, 300);
    stored.envelope.revision = 99;
    const first = await cache.get();
    if (first) first.envelope.revision = 100;

    await expect(cache.get()).resolves.toMatchObject({ envelope: { revision: 1 } });
  });
});
