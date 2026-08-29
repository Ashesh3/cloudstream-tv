import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { TranscodeCatalog } from "./catalog.ts";
import { TranscodeError, type TranscodeSegmentFile } from "./types.ts";

export interface TranscodeCache {
  assetDirectory(cacheKey: string): string;
  segmentPath(cacheKey: string, segmentIndex: number): string;
  stagingJobDirectory(jobId: string): string;
  stagingSegmentPath(jobId: string, segmentIndex: number): string;
  reconcile(): Promise<void>;
  promoteSegment(input: {
    jobId: string;
    cacheKey: string;
    segmentIndex: number;
    windowIndex: number;
    durationMs: number;
    expectedSizeBytes?: number;
    expectedSha256?: string;
  }): Promise<TranscodeSegmentFile>;
  ensureCapacity(requiredBytes: number): Promise<void>;
  pinActive(cacheKey: string): () => void;
  pinServed(cacheKey: string, segmentIndex: number): () => void;
  pinGenerating(cacheKey: string, windowIndex: number): () => void;
  isPinned(cacheKey: string): boolean;
  totalBytes(): number;
}

export function createTranscodeCache(options: {
  catalog: TranscodeCatalog;
  transcodeDir: string;
  stagingDir: string;
  cacheMaxBytes: number;
  cacheMinFreeBytes: number;
  statfs: (path: string) => Promise<{ freeBytes: number }>;
  now?: () => Date;
}): TranscodeCache {
  const transcodeDir = resolve(options.transcodeDir);
  const stagingDir = resolve(options.stagingDir);
  const pins = new Map<string, number>();
  const now = options.now ?? (() => new Date());

  function assetDirectory(cacheKey: string) {
    requireCacheKey(cacheKey);
    return owned(transcodeDir, join(transcodeDir, cacheKey.slice(0, 2), cacheKey));
  }
  function segmentPath(cacheKey: string, segmentIndex: number) {
    requireIndex(segmentIndex);
    return owned(transcodeDir, join(assetDirectory(cacheKey), `${segmentIndex}.ts`));
  }
  function stagingJobDirectory(jobId: string) {
    requireJobId(jobId);
    return owned(stagingDir, join(stagingDir, jobId));
  }
  function stagingSegmentPath(jobId: string, segmentIndex: number) {
    requireIndex(segmentIndex);
    return owned(stagingDir, join(stagingJobDirectory(jobId), `${segmentIndex}.ts.tmp`));
  }

  async function reconcile() {
    await mkdir(stagingDir, { recursive: true });
    for (const entry of await readdir(stagingDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || (!entry.name.endsWith(".tmp") && !entry.name.endsWith(".part"))) continue;
      const parent = "parentPath" in entry ? entry.parentPath : stagingDir;
      await rm(join(parent, entry.name), { force: true });
    }
  }

  async function promoteSegment(input: {
    jobId: string; cacheKey: string; segmentIndex: number; windowIndex: number; durationMs: number; expectedSizeBytes?: number; expectedSha256?: string;
  }): Promise<TranscodeSegmentFile> {
    const staging = stagingSegmentPath(input.jobId, input.segmentIndex);
    const metadata = await stat(staging);
    if (!metadata.isFile() || metadata.size <= 0 || !Number.isSafeInteger(metadata.size)) throw new TranscodeError("TRANSCODER_FAILED");
    const sha256 = await hashFile(staging);
    if ((input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== metadata.size) || (input.expectedSha256 !== undefined && input.expectedSha256 !== sha256)) throw new TranscodeError("TRANSCODER_FAILED");
    await ensureCapacity(metadata.size);
    const destination = segmentPath(input.cacheKey, input.segmentIndex);
    await mkdir(assetDirectory(input.cacheKey), { recursive: true });
    await rm(destination, { force: true });
    await rename(staging, destination);
    if (process.platform !== "win32") {
      const directory = await open(assetDirectory(input.cacheKey), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    const at = now().getTime();
    const relativePath = relative(transcodeDir, destination).replaceAll(sep, "/");
    options.catalog.recordSegment({ cacheKey: input.cacheKey, segmentIndex: input.segmentIndex, windowIndex: input.windowIndex, durationMs: input.durationMs, relativePath, sizeBytes: metadata.size, sha256, completedAt: at, lastAccessedAt: at });
    return { path: destination, sizeBytes: metadata.size, sha256, durationMs: input.durationMs, segmentIndex: input.segmentIndex };
  }

  async function ensureCapacity(requiredBytes: number) {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new TranscodeError("TRANSCODER_CACHE_FULL");
    while (true) {
      const free = (await options.statfs(transcodeDir)).freeBytes;
      const total = options.catalog.totalBytes();
      if (total + requiredBytes <= options.cacheMaxBytes && free - requiredBytes >= options.cacheMinFreeBytes) return;
      const candidate = options.catalog.lruCandidates().find((asset) => !isPinned(asset.cacheKey));
      if (!candidate) throw new TranscodeError("TRANSCODER_CACHE_FULL");
      await rm(assetDirectory(candidate.cacheKey), { recursive: true, force: true });
      options.catalog.deleteAsset(candidate.cacheKey);
    }
  }

  function pin(key: string) { pins.set(key, (pins.get(key) ?? 0) + 1); let released = false; return () => { if (released) return; released = true; const count = (pins.get(key) ?? 1) - 1; if (count <= 0) pins.delete(key); else pins.set(key, count); }; }
  function isPinned(cacheKey: string) { return [...pins.keys()].some((key) => key === cacheKey || key.startsWith(`${cacheKey}:`)); }

  return {
    assetDirectory, segmentPath, stagingJobDirectory, stagingSegmentPath, reconcile, promoteSegment, ensureCapacity,
    pinActive: (cacheKey) => pin(cacheKey),
    pinServed: (cacheKey, segmentIndex) => pin(`${cacheKey}:segment:${segmentIndex}`),
    pinGenerating: (cacheKey, windowIndex) => pin(`${cacheKey}:window:${windowIndex}`),
    isPinned,
    totalBytes: () => options.catalog.totalBytes(),
  };
}

async function hashFile(path: string) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
function requireCacheKey(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw new TranscodeError("TRANSCODER_PATH_INVALID"); }
function requireJobId(value: string) { if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new TranscodeError("TRANSCODER_PATH_INVALID"); }
function requireIndex(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new TranscodeError("TRANSCODER_PATH_INVALID"); }
function owned(root: string, candidate: string) { const result = relative(root, candidate); if (result === "" || result === ".." || result.startsWith(`..${sep}`)) throw new TranscodeError("TRANSCODER_PATH_INVALID"); return candidate; }
