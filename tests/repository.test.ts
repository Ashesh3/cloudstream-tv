import { describe, expect, it } from "vitest";

import type {
  AdminSession,
  AssignedRoot,
  Device,
  DeviceRequest,
  DeviceSession,
  Household,
  MediaNode,
  Source,
  WatchHistory
} from "@cloudframe/shared";
import {
  createFirestoreClient,
  decodeFirestoreDocument,
  FirestoreRepository,
  MemoryRepository,
  type FirestoreClientSettings
} from "@cloudframe/server";
import type { Firestore } from "@google-cloud/firestore";

const now = new Date("2026-08-26T00:00:00Z");
const later = new Date("2026-08-27T00:00:00Z");

const household: Household = {
  id: "h1",
  createdAt: now,
  allowNewDeviceRequests: true,
  defaultMediaOrder: "captured-desc",
  defaultSlideshowSeconds: 10,
  adminPassphraseHash: "old-hash",
  adminPassphraseVersion: 1
};

const pendingRequest: DeviceRequest = {
  id: "r1",
  householdId: "h1",
  requestSecretHash: "request-hash",
  requestedName: "Living room",
  status: "pending",
  createdAt: now,
  expiresAt: later,
  resolvedAt: null,
  approvedDeviceId: null
};

const device: Device = {
  id: "d1",
  householdId: "h1",
  name: "Living room",
  enabled: true,
  assignedRootIds: [],
  mediaOrder: null,
  slideshowSeconds: null,
  createdAt: now,
  approvedAt: now,
  lastSeenAt: now,
  revokedAt: null
};

const session: DeviceSession = {
  id: "ds1",
  householdId: "h1",
  deviceId: "d1",
  tokenHash: "session-hash",
  createdAt: now,
  lastSeenAt: now,
  expiresAt: later,
  revokedAt: null
};

describe("MemoryRepository security transitions", () => {
  it("approves a request atomically with device, assignments, and session", async () => {
    const repo = new MemoryRepository();
    await repo.createDeviceRequest(pendingRequest);

    await repo.approveDeviceRequest({
      requestId: "r1",
      device,
      session,
      rootIds: ["root-1"]
    });

    expect((await repo.getDeviceRequest("r1"))?.status).toBe("approved");
    expect((await repo.getDeviceRequest("r1"))?.approvedDeviceId).toBe("d1");
    expect((await repo.getDevice("d1"))?.assignedRootIds).toEqual(["root-1"]);
    expect(await repo.getDeviceSessionByHash(session.tokenHash)).toMatchObject({
      deviceId: "d1"
    });
  });

  it("leaves a request pending when approval conflicts with existing state", async () => {
    const repo = new MemoryRepository();
    await repo.createDeviceRequest(pendingRequest);
    await repo.putDevice({ ...device, name: "Existing device" });

    await expect(
      repo.approveDeviceRequest({
        requestId: "r1",
        device,
        session,
        rootIds: ["root-1"]
      })
    ).rejects.toThrow(/already exists/i);

    expect((await repo.getDeviceRequest("r1"))?.status).toBe("pending");
    expect((await repo.getDevice("d1"))?.name).toBe("Existing device");
    expect(await repo.getDeviceSessionByHash(session.tokenHash)).toBeNull();
  });

  it("revokes a device and all of its sessions together", async () => {
    const repo = new MemoryRepository();
    await repo.putDevice(device);
    await repo.putDeviceSession(session);
    await repo.putDeviceSession({ ...session, id: "ds2", tokenHash: "session-hash-2" });

    await repo.revokeDevice("d1", later);

    expect(await repo.getDevice("d1")).toMatchObject({
      enabled: false,
      revokedAt: later
    });
    expect(await repo.getDeviceSessionByHash("session-hash")).toMatchObject({
      revokedAt: later
    });
    expect(await repo.getDeviceSessionByHash("session-hash-2")).toMatchObject({
      revokedAt: later
    });
  });

  it("rotates the passphrase version and revokes every admin session", async () => {
    const repo = new MemoryRepository();
    const adminSession: AdminSession = {
      id: "as1",
      householdId: "h1",
      tokenHash: "admin-hash",
      passphraseVersion: 1,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: later,
      revokedAt: null
    };
    await repo.putHousehold(household);
    await repo.putAdminSession(adminSession);

    const updated = await repo.rotateAdminPassphrase({
      householdId: "h1",
      adminPassphraseHash: "new-hash",
      revokedAt: later
    });

    expect(updated).toMatchObject({
      adminPassphraseHash: "new-hash",
      adminPassphraseVersion: 2
    });
    expect(await repo.getAdminSessionByHash("admin-hash")).toMatchObject({
      revokedAt: later
    });
  });

  it("allows only one live sync lease owner", async () => {
    const repo = new MemoryRepository();
    const source = makeSource();
    await repo.putSource(source);

    await expect(
      repo.acquireSyncLease({
        sourceId: "s1",
        owner: "worker-a",
        now,
        expiresAt: later
      })
    ).resolves.toBe(true);
    await expect(
      repo.acquireSyncLease({
        sourceId: "s1",
        owner: "worker-b",
        now: new Date("2026-08-26T12:00:00Z"),
        expiresAt: new Date("2026-08-28T00:00:00Z")
      })
    ).resolves.toBe(false);
    await expect(repo.releaseSyncLease("s1", "worker-b")).resolves.toBe(false);
    await expect(repo.releaseSyncLease("s1", "worker-a")).resolves.toBe(true);
  });
});

