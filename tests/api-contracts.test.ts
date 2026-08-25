import { describe, expect, it } from "vitest";

import type {
  AssignedRoot,
  Device,
  DeviceRequest,
  Household,
  MediaNode,
  Source
} from "@cloudframe/shared";
import {
  decodeMediaNodeDto,
  encodeAdminOverviewResponse,
  encodeBootstrapResponse,
  encodeMediaNodeDto,
  sortFolderListing
} from "@cloudframe/shared";

const now = new Date("2026-08-26T00:00:00Z");
const later = new Date("2026-08-27T00:00:00Z");

describe("public API DTOs", () => {
  it("serializes bootstrap and admin responses without persistence secrets", () => {
    const household = makeHousehold();
    const request = makeRequest();
    const device = makeDevice();
    const source = makeSource();
    const root = makeRoot();

    const serialized = JSON.stringify({
      bootstrap: encodeBootstrapResponse({
        enrollment: { state: "ready", device, household }
      }),
      admin: encodeAdminOverviewResponse({
        household,
        pendingRequests: [request],
        devices: [device],
        sources: [source],
        roots: [root]
      })
    });

    for (const forbiddenField of [
      "adminPassphraseHash",
      "adminPassphraseVersion",
      "requestSecretHash",
      "encryptedRefreshToken",
      "encryptedAccessToken",
      "accessTokenCiphertext",
      "tokenHash",
      "ciphertext",
      "authTag",
      "leaseOwner",
      "leaseExpiresAt",
      "deltaCursor",
      "crawlCheckpoint",
      "activeWorkflowRunId",
      "syncGeneration"
    ]) {
      expect(serialized).not.toContain(`"${forbiddenField}"`);
    }
  });

  it("round-trips media-node wire DTOs and sorts after browser decoding", () => {
    const older = makeNode({
      id: "older",
      providerNodeId: "provider-older",
      name: "Older",
      capturedAt: new Date("2024-01-01T00:00:00Z")
    });
    const newer = makeNode({
      id: "newer",
      providerNodeId: "provider-newer",
      name: "Newer",
      capturedAt: new Date("2025-01-01T00:00:00Z")
    });

    const wirePayload = JSON.parse(
      JSON.stringify([encodeMediaNodeDto(older), encodeMediaNodeDto(newer)])
    );

    expect(wirePayload[0].capturedAt).toBe("2024-01-01T00:00:00.000Z");
    const decoded = wirePayload.map(decodeMediaNodeDto);
    expect(decoded[0]?.capturedAt).toBeInstanceOf(Date);
    expect(sortFolderListing(decoded, "captured-desc").map(node => node.id)).toEqual([
      "newer",
      "older"
    ]);
  });
});

function makeHousehold(): Household {
  return {
    id: "h1",
    createdAt: now,
    allowNewDeviceRequests: true,
    defaultMediaOrder: "captured-desc",
    defaultSlideshowSeconds: 10,
    adminPassphraseHash: "secret-admin-hash",
    adminPassphraseVersion: 4
  };
}

function makeRequest(): DeviceRequest {
  return {
    id: "r1",
    householdId: "h1",
    requestSecretHash: "secret-request-hash",
    requestedName: "Living room",
    status: "pending",
    createdAt: now,
    expiresAt: later,
    resolvedAt: null,
    approvedDeviceId: null
  };
}

function makeDevice(): Device {
  return {
    id: "d1",
    householdId: "h1",
    name: "Living room",
    enabled: true,
    assignedRootIds: ["root-1"],
    mediaOrder: null,
    slideshowSeconds: null,
    createdAt: now,
    approvedAt: now,
    lastSeenAt: now,
    revokedAt: null
  };
}

function makeSource(): Source {
  return {
    id: "s1",
    householdId: "h1",
    provider: "google",
    accountLabel: "Family Drive",
    encryptedRefreshToken: {
      keyVersion: "v1",
      iv: "secret-iv",
      ciphertext: "secret-refresh-ciphertext",
      authTag: "secret-refresh-tag"
    },
    encryptedAccessToken: {
      keyVersion: "v1",
      iv: "secret-access-iv",
      ciphertext: "secret-access-ciphertext",
      authTag: "secret-access-tag"
    },
    accessTokenExpiresAt: later,
    status: "healthy",
    deltaCursor: "secret-delta-cursor",
    crawlCheckpoint: {
      mode: "delta",
      providerPageCursor: "secret-page-cursor",
      processedNodeCount: 12,
      generation: "secret-generation"
    },
    activeWorkflowRunId: "secret-run",
    syncGeneration: "secret-sync-generation",
    nextSyncAt: later,
    leaseOwner: "secret-worker",
    leaseExpiresAt: later,
    lastSyncStartedAt: now,
    lastSyncCompletedAt: later,
    lastSyncErrorCode: null,
    createdAt: now
  };
}

function makeRoot(): AssignedRoot {
  return {
    id: "root-1",
    householdId: "h1",
    sourceId: "s1",
    providerNodeId: "provider-root",
    displayName: "Family",
    ancestryProviderIds: ["provider-parent"],
    enabled: true,
    createdAt: now
  };
}

function makeNode(overrides: Partial<MediaNode>): MediaNode {
  return {
    id: "node",
    householdId: "h1",
    sourceId: "s1",
    provider: "google",
    providerNodeId: "provider-node",
    parentNodeId: null,
    ancestorNodeIds: [],
    name: "Node",
    normalizedName: "node",
    kind: "image",
    mimeType: "image/jpeg",
    size: 100,
    width: 1920,
    height: 1080,
    capturedAt: now,
    createdAtProvider: now,
    modifiedAtProvider: later,
    thumbnailRevision: "revision",
    hasPreview: true,
    folderCoverNodeIds: [],
    childFolderCount: 0,
    childMediaCount: 0,
    available: true,
    indexedAt: later,
    ...overrides
  };
}
