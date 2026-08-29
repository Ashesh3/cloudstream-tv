import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TranscodeCache } from "./cache.ts";
import type { TranscodeCatalog } from "./catalog.ts";
import type { ProcessRunner } from "./process-runner.ts";
import { ProcessRunnerError } from "./process-runner.ts";
import type { TranscodeProfile } from "./profile.ts";
import type { TranscodeSourceGateway } from "./source-gateway.ts";
import { TranscodeError, type MediaProbe, type TranscodeSourceBinding } from "./types.ts";

export interface TranscodeProgress { frame: number | null; outTimeMs: number | null; speed: string | null; progress: string | null; }
export interface EncodeWindowInput { jobId: string; cacheKey: string; binding: TranscodeSourceBinding; probe: MediaProbe; windowIndex: number; signal: AbortSignal; onProgress?: (progress: TranscodeProgress) => void; onSegmentPromoted?: (segmentIndex: number) => void; }
export interface EncodeWindowResult { cacheKey: string; windowIndex: number; completedSegmentIndices: number[]; complete: boolean; }
export interface WindowEncoder { encode(input: EncodeWindowInput): Promise<EncodeWindowResult>; }

export function createWindowEncoder(options: { runner: ProcessRunner; gateway: TranscodeSourceGateway; cache: TranscodeCache; catalog: TranscodeCatalog; profile: TranscodeProfile; ffmpegPath?: string; firstSegmentTimeoutMs: number }): WindowEncoder {
  return { encode };
  async function encode(input: EncodeWindowInput): Promise<EncodeWindowResult> {
    const { profile } = options;
    const firstSegment = input.windowIndex * profile.segmentsPerWindow;
    const startMs = firstSegment * profile.segmentDurationMs;
    const remainingMs = input.probe.durationMs - startMs;
    if (!Number.isSafeInteger(input.windowIndex) || input.windowIndex < 0 || remainingMs <= 0) throw new TranscodeError("TRANSCODER_UNSUPPORTED");
    const encodeMs = Math.min(profile.windowDurationMs, remainingMs);
    const expectedCount = Math.ceil(encodeMs / profile.segmentDurationMs);
    const expected = Array.from({ length: expectedCount }, (_, index) => firstSegment + index);
    const completed = new Set<number>();
    const releasePin = options.cache.pinGenerating(input.cacheKey, input.windowIndex);
    options.catalog.markWindow(input.cacheKey, input.windowIndex, "partial", Date.now());
    await mkdir(options.cache.stagingJobDirectory(input.jobId), { recursive: true });
    const grant = options.gateway.grant(input.binding, input.jobId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    let firstPromoted = false;
    let timedOut = false;
    const timeout = setTimeout(() => { if (!firstPromoted) { timedOut = true; controller.abort(); } }, options.firstSegmentTimeoutMs);
    let promotionChain = Promise.resolve();
    const outputPattern = join(options.cache.stagingJobDirectory(input.jobId), "%d.ts.part");
    const progress: TranscodeProgress = { frame: null, outTimeMs: null, speed: null, progress: null };
    try {
      const args = ffmpegArgs(grant.inputUrl, outputPattern, firstSegment, startMs, encodeMs, profile);
      const result = await options.runner.run(options.ffmpegPath ?? "ffmpeg", args, {
        signal: controller.signal,
        timeoutMs: Math.max(options.firstSegmentTimeoutMs, encodeMs * 10),
        cwd: options.cache.stagingJobDirectory(input.jobId),
        onStdoutLine: (line) => {
          const parsed = csvSegment(line, expected);
          if (!parsed) return;
          promotionChain = promotionChain.then(async () => {
            const part = join(options.cache.stagingJobDirectory(input.jobId), `${parsed.index}.ts.part`);
            const temp = options.cache.stagingSegmentPath(input.jobId, parsed.index);
            await rename(part, temp);
            await options.cache.promoteSegment({ jobId: input.jobId, cacheKey: input.cacheKey, segmentIndex: parsed.index, windowIndex: input.windowIndex, durationMs: parsed.durationMs });
            completed.add(parsed.index); firstPromoted = true; clearTimeout(timeout); input.onSegmentPromoted?.(parsed.index);
          });
        },
        onStderrLine: (line) => { const [key, value] = line.split("=", 2); if (key === "frame") progress.frame = boundedNumber(value); else if (key === "out_time_ms") progress.outTimeMs = boundedNumber(value); else if (key === "speed") progress.speed = boundedText(value); else if (key === "progress") progress.progress = boundedText(value); else return; input.onProgress?.({ ...progress }); },
      });
      await promotionChain;
      if (result.exitCode !== 0) throw new TranscodeError("TRANSCODER_FAILED");
      for (const index of expected) {
        if (!completed.has(index)) {
          const part = join(options.cache.stagingJobDirectory(input.jobId), `${index}.ts.part`);
          try { const metadata = await stat(part); if (metadata.size > 0) { await rename(part, options.cache.stagingSegmentPath(input.jobId, index)); await options.cache.promoteSegment({ jobId: input.jobId, cacheKey: input.cacheKey, segmentIndex: index, windowIndex: input.windowIndex, durationMs: Math.min(profile.segmentDurationMs, input.probe.durationMs - index * profile.segmentDurationMs) }); completed.add(index); input.onSegmentPromoted?.(index); } } catch { /* Missing final part is checked against the catalog below. */ }
        }
      }
      if (!expected.every((index) => options.catalog.segment(input.cacheKey, index) !== null)) throw new TranscodeError("TRANSCODER_FAILED");
      options.catalog.markWindow(input.cacheKey, input.windowIndex, "complete", Date.now());
      return { cacheKey: input.cacheKey, windowIndex: input.windowIndex, completedSegmentIndices: [...completed].sort((a, b) => a - b), complete: true };
    } catch (error) {
      await promotionChain.catch(() => undefined);
      options.catalog.markWindow(input.cacheKey, input.windowIndex, "partial", Date.now());
      if (timedOut) throw new TranscodeError("TRANSCODER_WINDOW_TIMEOUT");
      if (error instanceof TranscodeError) throw error;
      if (error instanceof ProcessRunnerError) throw new TranscodeError("TRANSCODER_FAILED");
      throw new TranscodeError("TRANSCODER_FAILED");
    } finally {
      clearTimeout(timeout); input.signal.removeEventListener("abort", abort); grant.revoke(); releasePin(); await rm(options.cache.stagingJobDirectory(input.jobId), { recursive: true, force: true });
    }
  }
}

function ffmpegArgs(inputUrl: string, output: string, firstSegment: number, startMs: number, encodeMs: number, profile: TranscodeProfile): string[] { return ["-hide_banner", "-nostdin", "-loglevel", "warning", "-ss", seconds(startMs), "-i", inputUrl, "-t", seconds(encodeMs), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", profile.videoCodec, "-preset", profile.preset, "-crf", String(profile.crf), "-profile:v", profile.videoProfile, "-level:v", profile.videoLevel, "-pix_fmt", profile.pixelFormat, "-vf", `fps=fps='min(source_fps,${profile.maxFrameRate})',scale=w='min(${profile.maxWidth},iw)':h='min(${profile.maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`, "-c:a", profile.audioCodec, "-b:a", profile.audioBitrate, "-ac", String(profile.maxAudioChannels), ...(profile.threads === "auto" ? [] : ["-threads", String(profile.threads)]), "-force_key_frames", `expr:gte(t,n_forced*${profile.segmentDurationMs / 1000})`, "-progress", "pipe:2", "-stats_period", "0.5", "-f", "segment", "-segment_format", "mpegts", "-segment_time", String(profile.segmentDurationMs / 1000), "-reset_timestamps", "1", "-segment_start_number", String(firstSegment), "-segment_list", "pipe:1", "-segment_list_type", "csv", "-segment_list_size", "0", output]; }
function seconds(ms: number) { return (ms / 1000).toFixed(3); }
function csvSegment(line: string, expected: number[]) { const fields = line.split(","); if (fields.length < 3) return null; const match = /^(\d+)\.ts\.part$/.exec(basename(fields[0]!)); const start = Number(fields[1]); const end = Number(fields[2]); if (!match || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null; const index = Number(match[1]); if (!expected.includes(index)) return null; return { index, durationMs: Math.round((end - start) * 1000) }; }
function boundedNumber(value: string | undefined) { const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function boundedText(value: string | undefined) { return value && value.length <= 32 ? value : null; }
