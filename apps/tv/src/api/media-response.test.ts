import { describe, expect, it } from "vitest";
import { decodeDirectMediaUrlResponse } from "./media-response";

const expiresAt = new Date(Date.now() + 60_000).toISOString();

describe("TV media response decoder", () => {
  it("accepts an exact Google bearer descriptor", () => {
    expect(decodeDirectMediaUrlResponse({
      itemId: "item_video",
      kind: "video",
      transport: "google-bearer",
      url: "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
      authorization: { scheme: "Bearer", token: "ya29.test-token" },
      expiresAt,
      revision: null,
    }, { itemId: "item_video", kind: "video" })).not.toBeNull();
  });

  it.each([
    ["token query", "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true&access_token=secret"],
    ["wrong host", "https://drive.google.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true"],
    ["extra query", "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true&x=1"],
  ])("rejects a Google descriptor with %s", (_label, url) => {
    expect(decodeDirectMediaUrlResponse({
      itemId: "item_video",
      kind: "video",
      transport: "google-bearer",
      url,
      authorization: { scheme: "Bearer", token: "ya29.test-token" },
      expiresAt,
      revision: null,
    }, { itemId: "item_video", kind: "video" })).toBeNull();
  });

  it.each([
    ["an access_token query", "https://provider.example/video?access_token=secret"],
    ["a Google Drive media endpoint", "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true"],
  ])("rejects a direct descriptor with %s", (_label, url) => {
    expect(decodeDirectMediaUrlResponse({
      itemId: "item_video",
      kind: "video",
      transport: "direct",
      url,
      expiresAt,
      revision: null,
    }, { itemId: "item_video", kind: "video" })).toBeNull();
  });

  it("rejects expired, malformed, mismatched, or extra credential fields", () => {
    const base = {
      itemId: "item_video",
      kind: "video",
      transport: "google-bearer",
      url: "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
      authorization: { scheme: "Bearer", token: "ya29.test-token", extra: true },
      expiresAt: new Date(Date.now() - 1).toISOString(),
      revision: null,
    };
    expect(decodeDirectMediaUrlResponse(base, { itemId: "item_other", kind: "video" })).toBeNull();
  });
});
