import type { TranscodeProfile } from "./profile.ts";
import type { MediaProbe } from "./types.ts";

export function renderMasterPlaylist(_sessionId: string, probe: MediaProbe, profile: TranscodeProfile): string {
  const width = Math.min(probe.width, profile.maxWidth);
  const height = Math.min(probe.height, profile.maxHeight);
  const codecs = probe.audioCodec === null ? "avc1.640029" : "avc1.640029,mp4a.40.2";
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=3000000,RESOLUTION=${width}x${height},CODECS="${codecs}"\nstream.m3u8\n`;
}

export function renderMediaPlaylist(probe: MediaProbe, profile: TranscodeProfile): string {
  const count = Math.ceil(probe.durationMs / profile.segmentDurationMs);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${Math.ceil(profile.segmentDurationMs / 1000)}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && index % profile.segmentsPerWindow === 0) lines.push("#EXT-X-DISCONTINUITY");
    const duration = index === count - 1 ? probe.durationMs - index * profile.segmentDurationMs : profile.segmentDurationMs;
    lines.push(`#EXTINF:${(duration / 1000).toFixed(3)},`, `segments/${index}.ts`);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}
