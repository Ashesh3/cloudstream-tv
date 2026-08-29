import type { DatabaseSync } from "node:sqlite";
import type { MediaProbe } from "./types.ts";

export interface TranscodeAssetRecord {
  cacheKey: string;
  profileId: string;
  durationMs: number;
  segmentCount: number;
  probe: MediaProbe;
  totalBytes: number;
  lastAccessedAt: number;
}

export interface TranscodeSegmentRecord {
  cacheKey: string;
  segmentIndex: number;
  windowIndex: number;
  durationMs: number;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
  completedAt: number;
  lastAccessedAt: number;
}

export interface TranscodeWindowRecord {
  cacheKey: string;
  windowIndex: number;
  state: "partial" | "complete";
  updatedAt: number;
}

export interface TranscodeCatalog {
  upsertProbe(cacheKey: string, profileId: string, probe: MediaProbe, segmentCount: number, lastAccessedAt: number): void;
  loadAsset(cacheKey: string): TranscodeAssetRecord | null;
  recordSegment(segment: TranscodeSegmentRecord): void;
  segment(cacheKey: string, segmentIndex: number): TranscodeSegmentRecord | null;
  segments(cacheKey: string): TranscodeSegmentRecord[];
  deleteSegment(cacheKey: string, segmentIndex: number): void;
  markWindow(cacheKey: string, windowIndex: number, state: "partial" | "complete", updatedAt: number): void;
  window(cacheKey: string, windowIndex: number): TranscodeWindowRecord | null;
  touchAsset(cacheKey: string, at: number): void;
  touchSegment(cacheKey: string, segmentIndex: number, at: number): void;
  deleteAsset(cacheKey: string): void;
  lruCandidates(): TranscodeAssetRecord[];
  totalBytes(): number;
}

export function createTranscodeCatalog(database: DatabaseSync): TranscodeCatalog {
  function loadAsset(cacheKey: string): TranscodeAssetRecord | null {
    const row = database.prepare(`SELECT cache_key, profile_id, duration_ms, segment_count, probe_json, total_bytes, last_accessed_at FROM transcode_assets WHERE cache_key = ?`).get(cacheKey) as Record<string, unknown> | undefined;
    if (!row) return null;
    try {
      return decodeAsset(row);
    } catch {
      deleteAsset(cacheKey);
      return null;
    }
  }

  function upsertProbe(cacheKey: string, profileId: string, probe: MediaProbe, segmentCount: number, lastAccessedAt: number) {
    requireKey(cacheKey);
    parseProbe(probe);
    database.prepare(`INSERT INTO transcode_assets(cache_key, profile_id, duration_ms, segment_count, probe_json, total_bytes, last_accessed_at) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(cache_key) DO UPDATE SET profile_id=excluded.profile_id,duration_ms=excluded.duration_ms,segment_count=excluded.segment_count,probe_json=excluded.probe_json,last_accessed_at=excluded.last_accessed_at`).run(cacheKey, profileId, probe.durationMs, segmentCount, JSON.stringify(probe), lastAccessedAt);
  }

  function recordSegment(segment: TranscodeSegmentRecord) {
    requireKey(segment.cacheKey);
    transaction(database, () => {
      const previous = database.prepare("SELECT size_bytes FROM transcode_segments WHERE cache_key = ? AND segment_index = ?").get(segment.cacheKey, segment.segmentIndex) as { size_bytes?: number | bigint } | undefined;
      database.prepare(`INSERT INTO transcode_segments(cache_key,segment_index,window_index,duration_ms,relative_path,size_bytes,sha256,completed_at,last_accessed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key,segment_index) DO UPDATE SET window_index=excluded.window_index,duration_ms=excluded.duration_ms,relative_path=excluded.relative_path,size_bytes=excluded.size_bytes,sha256=excluded.sha256,completed_at=excluded.completed_at,last_accessed_at=excluded.last_accessed_at`).run(segment.cacheKey, segment.segmentIndex, segment.windowIndex, segment.durationMs, segment.relativePath, segment.sizeBytes, segment.sha256, segment.completedAt, segment.lastAccessedAt);
      database.prepare("UPDATE transcode_assets SET total_bytes = total_bytes - ? + ?, last_accessed_at = MAX(last_accessed_at, ?) WHERE cache_key = ?").run(Number(previous?.size_bytes ?? 0), segment.sizeBytes, segment.lastAccessedAt, segment.cacheKey);
    });
  }

  function segment(cacheKey: string, segmentIndex: number): TranscodeSegmentRecord | null {
    const row = database.prepare(`SELECT cache_key,segment_index,window_index,duration_ms,relative_path,size_bytes,sha256,completed_at,last_accessed_at FROM transcode_segments WHERE cache_key=? AND segment_index=?`).get(cacheKey, segmentIndex) as Record<string, unknown> | undefined;
    return row ? decodeSegment(row) : null;
  }

  function segments(cacheKey: string): TranscodeSegmentRecord[] {
    return (database.prepare(`SELECT cache_key,segment_index,window_index,duration_ms,relative_path,size_bytes,sha256,completed_at,last_accessed_at FROM transcode_segments WHERE cache_key=? ORDER BY segment_index`).all(cacheKey) as Record<string, unknown>[])
      .map(decodeSegment);
  }

  function deleteSegment(cacheKey: string, segmentIndex: number) {
    transaction(database, () => {
      const row = database.prepare("SELECT size_bytes, window_index FROM transcode_segments WHERE cache_key=? AND segment_index=?").get(cacheKey, segmentIndex) as { size_bytes?: number | bigint; window_index?: number | bigint } | undefined;
      if (!row) return;
      database.prepare("DELETE FROM transcode_segments WHERE cache_key=? AND segment_index=?").run(cacheKey, segmentIndex);
      database.prepare("UPDATE transcode_assets SET total_bytes = MAX(0, total_bytes - ?) WHERE cache_key=?").run(Number(row.size_bytes), cacheKey);
      database.prepare("UPDATE transcode_windows SET state='partial' WHERE cache_key=? AND window_index=?").run(cacheKey, Number(row.window_index));
    });
  }

  function markWindow(cacheKey: string, windowIndex: number, state: "partial" | "complete", updatedAt: number) {
    database.prepare(`INSERT INTO transcode_windows(cache_key,window_index,state,updated_at) VALUES(?,?,?,?) ON CONFLICT(cache_key,window_index) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`).run(cacheKey, windowIndex, state, updatedAt);
  }

  function window(cacheKey: string, windowIndex: number): TranscodeWindowRecord | null {
    const row = database.prepare("SELECT cache_key,window_index,state,updated_at FROM transcode_windows WHERE cache_key=? AND window_index=?").get(cacheKey, windowIndex) as Record<string, unknown> | undefined;
    return row ? { cacheKey: text(row.cache_key), windowIndex: integer(row.window_index), state: row.state === "complete" ? "complete" : "partial", updatedAt: integer(row.updated_at) } : null;
  }

  function deleteAsset(cacheKey: string) { database.prepare("DELETE FROM transcode_assets WHERE cache_key=?").run(cacheKey); }
  function lruCandidates() { return (database.prepare("SELECT cache_key, profile_id, duration_ms, segment_count, probe_json, total_bytes, last_accessed_at FROM transcode_assets ORDER BY last_accessed_at, cache_key").all() as Record<string, unknown>[]).map(decodeAsset); }
  function totalBytes() { return Number((database.prepare("SELECT COALESCE(SUM(total_bytes),0) AS total FROM transcode_assets").get() as { total: number | bigint }).total); }

  return {
    upsertProbe, loadAsset, recordSegment, segment, segments, deleteSegment, markWindow, window,
    touchAsset: (cacheKey, at) => { database.prepare("UPDATE transcode_assets SET last_accessed_at=? WHERE cache_key=?").run(at, cacheKey); },
    touchSegment: (cacheKey, segmentIndex, at) => { transaction(database, () => { database.prepare("UPDATE transcode_segments SET last_accessed_at=? WHERE cache_key=? AND segment_index=?").run(at, cacheKey, segmentIndex); database.prepare("UPDATE transcode_assets SET last_accessed_at=? WHERE cache_key=?").run(at, cacheKey); }); },
    deleteAsset, lruCandidates, totalBytes,
  };
}

