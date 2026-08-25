import { describe, expect, it } from "vitest";

import type { AssignedRoot, Device, Household, MediaNode, Source } from "@cloudframe/shared";
import {
  BrowseServiceError,
  MemoryRepository,
  createBrowseService
} from "@cloudframe/server";
import { deterministicNodeId } from "@cloudframe/indexer";

const now = new Date("2026-08-26T00:00:00.000Z");

describe("current device-root browse authorization", () => {
  it("returns only current enabled assigned roots in the virtual root", async () => {
    const { repository, device } = await fixture();
    await repository.putRoot({ ...root("root-2", "s2", "other-root"), enabled: false });
    await repository.putDevice({ ...device, assignedRootIds: ["root-1", "root-2"] });
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });

    const home = await browse.home({ ...device, assignedRootIds: ["root-1", "root-2"] });
    expect(home.roots.map(value => value.id)).toEqual(["root-1"]);
    expect(home.roots[0]).toMatchObject({ nodeId: deterministicNodeId("s1", "provider-root") });
  });

  it("sorts folders first then media and paginates with a device-bound cursor", async () => {
    const { repository, device, household, rootNode } = await fixture();
    await repository.putNode(media("z-folder", "Zulu", "folder", rootNode.id));
    await repository.putNode(media("a-folder", "Alpha", "folder", rootNode.id));
    await repository.putNode(media("old", "Old.jpg", "image", rootNode.id, "2025-01-01"));
    await repository.putNode(media("new", "New.jpg", "image", rootNode.id, "2026-01-01"));
    await repository.putNode({ ...(await repository.getNode(childId()))!, available: false });
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });

    const first = await browse.folder(device, household, rootNode.id, { limit: 2, cursor: null });
    expect(first.children.map(node => node.name)).toEqual(["Alpha", "Zulu"]);
    expect(first.nextCursor).toBeTruthy();
    const second = await browse.folder(device, household, rootNode.id, { limit: 2, cursor: first.nextCursor });
    expect(second.children.map(node => node.name)).toEqual(["New.jpg", "Old.jpg"]);

    const otherDevice = { ...device, id: "different-device" };
    await repository.putDevice(otherDevice);
    await expect(
      browse.folder(otherDevice, household, rootNode.id, { limit: 2, cursor: first.nextCursor })
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it("rejects tampered cursors", async () => {
    const { repository, device, household, rootNode } = await fixture();
    await repository.putNode(media("child", "Child", "folder", rootNode.id));
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });
    const page = await browse.folder(device, household, rootNode.id, { limit: 1, cursor: null });
    const tampered = `${page.nextCursor ?? "cursor"}x`;
    await expect(
      browse.folder(device, household, rootNode.id, { limit: 1, cursor: tampered })
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });

  it.each([
    ["cross root", "outside"],
    ["cross household", "foreign"],
    ["unavailable", "gone"]
  ])("fails closed for %s nodes", async (_label, nodeId) => {
    const { repository, device, household } = await fixture();
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });
    await expect(browse.authorizeNode(device, household, nodeId)).rejects.toBeInstanceOf(BrowseServiceError);
  });

  it("applies reassignment immediately without relying on session-time roots", async () => {
    const { repository, device, household, child } = await fixture();
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });
    await expect(browse.authorizeNode(device, household, child.id)).resolves.toMatchObject({ id: child.id });
    const current = { ...device, assignedRootIds: ["root-other"] };
    await repository.putRoot(root("root-other", "s2", "other-root"));
    await repository.putDevice(current);
    await expect(browse.authorizeNode(current, household, child.id)).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
  });

  it("applies current device revocation immediately", async () => {
    const { repository, device, household, child } = await fixture();
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });
    await repository.putDevice({ ...device, enabled: false, revokedAt: now });
    await expect(browse.authorizeNode(device, household, child.id)).rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED" });
  });

  it("walks current parent links after a folder move and rejects descendants from the old root", async () => {
    const { repository, device, household, rootNode, child } = await fixture();
    const movedFolder = media("moved", "Moved", "folder", rootNode.id, null, "s1", "h1", [rootNode.id]);
    const grandchild = media("grandchild", "Grandchild.jpg", "image", movedFolder.id, "2026-01-01", "s1", "h1", [rootNode.id, movedFolder.id]);
    await repository.putNode(movedFolder); await repository.putNode(grandchild);
    const unassignedRoot = media("unassigned-root", "Other", "folder", null, null, "s1", "h1", []);
    await repository.putNode(unassignedRoot);
    await repository.putNode({ ...movedFolder, parentNodeId: unassignedRoot.id, ancestorNodeIds: [unassignedRoot.id] });
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret" });
    await expect(browse.authorizeNode(device, household, grandchild.id)).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
    await repository.putNode({ ...rootNode, available: false });
    await expect(browse.authorizeNode(device, household, child.id)).rejects.toMatchObject({ code: "NODE_NOT_FOUND" });
  });

  it("stores bounded device-scoped last-write-wins history only for authorized media", async () => {
    const { repository, device, household, child } = await fixture();
    const browse = createBrowseService({ repository, cursorSecret: "cursor-secret", now: () => now });
    await browse.saveHistory(device, household, child.id, { positionSeconds: 20, durationSeconds: 100, completed: false });
    await browse.saveHistory(device, household, child.id, { positionSeconds: 30, durationSeconds: 100, completed: false });
    expect(await browse.history(device, household)).toEqual([
      expect.objectContaining({ id: `${device.id}_${child.id}`, positionSeconds: 30 })
    ]);
    await expect(
      browse.saveHistory(device, household, child.id, { positionSeconds: -1, durationSeconds: 100, completed: false })
    ).rejects.toMatchObject({ code: "INVALID_HISTORY" });
  });
});

