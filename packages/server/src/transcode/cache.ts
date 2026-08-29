import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { TranscodeCatalog, TranscodeSegmentRecord } from "./catalog.ts";
import { TranscodeError, type TranscodeSegmentFile } from "./types.ts";

export interface TranscodeCache {
  assetDirectory(cacheKey: string): string;
  segmentPath(cacheKey: string, segmentIndex: number): string;
  stagingJobDirectory(jobId: string): string;
  stagingSegmentPath(jobId: string, segmentIndex: number): string;
  reconcile(): Promise<void>;
  loadSegment(cacheKey: string, segmentIndex: number): Promise<TranscodeSegmentFile | null>;
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
    await mkdir(transcodeDir, { recursive: true });
    await mkdir(stagingDir, { recursive: true });
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    const expected = new Set<string>();
    for (const asset of options.catalog.lruCandidates()) {
      const records = options.catalog.segments(asset.cacheKey);
      let valid = true;
      for (const record of records) {
        if (!(await validateSegmentMetadata(asset.cacheKey, record.segmentIndex, record))) {
          valid = false;
          break;
        }
      }
      if (!valid) {
        await rm(assetDirectory(asset.cacheKey), { recursive: true, force: true });
        options.catalog.deleteAsset(asset.cacheKey);
        continue;
      }
      for (const record of records) expected.add(segmentPath(asset.cacheKey, record.segmentIndex));
    }
    await removeUnexpectedFiles(transcodeDir, expected, false);
  }

  async function loadSegment(cacheKey: string, segmentIndex: number): Promise<TranscodeSegmentFile | null> {
    const record = options.catalog.segment(cacheKey, segmentIndex);
    if (!record) return null;
    if (!(await validateSegmentRecord(cacheKey, segmentIndex, record))) {
      await rm(segmentPath(cacheKey, segmentIndex), { force: true });
      options.catalog.deleteSegment(cacheKey, segmentIndex);
      return null;
    }
    return {
      path: segmentPath(cacheKey, segmentIndex),
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      durationMs: record.durationMs,
      segmentIndex,
    };
  }

  async function validateSegmentRecord(cacheKey: string, segmentIndex: number, record: TranscodeSegmentRecord) {
    if (!(await validateSegmentMetadata(cacheKey, segmentIndex, record))) return false;
    try {
      return await hashFile(segmentPath(cacheKey, segmentIndex)) === record.sha256;
    } catch {
      return false;
    }
  }

  async function validateSegmentMetadata(cacheKey: string, segmentIndex: number, record: TranscodeSegmentRecord) {
    const path = segmentPath(cacheKey, segmentIndex);
    const expectedRelative = relative(transcodeDir, path).replaceAll(sep, "/");
    if (record.cacheKey !== cacheKey || record.segmentIndex !== segmentIndex || record.relativePath !== expectedRelative || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
    try {
      const metadata = await stat(path);
      return metadata.isFile() && metadata.size === record.sizeBytes && metadata.size > 0;
    } catch {
      return false;
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
    assetDirectory, segmentPath, stagingJobDirectory, stagingSegmentPath, reconcile, loadSegment, promoteSegment, ensureCapacity,
    pinActive: (cacheKey) => pin(cacheKey),
    pinServed: (cacheKey, segmentIndex) => pin(`${cacheKey}:segment:${segmentIndex}`),
    pinGenerating: (cacheKey, windowIndex) => pin(`${cacheKey}:window:${windowIndex}`),
    isPinned,
    totalBytes: () => options.catalog.totalBytes(),
  };
}

async function hashFile(path: string) { const hash = createHash("sha256"); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest("hex"); }
async function removeUnexpectedFiles(directory: string, expected: Set<string>, removeDirectory: boolean): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeUnexpectedFiles(path, expected, true);
    else if (!expected.has(path)) await rm(path, { force: true });
  }
  if (removeDirectory && (await readdir(directory)).length === 0) await rm(directory, { recursive: true, force: true });
}
function requireCacheKey(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw new TranscodeError("TRANSCODER_PATH_INVALID"); }
function requireJobId(value: string) { if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw new TranscodeError("TRANSCODER_PATH_INVALID"); }
function requireIndex(value: number) { if (!Number.isSafeInteger(value) || value < 0) throw new TranscodeError("TRANSCODER_PATH_INVALID"); }
function owned(root: string, candidate: string) { const result = relative(root, candidate); if (result === "" || result === ".." || result.startsWith(`..${sep}`)) throw new TranscodeError("TRANSCODER_PATH_INVALID"); return candidate; }
