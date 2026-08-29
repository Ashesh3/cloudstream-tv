import { createHash } from "node:crypto";
import type { TranscodeSourceBinding } from "./types.ts";

export interface TranscodeProfile {
  id: "h264-aac-1080p-v1";
  segmentDurationMs: 4000;
  segmentsPerWindow: 5;
  windowDurationMs: 20000;
  maxWidth: 1920;
  maxHeight: 1080;
  maxFrameRate: 30;
  threads: number | "auto";
  videoCodec: "libx264";
  videoProfile: "high";
  videoLevel: "4.1";
  pixelFormat: "yuv420p";
  crf: 22;
  preset: "veryfast";
  audioCodec: "aac";
  audioBitrate: "160k";
  maxAudioChannels: 2;
  upscale: false;
}

export function transcodeProfile(threads: number | "auto"): TranscodeProfile {
  return {
    id: "h264-aac-1080p-v1",
    segmentDurationMs: 4_000,
    segmentsPerWindow: 5,
    windowDurationMs: 20_000,
    maxWidth: 1_920,
    maxHeight: 1_080,
    maxFrameRate: 30,
    threads,
    videoCodec: "libx264",
    videoProfile: "high",
    videoLevel: "4.1",
    pixelFormat: "yuv420p",
    crf: 22,
    preset: "veryfast",
    audioCodec: "aac",
    audioBitrate: "160k",
    maxAudioChannels: 2,
    upscale: false,
  };
}

export const TRANSCODE_PROFILE = Object.freeze(transcodeProfile("auto"));

export function cacheIdentity(
  binding: TranscodeSourceBinding,
  profile: TranscodeProfile,
): string {
  const values: Array<string | null> = [
    binding.householdId,
    binding.provider,
    binding.sourceId,
    binding.providerNodeId,
    binding.contentRevision,
    binding.size === null ? null : String(binding.size),
    profile.id,
  ];
  const encoded = values.map((value) =>
    value === null ? "n:" : `s:${Buffer.byteLength(value, "utf8")}:${value}`
  ).join("");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}
