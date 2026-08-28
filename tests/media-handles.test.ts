import {
  MEDIA_HANDLE_LIFETIME_MS,
  createMediaHandleCodec,
  sealJson,
} from "@cloudframe/server";
import { describe, expect, it } from "vitest";

import { TEST_NOW, testAeadKeyring } from "./helpers/control-plane";

describe("opaque media handles", () => {
  it("binds playback to one device, root, source, and credential version", () => {
    const codec = createMediaHandleCodec(testAeadKeyring(), () => TEST_NOW);
    const handle = codec.seal(claims());

    expect(handle).not.toMatch(/provider-secret|root-secret|Lake/);
    expect(codec.open(handle)).toMatchObject({
      householdId: "h1",
      deviceId: "d1",
      sourceId: "s1",
      rootId: "r1",
      providerNodeId: "provider-secret",
      credentialVersion: 4,
    });
  });

  it("expires after the dedicated playback lifetime", () => {
    let now = TEST_NOW;
    const codec = createMediaHandleCodec(testAeadKeyring(), () => now);
    const handle = codec.seal(claims());

    now = new Date(TEST_NOW.getTime() + 31 * 60_000);
    expect(codec.open(handle)).toMatchObject({ providerNodeId: "provider-secret" });
    now = new Date(TEST_NOW.getTime() + MEDIA_HANDLE_LIFETIME_MS);
    expect(() => codec.open(handle)).toThrow(/invalid/i);
  });

  it("rejects overlong or non-media claims", () => {
    const keyring = testAeadKeyring();
    const codec = createMediaHandleCodec(keyring, () => TEST_NOW);
    const base = claims();
    const overlong = { ...base, expiresAt: base.expiresAt + 1 };
    const overlongToken = sealJson("cloudframe/media-item/v1", overlong, keyring);

    expect(() => codec.seal(overlong)).toThrow(/invalid/i);
    expect(() => codec.open(overlongToken)).toThrow(/invalid/i);
    expect(() => codec.seal({ ...base, kind: "folder" } as never)).toThrow(/invalid/i);
  });
});

function claims() {
  return {
    version: 1 as const,
    householdId: "h1",
    deviceId: "d1",
    sourceId: "s1",
    rootId: "r1",
    rootProviderNodeId: "root-secret",
    providerNodeId: "provider-secret",
    parentProviderNodeId: "parent-secret",
    kind: "video" as const,
    name: "Lake.mp4",
    mimeType: "video/mp4",
    credentialVersion: 4,
    issuedAt: TEST_NOW.getTime(),
    expiresAt: TEST_NOW.getTime() + MEDIA_HANDLE_LIFETIME_MS,
  };
}