describe("MemoryRepository domain storage", () => {
  it("stores and queries sources, roots, nodes, and watch history", async () => {
    const repo = new MemoryRepository();
    const source = makeSource();
    const root: AssignedRoot = {
      id: "root-1",
      householdId: "h1",
      sourceId: "s1",
      providerNodeId: "provider-root",
      displayName: "Family",
      ancestryProviderIds: [],
      enabled: true,
      createdAt: now
    };
    const folder: MediaNode = {
      id: "n1",
      householdId: "h1",
      sourceId: "s1",
      provider: "google",
      providerNodeId: "provider-folder",
      parentNodeId: null,
      ancestorNodeIds: [],
      name: "Trips",
      normalizedName: "trips",
      kind: "folder",
      mimeType: null,
      size: null,
      width: null,
      height: null,
      capturedAt: null,
      createdAtProvider: now,
      modifiedAtProvider: now,
      thumbnailRevision: null,
      hasPreview: false,
      folderCoverNodeIds: [],
      childFolderCount: 0,
      childMediaCount: 0,
      available: true,
      indexedAt: now
    };
    const history: WatchHistory = {
      id: "d1_n1",
      householdId: "h1",
      deviceId: "d1",
      nodeId: "n1",
      positionSeconds: 12,
      durationSeconds: 90,
      completed: false,
      updatedAt: now
    };

    await repo.putSource(source);
    await repo.putRoot(root);
    await repo.putNode(folder);
    await repo.putWatchHistory(history);

    expect(await repo.listSources("h1")).toEqual([source]);
    expect(await repo.listRootsForSource("s1")).toEqual([root]);
    expect(await repo.getNodeByProviderId("s1", "provider-folder")).toEqual(folder);
    expect(await repo.listChildNodes(null, ["s1"])).toEqual([folder]);
    expect(await repo.getWatchHistory("d1", "n1")).toEqual(history);
  });
});