async function fixture() {
  const repository = new MemoryRepository();
  const household: Household = { id: "h1", createdAt: now, allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 10, adminPassphraseHash: "hash", adminPassphraseVersion: 1 };
  const device: Device = { id: "d1", householdId: "h1", name: "TV", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null, slideshowSeconds: null, createdAt: now, approvedAt: now, lastSeenAt: now, revokedAt: null };
  await repository.putHousehold(household);
  await repository.putDevice(device);
  await repository.putSource(source("s1", "h1"));
  await repository.putSource(source("s2", "h1"));
  await repository.putSource(source("foreign-source", "h2"));
  await repository.putRoot(root("root-1", "s1", "provider-root"));
  const rootNode = media("provider-root", "Family", "folder", null, null, "s1", "h1", []);
  const child = media("child", "Movie.mp4", "video", rootNode.id, "2026-01-01", "s1", "h1", [rootNode.id]);
  await repository.putNode(rootNode);
  await repository.putNode(child);
  await repository.putNode(media("outside", "Outside.jpg", "image", null, "2026-01-01", "s1", "h1", []));
  await repository.putNode(media("foreign", "Foreign.jpg", "image", null, "2026-01-01", "foreign-source", "h2", []));
  await repository.putNode({ ...media("gone", "Gone.jpg", "image", rootNode.id, "2026-01-01", "s1", "h1", [rootNode.id]), available: false });
  return { repository, device, household, rootNode, child };
}

function childId(): string { return deterministicNodeId("s1", "child"); }

function root(id: string, sourceId: string, providerNodeId: string): AssignedRoot {
  return { id, householdId: "h1", sourceId, providerNodeId, displayName: id, ancestryProviderIds: [], enabled: true, createdAt: now };
}

function source(id: string, householdId: string): Source {
  return { id, householdId, provider: "google", providerAccountId: "account", accountLabel: id, encryptedRefreshToken: { keyVersion: "1", iv: "iv", ciphertext: "x", authTag: "tag" }, encryptedAccessToken: null, accessTokenExpiresAt: null, status: "healthy", deltaCursor: null, crawlCheckpoint: null, activeWorkflowRunId: null, syncGeneration: null, nextSyncAt: null, leaseOwner: null, leaseExpiresAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null, createdAt: now };
}

function media(providerId: string, name: string, kind: MediaNode["kind"], parentNodeId: string | null, captured: string | null = "2026-01-01", sourceId = "s1", householdId = "h1", ancestorNodeIds?: string[]): MediaNode {
  return { id: deterministicNodeId(sourceId, providerId), householdId, sourceId, provider: "google", providerNodeId: providerId, parentNodeId, ancestorNodeIds: ancestorNodeIds ?? (parentNodeId ? [parentNodeId] : []), name, normalizedName: name.toLowerCase(), kind, mimeType: kind === "folder" ? null : kind === "video" ? "video/mp4" : "image/jpeg", size: 100, width: 100, height: 100, capturedAt: captured ? new Date(captured) : null, createdAtProvider: now, modifiedAtProvider: now, thumbnailRevision: "r1", hasPreview: kind !== "folder", folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: 0, available: true, indexedAt: now };
}
