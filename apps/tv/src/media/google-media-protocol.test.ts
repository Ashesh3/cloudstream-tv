import { describe, expect, it } from "vitest";
import {
  googleMediaAlias,
  googleMediaFingerprint,
  isExactGoogleMediaUrl,
  sanitizeMediaFilename,
  validSingleRange,
} from "./google-media-protocol";

const RAW_URL =
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true";

describe("Google media protocol helpers", () => {
  it("accepts only the exact Google Drive media boundary", () => {
    expect(isExactGoogleMediaUrl(RAW_URL)).toBe(true);
    expect(isExactGoogleMediaUrl(
      `${RAW_URL}&access_token=secret`,
    )).toBe(false);

    for (const value of [
      "https://drive.google.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
      "https://www.googleapis.com/drive/v3/files/file_123?alt=media",
      "https://www.googleapis.com/drive/v3/files/file_123?alt=media&alt=media&supportsAllDrives=true",
      "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=false",
      "https://www.googleapis.com/drive/v3/files/file_123/child?alt=media&supportsAllDrives=true",
      "https://user:pass@www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
      `${RAW_URL}#fragment`,
      `\n${RAW_URL}`,
      `${RAW_URL} `,
    ]) {
      expect(isExactGoogleMediaUrl(value)).toBe(false);
    }
  });

  it("parses one safe byte range while preserving its exact header", () => {
    expect(validSingleRange("bytes=0-")).toEqual({
      header: "bytes=0-", start: 0, end: null, suffixLength: null,
    });
    expect(validSingleRange("bytes=10-20")).toEqual({
      header: "bytes=10-20", start: 10, end: 20, suffixLength: null,
    });
    expect(validSingleRange("bytes=-25")).toEqual({
      header: "bytes=-25", start: null, end: null, suffixLength: 25,
    });

    for (const value of [
      "bytes=0-1,10-20",
      "items=0-1",
      "bytes=-",
      "bytes=-0",
      "bytes=20-10",
      "bytes=9007199254740992-",
      " bytes=0-1",
    ]) {
      expect(validSingleRange(value)).toBeNull();
    }
    expect(validSingleRange(null)).toBeNull();
  });

  it("sanitizes the filename segment used by the reserved alias", () => {
    expect(sanitizeMediaFilename("../MOV00516.MPG")).toBe("MOV00516.MPG");
    expect(sanitizeMediaFilename("folder\\clip name.mpg")).toBe("clip name.mpg");
    expect(googleMediaAlias("session_abc", "MOV00516.MPG"))
      .toBe("/__cloudframe_media__/session_abc/MOV00516.MPG");
    expect(googleMediaAlias("session_abc", "clip name.mpg"))
      .toBe("/__cloudframe_media__/session_abc/clip%20name.mpg");
    expect(sanitizeMediaFilename("clip-\ud800.mpg")).toBe("clip-�.mpg");
    expect(googleMediaAlias("session_abc", "clip-\ud800.mpg"))
      .toBe("/__cloudframe_media__/session_abc/clip-%EF%BF%BD.mpg");
  });

  it("creates a stable opaque SHA-256 URL fingerprint", async () => {
    const first = await googleMediaFingerprint(RAW_URL);
    const again = await googleMediaFingerprint(RAW_URL);
    const other = await googleMediaFingerprint(
      "https://www.googleapis.com/drive/v3/files/file_456?alt=media&supportsAllDrives=true",
    );
    expect(first).toBe(again);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toContain("file_123");
  });
});
