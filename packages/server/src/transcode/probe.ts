import { parseProbe } from "./catalog.ts";
import { ProcessRunnerError, type ProcessRunner } from "./process-runner.ts";
import { TranscodeError, type MediaProbe } from "./types.ts";

export interface MediaProbeService { probe(inputUrl: string, signal: AbortSignal): Promise<MediaProbe>; }

export function createMediaProbeService(options: { runner: ProcessRunner; ffprobePath?: string; timeoutMs?: number }): MediaProbeService {
  return { async probe(inputUrl, signal) {
    let result;
    try { result = await options.runner.run(options.ffprobePath ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate", "-of", "json", inputUrl], { signal, timeoutMs: options.timeoutMs ?? 10_000, stdoutLimitBytes: 1024 * 1024 }); }
    catch (error) { if (error instanceof ProcessRunnerError && (error.code === "PROCESS_ABORTED" || error.code === "PROCESS_TIMEOUT")) throw new TranscodeError("TRANSCODER_SOURCE_UNAVAILABLE"); throw new TranscodeError("TRANSCODER_FAILED"); }
    if (result.exitCode !== 0) throw new TranscodeError("TRANSCODER_SOURCE_UNAVAILABLE");
    try {
      const value = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
      if (!value || Object.getPrototypeOf(value) !== Object.prototype || !Array.isArray(value.streams) || !value.format || typeof value.format !== "object") throw new Error();
      const streams = value.streams as Record<string, unknown>[];
      const videos = streams.filter((stream) => stream.codec_type === "video");
      if (videos.length !== 1) throw new TranscodeError("TRANSCODER_UNSUPPORTED");
      const video = videos[0]!;
      const audio = streams.find((stream) => stream.codec_type === "audio");
      const format = value.format as Record<string, unknown>;
      const durationSeconds = Number(format.duration);
      const durationMs = Math.round(durationSeconds * 1000);
      const width = Number(video.width); const height = Number(video.height);
      const frameRate = rate(video.avg_frame_rate ?? video.r_frame_rate);
      if (!Number.isFinite(durationSeconds) || durationMs < 1 || durationMs > 24 * 60 * 60 * 1000 || !Number.isSafeInteger(width) || width < 1 || width > 16_384 || !Number.isSafeInteger(height) || height < 1 || height > 16_384 || (frameRate !== null && frameRate > 240)) throw new TranscodeError("TRANSCODER_UNSUPPORTED");
      return parseProbe({ durationMs, container: bounded(format.format_name), videoCodec: bounded(video.codec_name), audioCodec: audio ? bounded(audio.codec_name) : null, width, height, pixelFormat: video.pix_fmt === undefined ? null : bounded(video.pix_fmt), frameRate });
    } catch (error) { if (error instanceof TranscodeError) throw error; throw new TranscodeError("TRANSCODER_FAILED"); }
  } };
}

function bounded(value: unknown) { if (typeof value !== "string" || value.length < 1 || value.length > 256) throw new Error(); return value; }
function rate(value: unknown): number | null { if (value === undefined || value === null || value === "0/0") return null; if (typeof value !== "string") throw new Error(); const match = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(value); if (!match) throw new Error(); const denominator = Number(match[2]); const result = denominator === 0 ? NaN : Number(match[1]) / denominator; if (!Number.isFinite(result) || result <= 0) throw new Error(); return result; }
