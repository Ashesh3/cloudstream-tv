import { describe, expect, it, vi } from "vitest";

import type { Device, Household, MediaNode, Source } from "@cloudframe/shared";
import type { ProviderAdapter, ProviderCredentials, ProviderRegistry } from "@cloudframe/providers";
import {
  MemoryRepository,
  createBrowseService,
  createMediaUrlService,
  IndexingUnavailableError
} from "@cloudframe/server";
import { deterministicNodeId } from "@cloudframe/indexer";

const now = new Date("2026-08-26T00:00:00.000Z");
const expiry = new Date("2026-08-26T00:45:00.000Z");

describe("direct provider URL vending", () => {
  it("returns direct media URLs with private no-store/no-referrer metadata and never logs or persists them", async () => {
    const harness = await fixture();
    const before = await harness.repository.getSource("s1");
    const result = await harness.service.media(harness.device, harness.household, harness.mediaNode.id);
    expect(result).toMatchObject({ url: "https://provider.test/media?secret=token", expiresAt: expiry, revision: "r1" });
    expect(result.responseHeaders).toMatchObject({ "cache-control": "private, no-store", "referrer-policy": "no-referrer" });
    expect(harness.logger.info).not.toHaveBeenCalledWith(expect.stringContaining("secret"));
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("secret=token");
    expect(await harness.repository.getSource("s1")).toEqual(before);
  });

  it("rejects folders, unavailable nodes, and nodes outside current assigned roots", async () => {
    const harness = await fixture();
    await expect(harness.service.media(harness.device, harness.household, harness.rootNode.id)).rejects.toMatchObject({ code: "MEDIA_NOT_AVAILABLE" });
    await expect(harness.service.media(harness.device, harness.household, harness.outsideNode.id)).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
    await harness.repository.putNode({ ...harness.mediaNode, available: false });
    await expect(harness.service.media(harness.device, harness.household, harness.mediaNode.id)).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
  });

  it("returns a bounded thumbnail batch with safe partial unavailable entries", async () => {
    const harness = await fixture();
    const result = await harness.service.thumbnails(harness.device, harness.household, [harness.mediaNode.id, "missing"], 720);
    expect(result.items).toEqual([
      { nodeId: harness.mediaNode.id, status: "ready", url: "https://provider.test/thumb?secret=token", expiresAt: expiry, revision: "r1" },
      { nodeId: "missing", status: "unavailable" }
    ]);
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("secret=token");
    await expect(
      harness.service.thumbnails(harness.device, harness.household, Array.from({ length: 101 }, (_, index) => `n${index}`), 720)
    ).rejects.toMatchObject({ code: "THUMBNAIL_BATCH_TOO_LARGE" });
  });

  it("does not call providers for non-preview nodes", async () => {
    const harness = await fixture();
    await harness.repository.putNode({ ...harness.mediaNode, hasPreview: false });
    const result = await harness.service.thumbnails(harness.device, harness.household, [harness.mediaNode.id], 720);
    expect(result.items).toEqual([{ nodeId: harness.mediaNode.id, status: "unavailable" }]);
    expect(harness.adapter.getThumbnailUrl).not.toHaveBeenCalled();
  });

  it("refreshes credentials through the source service rather than reading tokens directly", async () => {
    const harness = await fixture();
    await harness.service.media(harness.device, harness.household, harness.mediaNode.id);
    expect(harness.sourceService.getUsableCredentials).toHaveBeenCalledWith("s1", "h1");
    expect(harness.adapter.getMediaUrl).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ accessToken: "fresh-access" })
    }));
  });

  it("applies the existing fixed-window limiter at the HTTP media endpoint", async () => {
    const harness = await fixture();
    const app = harness.createApp({ "url-vending": { limit: 1, windowSeconds: 60 } });
    const first = await app(harness.request("/api/tv/media-url", { nodeId: harness.mediaNode.id }));
    const second = await app(harness.request("/api/tv/media-url", { nodeId: harness.mediaNode.id }));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(second.status).toBe(429);
  });

  it("reports untransformed indexing as a stable 503 instead of a generic 500", async () => {
    const harness = await fixture();
    const { createApiApp } = await import("@cloudframe/server");
    const app = createApiApp({
      repository: harness.repository,
      indexing: {
        startDueSources: async () => { throw new IndexingUnavailableError(); },
        startSource: async () => { throw new IndexingUnavailableError(); }
      },
      config: { householdId: "h1", passphrasePepper: "pepper", csrfSecret: "csrf", allowedOrigin: "https://app.test" },
      now: () => now
    });
    const response = await app(new Request("https://app.test/api/internal/sync-due-sources", { headers: { authorization: "Bearer x" } }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "INDEXING_UNAVAILABLE" });
  });

  it("rejects non-boolean and coerced watch-history wire values", async () => {
    const harness = await fixture();
    const { createApiApp } = await import("@cloudframe/server");
    const browse = createBrowseService({ repository: harness.repository, cursorSecret: "cursor-secret", now: () => now });
    const app = createApiApp({ repository: harness.repository, browse, config: { householdId: "h1", passphrasePepper: "pepper", csrfSecret: "csrf", allowedOrigin: "https://app.test" }, now: () => now });
    const response = await app(new Request(`https://app.test/api/tv/watch-history/${harness.mediaNode.id}`, {
      method: "PUT",
      headers: { cookie: "device_session=device-token", "content-type": "application/json" },
      body: JSON.stringify({ positionSeconds: "1", durationSeconds: 10, completed: 0 })
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_HISTORY" });
  });

  it("returns wire-safe TV home and folder JSON without persistence-only root fields", async () => {
    const harness = await fixture();
    const { createApiApp } = await import("@cloudframe/server");
    const browse = createBrowseService({ repository: harness.repository, cursorSecret: "cursor-secret", now: () => now });
    const app = createApiApp({ repository: harness.repository, browse, config: { householdId: "h1", passphrasePepper: "pepper", csrfSecret: "csrf", allowedOrigin: "https://app.test" }, now: () => now });
    const home = await app(new Request("https://app.test/api/tv/home", { headers: { cookie: "device_session=device-token" } }));
    const homeJson = JSON.stringify(await home.json());
    expect(homeJson).not.toContain("householdId");
    expect(homeJson).not.toContain("providerNodeId");
    expect(homeJson).toContain(harness.rootNode.id);
    const folder = await app(new Request(`https://app.test/api/tv/folders/${harness.rootNode.id}`, { headers: { cookie: "device_session=device-token" } }));
    const folderJson = JSON.stringify(await folder.json());
    expect(folderJson).toContain(now.toISOString());
  });
});

async function fixture() {
  const repository = new MemoryRepository();
  const household: Household = { id: "h1", createdAt: now, allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 10, adminPassphraseHash: "hash", adminPassphraseVersion: 1 };
  const device: Device = { id: "d1", householdId: "h1", name: "TV", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, lastSeenAt: now, revokedAt: null };
  const source: Source = { id: "s1", householdId: "h1", provider: "google", providerAccountId: "account", providerRootId: null, accountLabel: "Family", encryptedRefreshToken: { keyVersion: "1", iv: "iv", ciphertext: "refresh", authTag: "tag" }, encryptedAccessToken: null, accessTokenExpiresAt: null, status: "healthy", deltaCursor: null, crawlCheckpoint: null, activeWorkflowRunId: null, syncGeneration: null, nextSyncAt: null, leaseOwner: null, leaseExpiresAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null, createdAt: now };
  await repository.putHousehold(household); await repository.putDevice(device); await repository.putSource(source);
  await repository.putRoot({ id: "root-1", householdId: "h1", sourceId: "s1", providerNodeId: "root", displayName: "Family", ancestryProviderIds: [], enabled: true, createdAt: now });
  const rootNode = node("root", "folder", null, []);
  const mediaNode = node("movie", "video", rootNode.id, [rootNode.id]);
  const outsideNode = node("outside", "image", null, []);
  await repository.putNode(rootNode); await repository.putNode(mediaNode); await repository.putNode(outsideNode);
  await repository.putDeviceSession({ id: "session-1", householdId: "h1", deviceId: "d1", tokenHash: "session-hash", createdAt: now, lastSeenAt: now, expiresAt: new Date("2027-08-26T00:00:00Z"), revokedAt: null });

  const credentials: ProviderCredentials = { accessToken: "fresh-access", refreshToken: "refresh", accessTokenExpiresAt: expiry };
  const adapter = {
    getMediaUrl: vi.fn(async () => ({ url: "https://provider.test/media?secret=token", expiresAt: expiry })),
    getThumbnailUrl: vi.fn(async () => ({ url: "https://provider.test/thumb?secret=token", expiresAt: expiry }))
  } as unknown as ProviderAdapter;
  const providers: ProviderRegistry = { get: () => adapter };
  const sourceService = { getUsableCredentials: vi.fn(async () => credentials) };
  const logger = { info: vi.fn(), error: vi.fn() };
  const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });
  const service = createMediaUrlService({ repository, browse, providers, sourceService, logger });
  const raw = "device-token";
  // Authentication hashes the cookie token, so keep the matching session record.
  const { hashOpaqueToken, createApiApp } = await import("@cloudframe/server");
  await repository.putDeviceSession({ id: "session-http", householdId: "h1", deviceId: "d1", tokenHash: hashOpaqueToken(raw), createdAt: now, lastSeenAt: now, expiresAt: new Date("2027-08-26T00:00:00Z"), revokedAt: null });
  const createApp = (rateLimits: Record<string, { limit: number; windowSeconds: number }>) => createApiApp({ repository, mediaUrls: service, config: { householdId: "h1", passphrasePepper: "pepper", csrfSecret: "csrf", allowedOrigin: "https://app.test", rateLimits }, now: () => now });
  const request = (path: string, body: unknown) => new Request(`https://app.test${path}`, { method: "POST", headers: { cookie: `device_session=${raw}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { repository, household, device, source, rootNode, mediaNode, outsideNode, adapter, providers, sourceService, logger, service, createApp, request };
}

function node(providerId: string, kind: MediaNode["kind"], parentNodeId: string | null, ancestorNodeIds: string[]): MediaNode {
  return { id: deterministicNodeId("s1", providerId), householdId: "h1", sourceId: "s1", provider: "google", providerNodeId: providerId, parentNodeId, ancestorNodeIds, name: providerId, normalizedName: providerId, kind, mimeType: kind === "folder" ? null : kind === "video" ? "video/mp4" : "image/jpeg", size: 100, width: 1920, height: 1080, capturedAt: now, createdAtProvider: now, modifiedAtProvider: now, thumbnailRevision: "r1", hasPreview: kind !== "folder", folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: 0, available: true, indexedAt: now };
}
