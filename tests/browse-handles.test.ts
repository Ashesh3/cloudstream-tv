import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createBrowseHandleCodec } from "@cloudframe/server";
import { TEST_NOW, testAeadKeyring } from "./helpers/control-plane";

describe("opaque browse handles", () => {
  it("binds a sealed media handle to one device, root, and credential version", () => {
    const codec = createBrowseHandleCodec(testAeadKeyring(), "id-secret", () => TEST_NOW);
    const handle = codec.sealItem({
      version: 2,
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      providerNodeId: "provider-secret",
      parentProviderNodeId: "parent-secret",
      kind: "video",
      name: "Lake.mp4",
      mimeType: "video/mp4",
      credentialVersion: 4,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    });

    expect(handle).not.toMatch(/provider-secret|parent-secret|Lake/);
    expect(codec.openItem(handle)).toMatchObject({
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      credentialVersion: 4
    });
    expect(codec.stableItemId("h1", "s1", "provider-secret")).toMatch(/^item_/);
  });

  it("seals provider cursors separately and expires items and cursors after 30 minutes", () => {
    let now = TEST_NOW;
    const codec = createBrowseHandleCodec(testAeadKeyring(), "id-secret", () => now);
    const item = codec.sealItem({
      version: 2,
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      providerNodeId: "folder-secret",
      parentProviderNodeId: null,
      kind: "folder",
      name: "Trips",
      mimeType: null,
      credentialVersion: 4,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 30 * 60_000
    });
    const cursor = codec.sealCursor({
      version: 2,
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      folderProviderNodeId: "folder-secret",
      providerCursor: "cursor-secret",
      credentialVersion: 4,
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + 30 * 60_000
    });

    expect(cursor).not.toMatch(/folder-secret|cursor-secret/);
    expect(codec.openCursor(cursor)).toMatchObject({
      folderProviderNodeId: "folder-secret",
      providerCursor: "cursor-secret"
    });
    expect(() => codec.openCursor(item)).toThrow(/invalid/i);
    expect(() => codec.openItem(cursor)).toThrow(/invalid/i);

    now = new Date(TEST_NOW.getTime() + 30 * 60_000);
    expect(() => codec.openItem(item)).toThrow(/invalid/i);
    expect(() => codec.openCursor(cursor)).toThrow(/invalid/i);
  });

  it("uses an unambiguous length-prefixed HMAC for stable item IDs", () => {
    const secret = "id-secret";
    const codec = createBrowseHandleCodec(testAeadKeyring(), secret, () => TEST_NOW);
    const expected = `item_${createHmac("sha256", secret)
      .update("2:h12:s115:provider-secret")
      .digest("base64url")}`;

    expect(codec.stableItemId("h1", "s1", "provider-secret")).toBe(expected);
    expect(codec.stableItemId("h", "1s1", "provider-secret")).not.toBe(expected);
  });

  it("rejects malformed item and cursor claims with one secret-safe error", () => {
    const codec = createBrowseHandleCodec(testAeadKeyring(), "id-secret", () => TEST_NOW);
    const base = {
      version: 2 as const,
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      providerNodeId: "node-1",
      parentProviderNodeId: null,
      kind: "video" as const,
      name: "Lake.mp4",
      mimeType: "video/mp4",
      credentialVersion: 4,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    };

    for (const claims of [
      { ...base, rootId: "" },
      { ...base, kind: "document" },
      { ...base, credentialVersion: 1.5 },
      { ...base, expiresAt: TEST_NOW.getTime() }
    ]) {
      expect(() => codec.sealItem(claims as typeof base)).toThrowError(
        expect.objectContaining({ code: "SEALED_VALUE_INVALID", message: "SEALED_VALUE_INVALID" })
      );
    }
  });
});
