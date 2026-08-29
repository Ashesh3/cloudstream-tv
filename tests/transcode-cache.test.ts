import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TranscodeError, createTranscodeCache, createTranscodeCatalog, openLocalDatabase, type MediaProbe } from "@cloudframe/server";

const directories: string[] = [];
const keyA = "a".repeat(64);
const keyB = "b".repeat(64);
const keyC = "c".repeat(64);
const jobId = "job_" + "x".repeat(32);
const probe: MediaProbe = { durationMs: 8_000, container: "mpeg", videoCodec: "mpeg2video", audioCodec: "mp2", width: 640, height: 360, pixelFormat: "yuv420p", frameRate: 25 };

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harness(options: { max?: number; minFree?: number; free?: () => number } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-cache-"));
  directories.push(dataDir);
  const local = await openLocalDatabase({ dataDir });
  const catalog = createTranscodeCatalog(local.connection);
  const cache = createTranscodeCache({
    catalog,
    transcodeDir: local.transcodeDir,
    stagingDir: local.stagingDir,
    cacheMaxBytes: options.max ?? 10_000,
    cacheMinFreeBytes: options.minFree ?? 1_000,
    statfs: async () => ({ freeBytes: options.free?.() ?? 100_000 }),
    now: () => new Date(1_000),
  });
  return { local, catalog, cache };
}

function seedAsset(catalog: ReturnType<typeof createTranscodeCatalog>, key: string, at: number) {
  catalog.upsertProbe(key, "h264-aac-1080p-v1", probe, 2, at);
}

describe("transcode disk cache", () => {
  it("derives hashed server paths and rejects traversal input", async () => {
    const { local, cache } = await harness();
    try {
      expect(cache.segmentPath(keyA, 7)).toBe(join(local.transcodeDir, "aa", keyA, "7.ts"));
      expect(cache.stagingSegmentPath(jobId, 7)).toBe(join(local.stagingDir, jobId, "7.ts.tmp"));
      for (const attempt of [
        () => cache.segmentPath("../secret", 0),
        () => cache.segmentPath(keyA, -1),
        () => cache.stagingSegmentPath("../job", 0),
        () => cache.stagingSegmentPath("short", 0),
      ]) expect(attempt).toThrow("TRANSCODER_PATH_INVALID");
    } finally { local.close(); }
  });

  it("removes abandoned staging temporary files at startup", async () => {
    const { local, cache } = await harness();
    try {
      const directory = cache.stagingJobDirectory(jobId);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "0.ts.tmp"), "temporary");
      await writeFile(join(directory, "1.ts.part"), "partial");
      await cache.reconcile();
      await expect(access(join(directory, "0.ts.tmp"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(directory, "1.ts.part"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { local.close(); }
  });

  it("hashes and atomically promotes a validated segment", async () => {
    const { local, catalog, cache } = await harness();
    try {
      seedAsset(catalog, keyA, 100);
      await mkdir(cache.stagingJobDirectory(jobId), { recursive: true });
      const body = Buffer.from("complete MPEG-TS segment");
      const staging = cache.stagingSegmentPath(jobId, 0);
      await writeFile(staging, body);
      const sha256 = createHash("sha256").update(body).digest("hex");
      const promoted = await cache.promoteSegment({ jobId, cacheKey: keyA, segmentIndex: 0, windowIndex: 0, durationMs: 4_000, expectedSizeBytes: body.length, expectedSha256: sha256 });
      expect(await readFile(promoted.path)).toEqual(body);
      expect(catalog.segment(keyA, 0)).toMatchObject({ sizeBytes: body.length, sha256 });
      await expect(access(staging)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { local.close(); }
  });

  it("rejects checksum or size mismatch without cataloging", async () => {
    const { local, catalog, cache } = await harness();
    try {
      seedAsset(catalog, keyA, 100);
      await mkdir(cache.stagingJobDirectory(jobId), { recursive: true });
      await writeFile(cache.stagingSegmentPath(jobId, 0), "body");
      await expect(cache.promoteSegment({ jobId, cacheKey: keyA, segmentIndex: 0, windowIndex: 0, durationMs: 4_000, expectedSizeBytes: 999 }))
        .rejects.toMatchObject({ code: "TRANSCODER_FAILED" });
      expect(catalog.segment(keyA, 0)).toBeNull();
      await expect(access(cache.segmentPath(keyA, 0))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { local.close(); }
  });

  it("skips pinned assets and evicts the oldest eligible asset", async () => {
    const { local, catalog, cache } = await harness({ max: 1_500, minFree: 1_000, free: () => 1_100 });
    try {
      for (const [key, at] of [[keyA, 100], [keyB, 200], [keyC, 300]] as const) {
        seedAsset(catalog, key, at);
        catalog.recordSegment({ cacheKey: key, segmentIndex: 0, windowIndex: 0, durationMs: 4_000, relativePath: `${key.slice(0, 2)}/${key}/0.ts`, sizeBytes: 600, sha256: "d".repeat(64), completedAt: at, lastAccessedAt: at });
        await mkdir(cache.assetDirectory(key), { recursive: true });
        await writeFile(cache.segmentPath(key, 0), Buffer.alloc(600));
      }
      const releaseActive = cache.pinActive(keyA);
      const releaseGenerating = cache.pinGenerating(keyC, 0);
      await cache.ensureCapacity(100);
      expect(catalog.loadAsset(keyB)).toBeNull();
      expect(catalog.loadAsset(keyA)).not.toBeNull();
      expect(catalog.loadAsset(keyC)).not.toBeNull();
      releaseActive();
      releaseGenerating();
    } finally { local.close(); }
  });

  it("throws when the reserved free-space floor cannot be satisfied", async () => {
    const { local, catalog, cache } = await harness({ minFree: 5_000, free: () => 100 });
    try {
      seedAsset(catalog, keyA, 100);
      const release = cache.pinActive(keyA);
      await expect(cache.ensureCapacity(1)).rejects.toEqual(new TranscodeError("TRANSCODER_CACHE_FULL"));
      release();
    } finally { local.close(); }
  });
});
