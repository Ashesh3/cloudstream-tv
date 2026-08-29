import { describe, expect, it } from "vitest";
import {
  LiveBrowseError,
  TranscodeError,
  createControlRequestContextScope,
  createTranscodeSourceAuthorizer,
  type AuthenticatedControlDevice,
  type AuthorizedBrowseItem,
  type BrokeredProviderCredentials,
  type ControlPlaneStore,
} from "@cloudframe/server";
import type { ProviderAdapter, ProviderRegistry } from "@cloudframe/providers";
import { TEST_NOW, testControlDocument } from "./helpers/control-plane";

function harness() {
  let document = testControlDocument();
  const requestContext = createControlRequestContextScope();
  const store: ControlPlaneStore = {
    async load() { return { document: structuredClone(document), etag: `r${document.revision}` }; },
    async mutate() { throw new Error("unused"); },
  };
  const credentials: BrokeredProviderCredentials = {
    accessToken: "access-token",
    refreshToken: null,
    accessTokenExpiresAt: new Date(TEST_NOW.getTime() + 60_000),
    credentialVersion: 1,
  };
  const adapter: ProviderAdapter = {
    beginAuthorization: async () => unexpected(), completeAuthorization: async () => unexpected(), refreshCredentials: async () => unexpected(),
    getRoot: async () => unexpected(), listFolder: async () => unexpected(), getThumbnailUrl: async () => unexpected(), getMediaUrl: async () => unexpected(),
    async getNode(input) {
      return {
        providerNodeId: input.providerNodeId,
        parentProviderId: "provider-trips",
        name: "MOV00516.MPG",
        kind: "video",
        mimeType: "video/mpeg",
        size: 12_345,
        width: 640,
        height: 360,
        capturedAt: null,
        createdAt: null,
        modifiedAt: null,
        thumbnailRevision: "thumb-7",
        contentRevision: "revision-7",
        hasPreview: false,
      };
    },
  };
  const providers: ProviderRegistry = { get: () => adapter };
  const authorizer = createTranscodeSourceAuthorizer({
    controlStore: store,
    requestContext,
    credentialBroker: { get: async () => credentials, refresh: async () => credentials },
    providers,
    now: () => TEST_NOW,
  });

  function auth(): AuthenticatedControlDevice {
    const device = document.devices["device-1"]!;
    return {
      householdId: document.householdId,
      deviceId: device.id,
      sessionVersion: device.sessionVersion,
      device: structuredClone(device),
      context: { document, revision: document.revision },
    };
  }
  function item(overrides: Partial<AuthorizedBrowseItem["claims"]> = {}): AuthorizedBrowseItem {
    return {
      id: "item_video_1",
      source: document.sources["source-1"]!,
      root: document.roots["root-1"]!,
      claims: {
        version: 2,
        householdId: "h1",
        deviceId: "device-1",
        sourceId: "source-1",
        rootId: "root-1",
        rootProviderNodeId: "provider-trips",
        providerNodeId: "video-1",
        parentProviderNodeId: "provider-trips",
        kind: "video",
        name: "MOV00516.MPG",
        mimeType: "video/mpeg",
        size: 12_345,
        contentRevision: "revision-7",
        preview: null,
        credentialVersion: 1,
        issuedAt: TEST_NOW.getTime(),
        expiresAt: TEST_NOW.getTime() + 30 * 60_000,
        ...overrides,
      },
    };
  }
  return { authorizer, auth, item, get document() { return document; }, setDocument(next: typeof document) { document = next; } };
}

describe("transcode source authorization", () => {
  it("binds a video only from the current authenticated request context", () => {
    const current = harness();
    expect(current.authorizer.bind(current.auth(), current.item()).binding).toEqual({
      householdId: "h1",
      deviceId: "device-1",
      deviceSessionVersion: 1,
      sourceId: "source-1",
      rootId: "root-1",
      rootProviderNodeId: "provider-trips",
      providerNodeId: "video-1",
      provider: "google",
      itemId: "item_video_1",
      name: "MOV00516.MPG",
      mimeType: "video/mpeg",
      size: 12_345,
      contentRevision: "revision-7",
      credentialVersion: 1,
    });
  });

  it("rejects another device, non-video media, and identity without revision or size", () => {
    const current = harness();
    expect(() => current.authorizer.bind(current.auth(), current.item({ deviceId: "device-2" })))
      .toThrowError(new LiveBrowseError("ITEM_NOT_FOUND"));
    expect(() => current.authorizer.bind(current.auth(), current.item({ kind: "image", mimeType: "image/jpeg" })))
      .toThrowError(new TranscodeError("TRANSCODER_UNSUPPORTED"));
    expect(() => current.authorizer.bind(current.auth(), current.item({ contentRevision: null, size: null })))
      .toThrowError(new TranscodeError("TRANSCODER_UNSUPPORTED"));
  });

  it.each([
    ["revoked device", (document: ReturnType<typeof testControlDocument>) => { document.devices["device-1"]!.revokedAt = TEST_NOW.toISOString(); }, "DEVICE_UNAUTHORIZED"],
    ["disabled root", (document: ReturnType<typeof testControlDocument>) => { document.roots["root-1"]!.enabled = false; }, "ITEM_NOT_FOUND"],
    ["removed source", (document: ReturnType<typeof testControlDocument>) => { delete document.sources["source-1"]; }, "ITEM_NOT_FOUND"],
    ["reauth source", (document: ReturnType<typeof testControlDocument>) => { document.sources["source-1"]!.status = "reauth-required"; }, "ITEM_NOT_FOUND"],
    ["rotated credentials", (document: ReturnType<typeof testControlDocument>) => { document.sources["source-1"]!.credentialVersion = 2; }, "NAVIGATION_EXPIRED"],
  ] as const)("rejects current-state drift: %s", (_label, mutate, code) => {
    const current = harness();
    const source = current.authorizer.bind(current.auth(), current.item());
    mutate(current.document);
    expect(() => current.authorizer.validateCurrent(current.auth(), source.binding))
      .toThrowError(expect.objectContaining({ code }));
  });

  it("loads and validates one fresh context before provider-node reauthorization", async () => {
    const current = harness();
    const source = current.authorizer.bind(current.auth(), current.item());
    let contextVisible = false;

    const result = await current.authorizer.withReauthorizedItem(source.binding, async (item) => {
      contextVisible = item.claims.providerNodeId === "video-1";
      return item.claims.contentRevision;
    });

    expect(result).toBe("revision-7");
    expect(contextVisible).toBe(true);
  });

  it("expires the binding when the provider's current revision changes", async () => {
    const current = harness();
    const source = current.authorizer.bind(current.auth(), current.item());
    current.document.sources["source-1"]!.credentialVersion = 2;
    await expect(current.authorizer.withReauthorizedItem(source.binding, async () => undefined))
      .rejects.toMatchObject({ code: "NAVIGATION_EXPIRED" });
  });
});

function unexpected(): never { throw new Error("unexpected"); }
