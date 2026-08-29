import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createBrowseHandleCodec, sealJson } from "@cloudframe/server";
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
      rootProviderNodeId: "root-secret",
      providerNodeId: "provider-secret",
      parentProviderNodeId: "parent-secret",
      kind: "video",
      name: "Lake.mp4",
      mimeType: "video/mp4",
      preview: {
        url: "https://public.dm.files.1drv.com/y4m/lake?authkey=preview-secret",
        expiresAt: TEST_NOW.getTime() + 20 * 60_000
      },
      credentialVersion: 4,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    });

    expect(handle).not.toMatch(/root-secret|provider-secret|parent-secret|Lake|preview-secret/);
    expect(codec.openItem(handle)).toMatchObject({
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      credentialVersion: 4,
      preview: {
        url: "https://public.dm.files.1drv.com/y4m/lake?authkey=preview-secret",
        expiresAt: TEST_NOW.getTime() + 20 * 60_000
      }
    });
    expect(codec.stableItemId("h1", "s1", "provider-secret")).toMatch(/^item_/);
  });

  it("opens old item handles without a preview as preview null", () => {
    const keyring = testAeadKeyring();
    const codec = createBrowseHandleCodec(keyring, "id-secret", () => TEST_NOW);
    const oldHandle = sealJson(
      "cloudframe/browse-item/v2",
      {
        version: 2,
        householdId: "h1",
        deviceId: "d1",
        sourceId: "s1",
        rootId: "r1",
        rootProviderNodeId: "root-secret",
        providerNodeId: "provider-secret",
        parentProviderNodeId: "parent-secret",
        kind: "image",
        name: "Old.jpg",
        mimeType: "image/jpeg",
        credentialVersion: 4,
        issuedAt: TEST_NOW.getTime(),
        expiresAt: TEST_NOW.getTime() + 30 * 60_000
      },
      keyring
    );

    expect(codec.openItem(oldHandle)).toMatchObject({ preview: null });
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
      rootProviderNodeId: "root-secret",
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
      rootProviderNodeId: "root-secret",
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

  it("rejects provider cursors whose lifetime exceeds 30 minutes", () => {
    const keyring = testAeadKeyring();
    const codec = createBrowseHandleCodec(keyring, "id-secret", () => TEST_NOW);
    const claims = {
      version: 2 as const,
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      rootProviderNodeId: "root-secret",
      folderProviderNodeId: "folder-secret",
      providerCursor: "cursor-secret",
      credentialVersion: 4,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    };
    const overlong = { ...claims, expiresAt: claims.expiresAt + 1 };
    const overlongToken = sealJson("cloudframe/browse-cursor/v2", overlong, keyring);

    expect(codec.openCursor(codec.sealCursor(claims))).toMatchObject(claims);
    expect.soft(() => codec.sealCursor(overlong)).toThrowError(
      expect.objectContaining({ code: "SEALED_VALUE_INVALID", message: "SEALED_VALUE_INVALID" })
    );
    expect.soft(() => codec.openCursor(overlongToken)).toThrowError(
      expect.objectContaining({ code: "SEALED_VALUE_INVALID", message: "SEALED_VALUE_INVALID" })
    );
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
      rootProviderNodeId: "root-secret",
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
      { ...base, expiresAt: TEST_NOW.getTime() },
      { ...base, preview: { url: "http://provider.example/preview", expiresAt: TEST_NOW.getTime() + 1 } },
      { ...base, preview: { url: `https://provider.example/${"x".repeat(4097)}`, expiresAt: TEST_NOW.getTime() + 1 } },
      { ...base, preview: { url: "https://provider.example/preview", expiresAt: 1.5 } }
    ]) {
      expect(() => codec.sealItem(claims as typeof base)).toThrowError(
        expect.objectContaining({ code: "SEALED_VALUE_INVALID", message: "SEALED_VALUE_INVALID" })
      );
    }
  });

  it("requires and preserves the encrypted root provider identity on items and cursors", () => {
    const keyring = testAeadKeyring();
    const codec = createBrowseHandleCodec(keyring, "id-secret", () => TEST_NOW);
    const common = {
      version: 2 as const,
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      credentialVersion: 4,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    };

    expect(
      codec.openItem(
        codec.sealItem({
          ...common,
          rootProviderNodeId: "root-secret",
          providerNodeId: "child-secret",
          parentProviderNodeId: "parent-secret",
          kind: "folder",
          name: "Child",
          mimeType: null
        } as never)
      )
    ).toMatchObject({ rootProviderNodeId: "root-secret" });
    expect(
      codec.openCursor(
        codec.sealCursor({
          ...common,
          rootProviderNodeId: "root-secret",
          folderProviderNodeId: "child-secret",
          providerCursor: "cursor-secret"
        } as never)
      )
    ).toMatchObject({ rootProviderNodeId: "root-secret" });

    const itemWithoutRootIdentity = sealJson(
      "cloudframe/browse-item/v2",
      {
        ...common,
        providerNodeId: "child-secret",
        parentProviderNodeId: "parent-secret",
        kind: "folder",
        name: "Child",
        mimeType: null
      },
      keyring
    );
    const cursorWithoutRootIdentity = sealJson(
      "cloudframe/browse-cursor/v2",
      {
        ...common,
        folderProviderNodeId: "child-secret",
        providerCursor: "cursor-secret"
      },
      keyring
    );

    expect(() => codec.openItem(itemWithoutRootIdentity)).toThrowError(
      expect.objectContaining({ code: "SEALED_VALUE_INVALID" })
    );
    expect(() => codec.openCursor(cursorWithoutRootIdentity)).toThrowError(
      expect.objectContaining({ code: "SEALED_VALUE_INVALID" })
    );
  });
});
