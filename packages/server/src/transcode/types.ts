import type { ProviderKind } from "@cloudframe/shared";

export interface TranscodeSourceBinding {
  householdId: string;
  deviceId: string;
  deviceSessionVersion: number;
  sourceId: string;
  rootId: string;
  rootProviderNodeId: string;
  providerNodeId: string;
  provider: ProviderKind;
  itemId: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  contentRevision: string | null;
  credentialVersion: number;
}

export interface MediaProbe {
  durationMs: number;
  container: string;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  pixelFormat: string | null;
  frameRate: number | null;
}

export type TranscodeErrorCode =
  | "TRANSCODER_BUSY"
  | "TRANSCODER_CACHE_FULL"
  | "TRANSCODER_FAILED"
  | "TRANSCODER_PATH_INVALID"
  | "TRANSCODER_SESSION_EXPIRED"
  | "TRANSCODER_SOURCE_UNAVAILABLE"
  | "TRANSCODER_UNSUPPORTED"
  | "TRANSCODER_WINDOW_TIMEOUT";

export class TranscodeError extends Error {
  constructor(readonly code: TranscodeErrorCode) {
    super(code);
    this.name = "TranscodeError";
  }
}

export interface TranscodeSegmentFile {
  path: string;
  sizeBytes: number;
  sha256: string;
  durationMs: number;
  segmentIndex: number;
}
