import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTranscodeCatalog, openLocalDatabase, type MediaProbe } from "@cloudframe/server";

const directories: string[] = [];
const keyA = "a".repeat(64);
const keyB = "b".repeat(64);
const probe: MediaProbe = {
  durationMs: 43_250,
  container: "mpeg",
  videoCodec: "mpeg2video",
  audioCodec: "mp2",
  width: 640,
  height: 360,
  pixelFormat: "yuv420p",
  frameRate: 25,
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-catalog-"));
  directories.push(dataDir);
  const local = await openLocalDatabase({ dataDir });
  return { local, catalog: createTranscodeCatalog(local.connection) };
}

describe("transcode catalog", () => {
  it("opens at schema version two and round-trips strict probe metadata", async () => {
    const { local, catalog } = await harness();
    try {
      expect(local.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1 }, { version: 2 }]);
      catalog.upsertProbe(keyA, "h264-aac-1080p-v1", probe, 11, 100);
      expect(catalog.loadAsset(keyA)).toEqual({
        cacheKey: keyA,
        profileId: "h264-aac-1080p-v1",
        durationMs: 43_250,
        segmentCount: 11,
        probe,
        totalBytes: 0,
        lastAccessedAt: 100,
      });
    } finally { local.close(); }
  });

  it("records segments and window state with transactional byte accounting", async () => {
    const { local, catalog } = await harness();
    try {
      catalog.upsertProbe(keyA, "h264-aac-1080p-v1", probe, 11, 100);
      catalog.markWindow(keyA, 0, "partial", 110);
      catalog.recordSegment({ cacheKey: keyA, segmentIndex: 0, windowIndex: 0, durationMs: 4_000, relativePath: `aa/${keyA}/0.ts`, sizeBytes: 1_000, sha256: "c".repeat(64), completedAt: 120, lastAccessedAt: 120 });
      catalog.recordSegment({ cacheKey: keyA, segmentIndex: 0, windowIndex: 0, durationMs: 4_000, relativePath: `aa/${keyA}/0.ts`, sizeBytes: 1_250, sha256: "d".repeat(64), completedAt: 130, lastAccessedAt: 130 });
      catalog.markWindow(keyA, 0, "complete", 140);

      expect(catalog.segment(keyA, 0)).toMatchObject({ sizeBytes: 1_250, sha256: "d".repeat(64) });
      expect(catalog.window(keyA, 0)).toMatchObject({ state: "complete", updatedAt: 140 });
      expect(catalog.totalBytes()).toBe(1_250);
      catalog.deleteSegment(keyA, 0);
      expect(catalog.segment(keyA, 0)).toBeNull();
      expect(catalog.totalBytes()).toBe(0);
    } finally { local.close(); }
  });

  it("orders LRU candidates, touches assets, and cascades deletion", async () => {
    const { local, catalog } = await harness();
    try {
      catalog.upsertProbe(keyA, "h264-aac-1080p-v1", probe, 11, 300);
      catalog.upsertProbe(keyB, "h264-aac-1080p-v1", probe, 11, 100);
      expect(catalog.lruCandidates().map((asset) => asset.cacheKey)).toEqual([keyB, keyA]);
      catalog.touchAsset(keyB, 400);
      expect(catalog.lruCandidates().map((asset) => asset.cacheKey)).toEqual([keyA, keyB]);
      catalog.markWindow(keyA, 0, "partial", 310);
      catalog.recordSegment({ cacheKey: keyA, segmentIndex: 0, windowIndex: 0, durationMs: 4_000, relativePath: `aa/${keyA}/0.ts`, sizeBytes: 100, sha256: "c".repeat(64), completedAt: 310, lastAccessedAt: 310 });
      catalog.deleteAsset(keyA);
      expect(catalog.loadAsset(keyA)).toBeNull();
      expect(catalog.segment(keyA, 0)).toBeNull();
      expect(catalog.window(keyA, 0)).toBeNull();
    } finally { local.close(); }
  });

  it("removes corrupt persisted probe metadata before reuse", async () => {
    const { local, catalog } = await harness();
    try {
      catalog.upsertProbe(keyA, "h264-aac-1080p-v1", probe, 11, 100);
      local.connection.prepare("UPDATE transcode_assets SET probe_json = ? WHERE cache_key = ?")
        .run('{"durationMs":"secret"}', keyA);
      expect(catalog.loadAsset(keyA)).toBeNull();
      expect(local.connection.prepare("SELECT cache_key FROM transcode_assets WHERE cache_key = ?").get(keyA)).toBeUndefined();
    } finally { local.close(); }
  });
});