describe("Firestore client authentication boundary", () => {
  it("uses Vercel OIDC workload identity federation in production", async () => {
    let captured: FirestoreClientSettings | undefined;
    const client = createFirestoreClient(
      {
        environment: "production",
        projectId: "cloudframe-prod",
        workloadIdentityProvider:
          "projects/123/locations/global/workloadIdentityPools/vercel/providers/vercel",
        serviceAccountEmail: "cloudframe@cloudframe-prod.iam.gserviceaccount.com"
      },
      {
        createClient(settings) {
          captured = settings;
          return { kind: "firestore-client" };
        },
        getVercelOidcToken: async () => "vercel-oidc-token"
      }
    );

    expect(client).toEqual({ kind: "firestore-client" });
    expect(captured?.credentials).toMatchObject({
      type: "external_account",
      audience:
        "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/vercel/providers/vercel",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/cloudframe%40cloudframe-prod.iam.gserviceaccount.com:generateAccessToken"
    });
    if (!captured?.credentials || !("subject_token_supplier" in captured.credentials)) {
      throw new Error("Expected workload identity credentials");
    }
    await expect(
      captured.credentials.subject_token_supplier.getSubjectToken()
    ).resolves.toBe("vercel-oidc-token");
    expect(captured?.credentials).not.toHaveProperty("private_key");
  });

  it("supports the emulator without production credentials", () => {
    let captured: FirestoreClientSettings | undefined;

    createFirestoreClient(
      {
        environment: "local",
        projectId: "cloudframe-local",
        emulatorHost: "127.0.0.1:8080"
      },
      {
        createClient(settings) {
          captured = settings;
          return {};
        },
        getVercelOidcToken: async () => "unused"
      }
    );

    expect(captured).toMatchObject({
      projectId: "cloudframe-local",
      host: "127.0.0.1:8080",
      ssl: false
    });
    expect(captured?.credentials).toBeUndefined();
  });

  it("rejects long-lived explicit credentials in production", () => {
    expect(() =>
      createFirestoreClient(
        {
          environment: "production",
          projectId: "cloudframe-prod",
          explicitCredentials: {
            clientEmail: "service@example.test",
            privateKey: "private-key"
          }
        },
        {
          createClient: () => ({}),
          getVercelOidcToken: async () => "unused"
        }
      )
    ).toThrow(/production.*workload identity/i);
  });
});

describe("Firestore document decoding", () => {
  it("converts nested Firestore timestamps into shared Date contracts", () => {
    const decoded = decodeFirestoreDocument("s1", {
      createdAt: { toDate: () => now },
      crawlCheckpoint: {
        resumedAt: { toDate: () => later }
      },
      dates: [{ toDate: () => later }]
    });

    expect(decoded).toEqual({
      id: "s1",
      createdAt: now,
      crawlCheckpoint: { resumedAt: later },
      dates: [later]
    });
  });

  it("does not steal a live lease represented by a Firestore timestamp", async () => {
    let updated = false;
    const sourceReference = {};
    const firestore = {
      collection() {
        return {
          doc() {
            return sourceReference;
          }
        };
      },
      runTransaction: async (operation: (transaction: unknown) => unknown) =>
        operation({
          get: async () => ({
            id: "s1",
            exists: true,
            data: () => ({
              ...makeSource(),
              leaseOwner: "worker-a",
              leaseExpiresAt: {
                toDate: () => new Date("2026-08-27T00:00:00Z")
              }
            })
          }),
          update() {
            updated = true;
          }
        })
    } as unknown as Firestore;
    const repo = new FirestoreRepository(firestore);

    await expect(
      repo.acquireSyncLease({
        sourceId: "s1",
        owner: "worker-b",
        now: new Date("2026-08-26T12:00:00Z"),
        expiresAt: new Date("2026-08-28T00:00:00Z")
      })
    ).resolves.toBe(false);
    expect(updated).toBe(false);
  });
});

function makeSource(): Source {
  return {
    id: "s1",
    householdId: "h1",
    provider: "google",
    accountLabel: "Family Google Drive",
    encryptedRefreshToken: {
      keyVersion: "v1",
      iv: "iv",
      ciphertext: "ciphertext",
      authTag: "tag"
    },
    encryptedAccessToken: null,
    accessTokenExpiresAt: null,
    status: "healthy",
    deltaCursor: null,
    crawlCheckpoint: null,
    activeWorkflowRunId: null,
    syncGeneration: null,
    nextSyncAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncErrorCode: null,
    createdAt: now
  };
}
