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
  assignedRootDocumentId,
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
      rootIds: ["root-1"],
      approvedAt: now
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
        rootIds: ["root-1"],
        approvedAt: now
      })
    ).rejects.toThrow(/already exists/i);

    expect((await repo.getDeviceRequest("r1"))?.status).toBe("pending");
    expect((await repo.getDevice("d1"))?.name).toBe("Existing device");
    expect(await repo.getDeviceSessionByHash(session.tokenHash)).toBeNull();
  });

  it("rejects expired device requests without partial writes", async () => {
    const repo = new MemoryRepository();
    await repo.createDeviceRequest({
      ...pendingRequest,
      expiresAt: new Date("2026-08-25T23:59:59Z")
    });

    await expect(
      repo.approveDeviceRequest({
        requestId: "r1",
        device,
        session,
        rootIds: ["root-1"],
        approvedAt: now
      })
    ).rejects.toThrow(/expired/i);

    expect((await repo.getDeviceRequest("r1"))?.status).toBe("pending");
    expect(await repo.getDevice("d1")).toBeNull();
    expect(await repo.getDeviceSessionByHash(session.tokenHash)).toBeNull();
  });

  it("rejects reuse of a session token hash already stored in memory", async () => {
    const repo = new MemoryRepository();
    await repo.createDeviceRequest(pendingRequest);
    await repo.putDeviceSession({
      ...session,
      id: "existing-session",
      deviceId: "existing-device"
    });

    await expect(
      repo.approveDeviceRequest({
        requestId: "r1",
        device,
        session,
        rootIds: ["root-1"],
        approvedAt: now
      })
    ).rejects.toThrow(/token.*already exists/i);

    expect((await repo.getDeviceRequest("r1"))?.status).toBe("pending");
    expect(await repo.getDevice("d1")).toBeNull();
  });

  it.each([
    {
      name: "device household",
      device: { ...device, householdId: "h2" },
      session
    },
    {
      name: "session household",
      device,
      session: { ...session, householdId: "h2" }
    },
    {
      name: "session device",
      device,
      session: { ...session, deviceId: "d2" }
    }
  ])("rejects a mismatched $name during approval", async ({ device: inputDevice, session: inputSession }) => {
    const repo = new MemoryRepository();
    await repo.createDeviceRequest(pendingRequest);

    await expect(
      repo.approveDeviceRequest({
        requestId: "r1",
        device: inputDevice,
        session: inputSession,
        rootIds: ["root-1"],
        approvedAt: now
      })
    ).rejects.toThrow(/relationship/i);

    expect((await repo.getDeviceRequest("r1"))?.status).toBe("pending");
    expect(await repo.getDevice(inputDevice.id)).toBeNull();
    expect(await repo.getDeviceSessionByHash(inputSession.tokenHash)).toBeNull();
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
  it("supplies the Vercel OIDC token from the active Web API request", async () => {
    const { requestOidcTokenSupplier } = await import("@cloudframe/server");
    const supplier = requestOidcTokenSupplier(new Request("https://app.test/api/bootstrap", {
      headers: { "x-vercel-oidc-token": "synthetic-request-oidc" }
    }));
    await expect(supplier()).resolves.toBe("synthetic-request-oidc");
    await expect(requestOidcTokenSupplier(new Request("https://app.test"))()).rejects.toThrow(/unavailable/i);
  });

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

  it("uses Vercel OIDC workload identity in staging previews when configured", () => {
    let captured: FirestoreClientSettings | undefined;
    createFirestoreClient(
      {
        environment: "staging",
        projectId: "cloudframe-dev",
        workloadIdentityProvider: "projects/123/locations/global/workloadIdentityPools/vercel/providers/vercel",
        serviceAccountEmail: "cloudframe@cloudframe-dev.iam.gserviceaccount.com"
      },
      {
        createClient(settings) { captured = settings; return {}; },
        getVercelOidcToken: async () => "preview-oidc-token"
      }
    );
    expect(captured?.credentials).toMatchObject({ type: "external_account" });
    expect(captured?.credentials).not.toHaveProperty("private_key");
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
      alreadyDecodedAt: later,
      crawlCheckpoint: {
        resumedAt: { toDate: () => later }
      },
      dates: [{ toDate: () => later }]
    });

    expect(decoded).toEqual({
      id: "s1",
      createdAt: now,
      alreadyDecodedAt: later,
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

describe("FirestoreRepository device approval", () => {
  it("allows only one concurrent approval to claim a session token hash", async () => {
    const fake = createConcurrentApprovalFirestore();
    const repo = new FirestoreRepository(fake.firestore);
    const secondDevice = { ...device, id: "d2", name: "Bedroom" };
    const secondSession = {
      ...session,
      id: "ds2",
      deviceId: "d2"
    };

    const results = await Promise.allSettled([
      repo.approveDeviceRequest({
        requestId: "r1",
        device,
        session,
        rootIds: ["root-1"],
        approvedAt: now
      }),
      repo.approveDeviceRequest({
        requestId: "r2",
        device: secondDevice,
        session: secondSession,
        rootIds: ["root-1"],
        approvedAt: now
      })
    ]);

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(fake.createdTokenClaimIds).toEqual([session.tokenHash]);
  });

  it.each([
    {
      name: "expired request",
      request: {
        ...pendingRequest,
        expiresAt: new Date("2026-08-25T23:59:59Z")
      },
      device,
      session,
      expected: /expired/i
    },
    {
      name: "device household mismatch",
      request: pendingRequest,
      device: { ...device, householdId: "h2" },
      session,
      expected: /relationship/i
    },
    {
      name: "session household mismatch",
      request: pendingRequest,
      device,
      session: { ...session, householdId: "h2" },
      expected: /relationship/i
    },
    {
      name: "session device mismatch",
      request: pendingRequest,
      device,
      session: { ...session, deviceId: "d2" },
      expected: /relationship/i
    }
  ])("rejects $name before Firestore writes", async input => {
    const fake = createApprovalFirestore(input.request, false);
    const repo = new FirestoreRepository(fake.firestore);

    await expect(
      repo.approveDeviceRequest({
        requestId: "r1",
        device: input.device,
        session: input.session,
        rootIds: ["root-1"],
        approvedAt: now
      })
    ).rejects.toThrow(input.expected);

    expect(fake.writes).toEqual([]);
  });

  it("rejects a duplicate session token hash inside the transaction", async () => {
    const fake = createApprovalFirestore(pendingRequest, true);
    const repo = new FirestoreRepository(fake.firestore);

    await expect(
      repo.approveDeviceRequest({
        requestId: "r1",
        device,
        session,
        rootIds: ["root-1"],
        approvedAt: now
      })
    ).rejects.toThrow(/token.*already exists/i);

    expect(fake.readTokenClaimIds).toEqual([session.tokenHash]);
    expect(fake.writes).toEqual([]);
  });
});

describe("FirestoreRepository admin management transactions", () => {
  it("creates source and initial root in one transaction", async () => {
    const writes: string[] = [];
    const firestore = createManagementFirestore({ writes });
    const repo = new FirestoreRepository(firestore);
    const source = makeSource();
    const root = makeRoot();

    await repo.connectSourceWithRoot({ source, root });

    expect(writes).toEqual([
      "create:sources/s1",
      `create:roots/${assignedRootDocumentId("h1", "s1", "provider-root")}`
    ]);
  });

  it("removes source, disables roots, and detaches devices in one transaction", async () => {
    const writes: string[] = [];
    const firestore = createManagementFirestore({
      writes,
      source: makeSource(),
      roots: [makeRoot()],
      devices: [{ ...device, assignedRootIds: ["root-1", "root-other"] }]
    });
    const repo = new FirestoreRepository(firestore);

    const impact = await repo.removeSource({ householdId: "h1", sourceId: "s1" });

    expect(impact).toMatchObject({ roots: [{ id: "root-1" }], devices: [{ id: "d1" }] });
    expect(writes).toContain("delete:sources/s1");
    expect(writes).toContain("update:roots/root-1:{\"enabled\":false}");
    expect(writes).toContain("update:devices/d1:{\"assignedRootIds\":[\"root-other\"]}");
  });

  it("detaches devices from roots that were already disabled before source removal", async () => {
    const writes: string[] = [];
    const firestore = createManagementFirestore({
      writes,
      source: makeSource(),
      roots: [{ ...makeRoot(), enabled: false }],
      devices: [{ ...device, assignedRootIds: ["root-1"] }]
    });
    const repo = new FirestoreRepository(firestore);

    const impact = await repo.removeSource({ householdId: "h1", sourceId: "s1" });

    expect(impact.roots).toMatchObject([{ id: "root-1", enabled: false }]);
    expect(writes).toContain("update:devices/d1:{\"assignedRootIds\":[]}");
  });

  it("disables a root and permits a device to have no roots", async () => {
    const writes: string[] = [];
    const firestore = createManagementFirestore({
      writes,
      roots: [makeRoot()],
      devices: [{ ...device, assignedRootIds: ["root-1"] }]
    });
    const repo = new FirestoreRepository(firestore);

    await repo.disableRoot({ householdId: "h1", rootId: "root-1" });

    expect(writes).toContain("update:roots/root-1:{\"enabled\":false}");
    expect(writes).toContain("update:devices/d1:{\"assignedRootIds\":[]}");
  });

  it("migrates and re-enables a legacy root under the deterministic identity", async () => {
    const writes: string[] = [];
    const firestore = createManagementFirestore({
      writes,
      roots: [{ ...makeRoot(), enabled: false, displayName: "Old" }],
      devices: [{ ...device, assignedRootIds: ["root-1"] }]
    });
    const repo = new FirestoreRepository(firestore);

    const root = await repo.createOrEnableRoot({ ...makeRoot(), id: "root-new", displayName: "New" });

    const expectedId = assignedRootDocumentId("h1", "s1", "provider-root");
    expect(root).toMatchObject({ id: expectedId, displayName: "New", enabled: true });
    expect(writes).toContain(`create:roots/${expectedId}`);
    expect(writes).toContain("delete:roots/root-1");
    expect(writes).toContain(`update:devices/d1:{"assignedRootIds":["${expectedId}"]}`);
  });

  it("serializes concurrent absent-root creates onto one deterministic document", async () => {
    const fake = createConcurrentRootFirestore();
    const repo = new FirestoreRepository(fake.firestore);
    const input = makeRoot();

    const [first, second] = await Promise.all([
      repo.createOrEnableRoot({ ...input, id: "random-a" }),
      repo.createOrEnableRoot({ ...input, id: "random-b" })
    ]);

    const expectedId = assignedRootDocumentId("h1", "s1", "provider-root");
    expect(first.id).toBe(expectedId);
    expect(second.id).toBe(expectedId);
    expect(fake.rootIds()).toEqual([expectedId]);
    expect(expectedId).not.toContain("provider-root");
  });
});

function createApprovalFirestore(
  request: DeviceRequest,
  duplicateTokenHash: boolean
): {
  firestore: Firestore;
  writes: string[];
  readTokenClaimIds: string[];
} {
  const writes: string[] = [];
  const readTokenClaimIds: string[] = [];
  const requestRef = { kind: "request", id: "r1" };
  const deviceRef = { kind: "device", id: "d1" };
  const sessionRef = { kind: "session", id: "ds1" };
  const tokenClaimRef = { kind: "token-claim", id: session.tokenHash };
  const firestore = {
    collection(name: string) {
      return {
        doc(id: string) {
          if (name === "deviceRequests" && id === "r1") return requestRef;
          if (name === "devices" && id === "d1") return deviceRef;
          if (name === "deviceSessions" && id === "ds1") return sessionRef;
          if (name === "deviceSessionTokenClaims") {
            readTokenClaimIds.push(id);
            return tokenClaimRef;
          }
          throw new Error(`Unexpected document ${name}/${id}`);
        }
      };
    },
    runTransaction: async (operation: (transaction: unknown) => unknown) =>
      operation({
        async get(target: unknown) {
          if (target === requestRef) {
            return {
              id: "r1",
              exists: true,
              data: () => request
            };
          }
          if (target === deviceRef || target === sessionRef) {
            return { exists: false };
          }
          if (target === tokenClaimRef) {
            return {
              id: session.tokenHash,
              exists: duplicateTokenHash,
              data: () => ({ sessionId: "existing-session" })
            };
          }
          throw new Error("Unexpected transaction read");
        },
        update() {
          writes.push("update");
        },
        create() {
          writes.push("create");
        }
      })
  } as unknown as Firestore;

  return { firestore, writes, readTokenClaimIds };
}

function makeRoot(): AssignedRoot {
  return {
    id: "root-1",
    householdId: "h1",
    sourceId: "s1",
    providerNodeId: "provider-root",
    displayName: "Family",
    ancestryProviderIds: [],
    enabled: true,
    createdAt: now
  };
}

function createManagementFirestore(options: {
  writes: string[];
  source?: Source;
  roots?: AssignedRoot[];
  devices?: Device[];
}): Firestore {
  type Ref = { key: string; id: string };
  type QueryLike = { collection: string; filters: Array<[string, unknown]>; limit?: number };
  const refs = new Map<string, Ref>();
  const ref = (collection: string, id: string): Ref => {
    const key = `${collection}/${id}`;
    const current = refs.get(key);
    if (current) return current;
    const value = { key, id };
    refs.set(key, value);
    return value;
  };
  const documents = new Map<string, unknown>();
  if (options.source) documents.set(`sources/${options.source.id}`, options.source);
  for (const root of options.roots ?? []) documents.set(`roots/${root.id}`, root);
  for (const value of options.devices ?? []) documents.set(`devices/${value.id}`, value);
  const snapshot = (reference: Ref) => ({
    id: reference.id,
    ref: reference,
    exists: documents.has(reference.key),
    data: () => documents.get(reference.key) as Record<string, unknown> | undefined
  });
  const querySnapshots = (query: QueryLike) => {
    const docs = [...documents.entries()]
      .filter(([key]) => key.startsWith(`${query.collection}/`))
      .map(([key, value]) => ({ reference: ref(query.collection, key.split("/")[1]!), value }))
      .filter(({ value }) => query.filters.every(([field, expected]) => (value as Record<string, unknown>)[field] === expected))
      .slice(0, query.limit ?? Number.POSITIVE_INFINITY)
      .map(({ reference }) => snapshot(reference));
    return { docs };
  };
  return {
    collection(collection: string) {
      const query: QueryLike = { collection, filters: [] };
      const builder = {
        doc(id: string) { return ref(collection, id); },
        where(field: string, _operator: string, value: unknown) {
          const next: QueryLike = { ...query, filters: [...query.filters, [field, value]] };
          return queryBuilder(next);
        }
      };
      const queryBuilder = (current: QueryLike): unknown => ({
        where(field: string, _operator: string, value: unknown) { return queryBuilder({ ...current, filters: [...current.filters, [field, value]] }); },
        limit(value: number) { return queryBuilder({ ...current, limit: value }); },
        __query: current
      });
      return builder;
    },
    async runTransaction(operation: (transaction: unknown) => Promise<unknown>) {
      return operation({
        async get(target: Ref | { __query?: QueryLike }) {
          if ("key" in target) return snapshot(target);
          const query = target.__query;
          if (!query) throw new Error("Unexpected management query");
          return querySnapshots(query);
        },
        create(reference: Ref, value: unknown) {
          options.writes.push(`create:${reference.key}`);
          documents.set(reference.key, value);
        },
        set(reference: Ref, value: unknown) {
          options.writes.push(`set:${reference.key}:${JSON.stringify(value)}`);
          documents.set(reference.key, value);
        },
        update(reference: Ref, patch: unknown) {
          options.writes.push(`update:${reference.key}:${JSON.stringify(patch)}`);
        },
        delete(reference: Ref) {
          options.writes.push(`delete:${reference.key}`);
          documents.delete(reference.key);
        }
      });
    }
  } as unknown as Firestore;
}

function createConcurrentApprovalFirestore(): {
  firestore: Firestore;
  createdTokenClaimIds: string[];
} {
  const createdDocumentKeys = new Set<string>();
  const createdTokenClaimIds: string[] = [];
  const readyResolvers: Array<() => void> = [];
  let readyCount = 0;

  const references = new Map<string, { key: string }>();
  const reference = (collection: string, id: string) => {
    const key = `${collection}/${id}`;
    const existing = references.get(key);
    if (existing) return existing;
    const created = { key };
    references.set(key, created);
    return created;
  };

  const firestore = {
    collection(name: string) {
      return {
        doc(id: string) {
          return reference(name, id);
        },
        where() {
          return {
            limit() {
              return this;
            }
          };
        }
      };
    },
    async runTransaction(
      operation: (transaction: unknown) => Promise<unknown>
    ): Promise<unknown> {
      const stagedCreates: Array<{ reference: { key: string } }> = [];
      const transaction = {
        async get(target: { key?: string }) {
          if (target.key?.startsWith("deviceRequests/")) {
            const id = target.key.split("/")[1] ?? "";
            return {
              id,
              exists: true,
              data: () => ({ ...pendingRequest, id })
            };
          }
          if (
            target.key?.startsWith("devices/") ||
            target.key?.startsWith("deviceSessions/") ||
            target.key?.startsWith("deviceSessionTokenClaims/")
          ) {
            return { id: target.key.split("/")[1], exists: false };
          }
          return { empty: true, docs: [] };
        },
        update() {},
        create(target: { key: string }) {
          stagedCreates.push({ reference: target });
        }
      };

      const result = await operation(transaction);
      readyCount += 1;
      if (readyCount < 2) {
        await new Promise<void>(resolve => readyResolvers.push(resolve));
      } else {
        readyResolvers.splice(0).forEach(resolve => resolve());
      }

      for (const create of stagedCreates) {
        if (createdDocumentKeys.has(create.reference.key)) {
          throw new Error(`Document already exists: ${create.reference.key}`);
        }
      }
      for (const create of stagedCreates) {
        createdDocumentKeys.add(create.reference.key);
        if (create.reference.key.startsWith("deviceSessionTokenClaims/")) {
          createdTokenClaimIds.push(create.reference.key.split("/")[1] ?? "");
        }
      }
      return result;
    }
  } as unknown as Firestore;

  return { firestore, createdTokenClaimIds };
}

function createConcurrentRootFirestore(): {
  firestore: Firestore;
  rootIds(): string[];
} {
  type Ref = { key: string; id: string };
  type Query = { collection: string; filters: Array<[string, unknown]>; limit?: number };
  const documents = new Map<string, Record<string, unknown>>();
  const versions = new Map<string, number>();
  const references = new Map<string, Ref>();
  let firstAttemptCount = 0;
  const barrier: Array<() => void> = [];
  const reference = (collection: string, id: string): Ref => {
    const key = `${collection}/${id}`;
    const existing = references.get(key);
    if (existing) return existing;
    const created = { key, id };
    references.set(key, created);
    return created;
  };
  const queryBuilder = (query: Query): unknown => ({
    __query: query,
    where(field: string, _operator: string, value: unknown) {
      return queryBuilder({ ...query, filters: [...query.filters, [field, value]] });
    },
    limit(value: number) { return queryBuilder({ ...query, limit: value }); }
  });
  const snapshot = (ref: Ref) => ({
    id: ref.id,
    ref,
    exists: documents.has(ref.key),
    data: () => documents.get(ref.key)
  });

  const firestore = {
    collection(collection: string) {
      return {
        doc(id: string) { return reference(collection, id); },
        where(field: string, _operator: string, value: unknown) {
          return queryBuilder({ collection, filters: [[field, value]] });
        }
      };
    },
    async runTransaction(operation: (transaction: unknown) => Promise<unknown>) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reads = new Map<string, number>();
        const writes: Array<{ kind: "create" | "set" | "update" | "delete"; ref: Ref; value?: Record<string, unknown> }> = [];
        const result = await operation({
          async get(target: Ref | { __query?: Query }) {
            if ("key" in target) {
              reads.set(target.key, versions.get(target.key) ?? 0);
              return snapshot(target);
            }
            const query = target.__query;
            if (!query) throw new Error("Unexpected root transaction query");
            const docs = [...documents.entries()]
              .filter(([key]) => key.startsWith(`${query.collection}/`))
              .filter(([, value]) => query.filters.every(([field, expected]) => value[field] === expected))
              .slice(0, query.limit ?? Number.POSITIVE_INFINITY)
              .map(([key]) => snapshot(reference(query.collection, key.split("/")[1]!)));
            return { docs };
          },
          create(ref: Ref, value: Record<string, unknown>) { writes.push({ kind: "create", ref, value }); },
          set(ref: Ref, value: Record<string, unknown>) { writes.push({ kind: "set", ref, value }); },
          update(ref: Ref, value: Record<string, unknown>) { writes.push({ kind: "update", ref, value }); },
          delete(ref: Ref) { writes.push({ kind: "delete", ref }); }
        });

        if (attempt === 0) {
          firstAttemptCount += 1;
          if (firstAttemptCount < 2) await new Promise<void>(resolve => barrier.push(resolve));
          else barrier.splice(0).forEach(resolve => resolve());
        }
        if ([...reads].some(([key, version]) => (versions.get(key) ?? 0) !== version)) continue;
        for (const write of writes) {
          if (write.kind === "create" && documents.has(write.ref.key)) throw new Error("document already exists");
          if (write.kind === "delete") documents.delete(write.ref.key);
          else if (write.kind === "update") documents.set(write.ref.key, { ...documents.get(write.ref.key), ...write.value });
          else documents.set(write.ref.key, write.value!);
          versions.set(write.ref.key, (versions.get(write.ref.key) ?? 0) + 1);
        }
        return result;
      }
      throw new Error("transaction retry exhausted");
    }
  } as unknown as Firestore;

  return {
    firestore,
    rootIds: () => [...documents.keys()].filter(key => key.startsWith("roots/")).map(key => key.slice("roots/".length))
  };
}

function makeSource(): Source {
  return {
    id: "s1",
    householdId: "h1",
    provider: "google",
    providerAccountId: "synthetic-account-a",
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