export function parseProbe(value: unknown): MediaProbe {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PROBE_INVALID");
  const p = value as Record<string, unknown>;
  if (!positive(p.durationMs) || typeof p.container !== "string" || !p.container || typeof p.videoCodec !== "string" || !p.videoCodec || !(p.audioCodec === null || typeof p.audioCodec === "string") || !positive(p.width) || !positive(p.height) || !(p.pixelFormat === null || typeof p.pixelFormat === "string") || !(p.frameRate === null || (typeof p.frameRate === "number" && Number.isFinite(p.frameRate) && p.frameRate > 0))) throw new Error("PROBE_INVALID");
  return structuredClone(value) as MediaProbe;
}

function decodeAsset(row: Record<string, unknown>): TranscodeAssetRecord { return { cacheKey: text(row.cache_key), profileId: text(row.profile_id), durationMs: integer(row.duration_ms), segmentCount: integer(row.segment_count), probe: parseProbe(JSON.parse(text(row.probe_json))), totalBytes: integer(row.total_bytes), lastAccessedAt: integer(row.last_accessed_at) }; }
function decodeSegment(row: Record<string, unknown>): TranscodeSegmentRecord { return { cacheKey: text(row.cache_key), segmentIndex: integer(row.segment_index), windowIndex: integer(row.window_index), durationMs: integer(row.duration_ms), relativePath: text(row.relative_path), sizeBytes: integer(row.size_bytes), sha256: text(row.sha256), completedAt: integer(row.completed_at), lastAccessedAt: integer(row.last_accessed_at) }; }
function text(value: unknown) { if (typeof value !== "string") throw new Error("CATALOG_INVALID"); return value; }
function integer(value: unknown) { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error("CATALOG_INVALID"); return n; }
function positive(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function requireKey(value: string) { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("TRANSCODER_PATH_INVALID"); }
function transaction(database: DatabaseSync, operation: () => void) { database.exec("BEGIN IMMEDIATE"); try { operation(); database.exec("COMMIT"); } catch (error) { try { database.exec("ROLLBACK"); } catch { /* Preserve the original transaction failure. */ } throw error; } }
