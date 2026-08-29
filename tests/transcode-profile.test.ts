import { describe, expect, it } from "vitest";
import {
  TRANSCODE_PROFILE,
  cacheIdentity,
  transcodeProfile,
  type TranscodeSourceBinding,
} from "@cloudframe/server";

const binding: TranscodeSourceBinding = {
  householdId: "household-1",
  deviceId: "device-1",
  deviceSessionVersion: 1,
  sourceId: "source-1",
  rootId: "root-1",
  rootProviderNodeId: "provider-root",
  providerNodeId: "provider-video",
  provider: "google",
  itemId: "item-public",
  name: "MOV00516.MPG",
  mimeType: "video/mpeg",
  size: 12_345,
  contentRevision: "revision-1",
  credentialVersion: 1,
};

describe("transcode profile and identity", () => {
  it("declares the exact one-TV H.264/AAC profile", () => {
    expect(TRANSCODE_PROFILE).toEqual({
      id: "h264-aac-1080p-v1",
      segmentDurationMs: 4_000,
      segmentsPerWindow: 5,
      windowDurationMs: 20_000,
      maxWidth: 1_920,
      maxHeight: 1_080,
      maxFrameRate: 30,
      threads: "auto",
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
    });
    expect(transcodeProfile(4)).toMatchObject({ threads: 4 });
    expect(TRANSCODE_PROFILE.threads).toBe("auto");
  });

  it("hashes stable media identity and ignores presentation/session fields", () => {
    const identity = cacheIdentity(binding, TRANSCODE_PROFILE);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).toBe(cacheIdentity({ ...binding }, TRANSCODE_PROFILE));
    expect(cacheIdentity({ ...binding, contentRevision: "revision-2" }, TRANSCODE_PROFILE)).not.toBe(identity);
    expect(cacheIdentity({ ...binding, size: 12_346 }, TRANSCODE_PROFILE)).not.toBe(identity);
    expect(cacheIdentity({ ...binding, name: "renamed.mpg" }, TRANSCODE_PROFILE)).toBe(identity);
    expect(cacheIdentity({ ...binding, deviceId: "device-2", deviceSessionVersion: 9 }, TRANSCODE_PROFILE)).toBe(identity);
    expect(cacheIdentity(binding, transcodeProfile(1))).toBe(cacheIdentity(binding, transcodeProfile(8)));
  });
});
