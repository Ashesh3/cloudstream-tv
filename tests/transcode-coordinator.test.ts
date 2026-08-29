import { describe, expect, it, vi } from "vitest";
import {
  TranscodeError,
  createTranscodeCoordinator,
  transcodeProfile,
  type AuthorizedTranscodeSource,
  type EncodeWindowInput,
  type EncodeWindowResult,
  type MediaProbe,
  type TranscodeSegmentFile,
  type WindowEncoder,
} from "@cloudframe/server";

const probe: MediaProbe = {
  durationMs: 90_000,
  container: "mpeg",
  videoCodec: "mpeg2video",
  audioCodec: "mp2",
  width: 640,
  height: 360,
  pixelFormat: "yuv420p",
  frameRate: 25,
};
const profile = transcodeProfile("auto");

function source(deviceId = "device-1", providerNodeId = "video-1"): AuthorizedTranscodeSource {
  return {
    auth: {
      householdId: "h1",
      deviceId,
      sessionVersion: 1,
      device: {
        id: deviceId,
        name: deviceId === "device-1" ? "Living Room" : "Bedroom",
        enabled: true,
        assignedRootIds: ["root-1"],
        mediaOrder: null,
        slideshowSeconds: null,
        sessionVersion: 1,
        createdAt: "2026-08-29T00:00:00.000Z",
        approvedAt: "2026-08-29T00:00:00.000Z",
        revokedAt: null,
      },
      context: { document: {} as never, revision: 1 },
    },
    item: {} as never,
    binding: {
      householdId: "h1",
      deviceId,
      deviceSessionVersion: 1,
      sourceId: "source-1",
      rootId: "root-1",
      rootProviderNodeId: "provider-root",
      providerNodeId,
      provider: "google",
      itemId: `item-${providerNodeId}`,
      name: `${providerNodeId}.mpg`,
      mimeType: "video/mpeg",
      size: 12_345,
      contentRevision: "revision-7",
      credentialVersion: 1,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  let clock = 1_000_000;
  let nextId = 1;
  const assets = new Map<string, { probe: MediaProbe; segmentCount: number; totalBytes: number }>();
  const segments = new Map<string, TranscodeSegmentFile>();
  const windows = new Map<string, "partial" | "complete">();
  const activePins = new Set<string>();
  const generatingPins = new Set<string>();
  const capacityCalls: number[] = [];
  const encoderInputs: EncodeWindowInput[] = [];
  const encoderDeferred: Array<ReturnType<typeof deferred<EncodeWindowResult>>> = [];
  let activeEncodes = 0;
  let maxActiveEncodes = 0;
  let probeCalls = 0;

  const encoder: WindowEncoder = {
    encode(input) {
      encoderInputs.push(input);
      activeEncodes += 1;
      maxActiveEncodes = Math.max(maxActiveEncodes, activeEncodes);
      const pending = deferred<EncodeWindowResult>();
      encoderDeferred.push(pending);
      return pending.promise.finally(() => { activeEncodes -= 1; });
    },
  };
  const catalog = {
    loadAsset(cacheKey: string) {
      const asset = assets.get(cacheKey);
      return asset ? { cacheKey, profileId: profile.id, durationMs: asset.probe.durationMs, segmentCount: asset.segmentCount, probe: asset.probe, totalBytes: asset.totalBytes, lastAccessedAt: clock } : null;
    },
    upsertProbe(cacheKey: string, _profileId: string, value: MediaProbe, segmentCount: number) {
      assets.set(cacheKey, { probe: value, segmentCount, totalBytes: 0 });
    },
    segment(cacheKey: string, segmentIndex: number) { return segments.has(`${cacheKey}:${segmentIndex}`) ? { cacheKey, segmentIndex, windowIndex: Math.floor(segmentIndex / 5), durationMs: 4_000, relativePath: `${segmentIndex}.ts`, sizeBytes: 188, sha256: "a".repeat(64), completedAt: clock, lastAccessedAt: clock } : null; },
    window(cacheKey: string, windowIndex: number) { const state = windows.get(`${cacheKey}:${windowIndex}`); return state ? { cacheKey, windowIndex, state, updatedAt: clock } : null; },
    touchAsset: vi.fn(),
    touchSegment: vi.fn(),
    totalBytes: () => [...assets.values()].reduce((sum, value) => sum + value.totalBytes, 0),
  };
  const cache = {
    segmentPath(cacheKey: string, segmentIndex: number) { return `/cache/${cacheKey}/${segmentIndex}.ts`; },
    ensureCapacity: async (bytes: number) => { capacityCalls.push(bytes); },
    pinActive(cacheKey: string) { activePins.add(cacheKey); return () => activePins.delete(cacheKey); },
    pinGenerating(cacheKey: string, windowIndex: number) { const key = `${cacheKey}:${windowIndex}`; generatingPins.add(key); return () => generatingPins.delete(key); },
    pinServed: () => () => undefined,
    totalBytes: () => catalog.totalBytes(),
  };
  const gateway = {
    grant: () => ({ inputUrl: "http://127.0.0.1/source/capability", capability: "capability", expiresAt: clock + 60_000, revoke: vi.fn() }),
  };
  const coordinator = createTranscodeCoordinator({
    gateway: gateway as never,
    probe: { async probe() { probeCalls += 1; return probe; } },
    catalog: catalog as never,
    cache: cache as never,
    encoder,
    profile,
    now: () => new Date(clock),
    createId: () => `session-${nextId++}`,
    createJobId: () => `job_${String(nextId++).padStart(32, "0")}`,
    setInterval: () => ({}) as never,
    clearInterval: () => undefined,
  });

  function promote(jobIndex: number, segmentIndex: number) {
    const input = encoderInputs[jobIndex]!;
    const file = { path: `/cache/${input.cacheKey}/${segmentIndex}.ts`, sizeBytes: 188, sha256: "a".repeat(64), durationMs: 4_000, segmentIndex };
    segments.set(`${input.cacheKey}:${segmentIndex}`, file);
    input.onSegmentPromoted?.(segmentIndex);
  }
  function complete(jobIndex: number) {
    const input = encoderInputs[jobIndex]!;
    windows.set(`${input.cacheKey}:${input.windowIndex}`, "complete");
    encoderDeferred[jobIndex]!.resolve({ cacheKey: input.cacheKey, windowIndex: input.windowIndex, completedSegmentIndices: [], complete: true });
  }

  return {
    coordinator,
    encoderInputs,
    encoderDeferred,
    assets,
    segments,
    activePins,
    generatingPins,
    capacityCalls,
    promote,
    complete,
    advance(ms: number) { clock += ms; },
    get probeCalls() { return probeCalls; },
    get maxActiveEncodes() { return maxActiveEncodes; },
  };
}

describe("one-TV transcode coordinator", () => {
  it("acquires, reuses, replaces, heartbeats, and expires the one-device lease", async () => {
    const current = harness();
    const first = await current.coordinator.createSession(source());
    expect(first.expiresAt).toBe(1_045_000);
    expect(current.probeCalls).toBe(1);
    expect(current.activePins.has(first.cacheKey)).toBe(true);

    const same = await current.coordinator.createSession(source());
    expect(same.id).toBe(first.id);
    expect(current.probeCalls).toBe(1);
    await expect(current.coordinator.createSession(source("device-2")))
      .rejects.toEqual(new TranscodeError("TRANSCODER_BUSY"));

    current.advance(10_000);
    current.coordinator.heartbeat(first.id, "device-1");
    expect(current.coordinator.session(first.id)?.expiresAt).toBe(1_055_000);
    const replacement = await current.coordinator.createSession(source("device-1", "video-2"));
    expect(replacement.id).not.toBe(first.id);
    expect(current.coordinator.session(first.id)).toBeNull();

    current.advance(45_001);
    expect(current.coordinator.session(replacement.id)).toBeNull();
    await current.coordinator.close();
  });

  it("deduplicates twenty segment callers and resolves on promotion before window completion", async () => {
    const current = harness();
    const session = await current.coordinator.createSession(source());
    const callers = Array.from({ length: 20 }, () => current.coordinator.segment(session.id, 6, new AbortController().signal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.encoderInputs).toHaveLength(1);
    expect(current.encoderInputs[0]!.windowIndex).toBe(1);

    current.promote(0, 6);
    await expect(Promise.all(callers)).resolves.toEqual(Array.from({ length: 20 }, () => expect.objectContaining({ segmentIndex: 6 })));
    let jobSettled = false; void current.encoderDeferred[0]!.promise.finally(() => { jobSettled = true; });
    await Promise.resolve(); expect(jobSettled).toBe(false);
    current.complete(0);
    await current.encoderDeferred[0]!.promise;
    await current.coordinator.close();
  });

  it("prefetches one next window, but a distant demand cancels it and starts first", async () => {
    const current = harness();
    const session = await current.coordinator.createSession(source());
    const first = current.coordinator.segment(session.id, 0, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    current.promote(0, 0);
    await first;
    current.complete(0);
    await current.encoderDeferred[0]!.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.encoderInputs[1]!.windowIndex).toBe(1);

    const far = current.coordinator.segment(session.id, 22, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.encoderInputs[1]!.signal.aborted).toBe(true);
    current.encoderDeferred[1]!.reject(new TranscodeError("TRANSCODER_FAILED"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.encoderInputs[2]!.windowIndex).toBe(4);
    current.promote(2, 22);
    await expect(far).resolves.toMatchObject({ segmentIndex: 22 });
    current.complete(2);
    await current.coordinator.close();
  });

  it("serves cached segments without a process and never runs two encode jobs", async () => {
    const current = harness();
    const session = await current.coordinator.createSession(source());
    current.segments.set(`${session.cacheKey}:3`, { path: "cached", sizeBytes: 188, sha256: "a".repeat(64), durationMs: 4_000, segmentIndex: 3 });
    await expect(current.coordinator.segment(session.id, 3, new AbortController().signal)).resolves.toMatchObject({ path: expect.stringContaining("/3.ts") });
    expect(current.encoderInputs).toHaveLength(0);

    const first = current.coordinator.segment(session.id, 0, new AbortController().signal);
    const second = current.coordinator.segment(session.id, 6, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.encoderInputs).toHaveLength(1);
    current.promote(0, 0); await first; current.complete(0); await current.encoderDeferred[0]!.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.encoderInputs).toHaveLength(2);
    expect(current.maxActiveEncodes).toBe(1);
    current.promote(1, 6); await second; current.complete(1);
    await current.coordinator.close();
  });

  it("rejects invalid segments and shuts down active work deterministically", async () => {
    const current = harness();
    const session = await current.coordinator.createSession(source());
    await expect(current.coordinator.segment(session.id, -1, new AbortController().signal))
      .rejects.toEqual(new TranscodeError("TRANSCODER_SESSION_EXPIRED"));
    const pending = current.coordinator.segment(session.id, 0, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(current.generatingPins.size).toBe(1);
    const closing = current.coordinator.close();
    expect(current.encoderInputs[0]!.signal.aborted).toBe(true);
    current.encoderDeferred[0]!.reject(new TranscodeError("TRANSCODER_FAILED"));
    await expect(pending).rejects.toMatchObject({ code: "TRANSCODER_SESSION_EXPIRED" });
    await closing;
    expect(current.activePins.size).toBe(0);
    await expect(current.coordinator.createSession(source())).rejects.toEqual(new TranscodeError("TRANSCODER_SESSION_EXPIRED"));
  });
});
