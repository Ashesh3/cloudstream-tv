import { describe, expect, it } from "vitest";
import { renderMasterPlaylist, renderMediaPlaylist, transcodeProfile, type MediaProbe } from "@cloudframe/server";

const probe: MediaProbe = { durationMs: 43_250, container: "mpeg", videoCodec: "mpeg2video", audioCodec: "mp2", width: 640, height: 360, pixelFormat: "yuv420p", frameRate: 25 };

describe("complete HLS manifests", () => {
  it("renders every VOD segment with discontinuities and the shortened tail", () => {
    const playlist = renderMediaPlaylist(probe, transcodeProfile("auto"));
    expect(playlist).toContain("#EXT-X-TARGETDURATION:4");
    expect(playlist.match(/^segments\/\d+\.ts$/gm)).toHaveLength(11);
    expect(playlist.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
    expect(playlist).toContain("#EXTINF:3.250,\nsegments/10.ts");
    expect(playlist.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
    expect(playlist).not.toMatch(/https?:|\\|\.\./);
  });

  it("renders one relative master rendition with bounded metadata", () => {
    const withAudio = renderMasterPlaylist("session-1", probe, transcodeProfile(4));
    expect(withAudio).toContain('CODECS="avc1.640029,mp4a.40.2"');
    expect(withAudio).toContain("RESOLUTION=640x360");
    expect(withAudio).toContain("stream.m3u8\n");
    expect(withAudio).not.toContain("session-1");
    expect(renderMasterPlaylist("session-1", { ...probe, audioCodec: null }, transcodeProfile(4)))
      .toContain('CODECS="avc1.640029"');
  });
});
