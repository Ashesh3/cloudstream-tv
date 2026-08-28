import { describe, expect, it } from "vitest";

import {
  buildControlPlaneMigrationPlan,
  createMigrationFirestoreReader,
  restoreControlPlane,
  runControlPlaneMigration,
  type LegacyControlPlaneReader
} from "../scripts/lib/control-plane-ops";
import {
  MemoryControlDurableStore,
  createMemoryControlHotCache
} from "../packages/server/src/control-plane/memory";
import { TEST_NOW, testAeadKeyring, testControlDocument } from "./helpers/control-plane";

describe("control-plane operations", () => {
  it("reads only the five migration collections in deterministic order", async () => {
    const reader = migrationReader();

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW);

    expect(reader.collectionsRead).toEqual([
      "households",
      "deviceRequests",
      "devices",
      "sources",
      "roots"
    ]);
    expect(plan.document.schemaVersion).toBe(2);
    expect(plan.document.devices["device-1"]).not.toHaveProperty("lastSeenAt");
    expect(plan.document.devices["device-1"].sessionVersion).toBe(1);
    expect(plan.document.sources["source-1"].credentialVersion).toBe(1);
    expect(plan.document.pendingDeviceRequests).toHaveProperty("request-pending");
    expect(plan.document.pendingDeviceRequests).not.toHaveProperty("request-expired");
  });

  it("converts Firestore Timestamp-like values to strict ISO timestamps", async () => {
    const reader = migrationReader();
    reader.records.devices[0].createdAt = timestampLike(TEST_NOW);
    reader.records.devices[0].approvedAt = timestampLike(TEST_NOW);
    reader.records.sources[0].createdAt = timestampLike(TEST_NOW);
    reader.records.roots[0].createdAt = timestampLike(TEST_NOW);

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW);

    expect(plan.document.devices["device-1"].createdAt).toBe(TEST_NOW.toISOString());
    expect(plan.document.sources["source-1"].createdAt).toBe(TEST_NOW.toISOString());
  });

  it("requires verified provider identities and filters roots and assignments", async () => {
    const reader = migrationReader();
    reader.records.sources.push({
      ...reader.records.sources[0],
      id: "source-unverified",
      providerAccountId: null
    });
    reader.records.roots.push({
      id: "root-disabled",
      householdId: "h1",
      sourceId: "source-1",
      providerNodeId: "disabled-provider-root",
      displayName: "Disabled root",
      ancestryProviderIds: [],
      enabled: false,
      createdAt: TEST_NOW
    });
    reader.records.devices[0].assignedRootIds = ["root-1", "root-disabled"];

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW);

    expect(plan.document.sources).not.toHaveProperty("source-unverified");
    expect(plan.document.roots).not.toHaveProperty("root-disabled");
    expect(plan.document.devices["device-1"].assignedRootIds).toEqual(["root-1"]);
  });

  it("maps legacy indexing failures without inventing OAuth invalidity", async () => {
    const reader = migrationReader();
    reader.records.sources[0].status = "error";
    reader.records.sources[0].lastSyncErrorCode = "PROVIDER_QUOTA_EXCEEDED";

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW);

    expect(plan.document.sources["source-1"].status).toBe("healthy");
  });

  it("produces deterministic logical checksums despite randomized ciphertext", async () => {
    const first = await runControlPlaneMigration({
      apply: false,
      environment: "preview",
      householdId: "h1",
      now: TEST_NOW,
      firestore: migrationReader(),
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring()
    });
    const second = await runControlPlaneMigration({
      apply: false,
      environment: "preview",
      householdId: "h1",
      now: TEST_NOW,
      firestore: migrationReader(),
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring()
    });

    expect(first).toEqual(second);
    expect(Object.keys(first)).toEqual(["apply", "householdId", "revision", "counts", "checksum"]);
    expect(JSON.stringify(first)).not.toMatch(/token|hash|provider|ciphertext|secret/i);
  });

  it("migration apply writes and verifies Blob, cache, and one recovery document", async () => {
    const firestore = migrationReader();
    const durable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    const cache = createMemoryControlHotCache();

    const result = await runControlPlaneMigration({
      apply: true,
      environment: "production",
      householdId: "h1",
      now: TEST_NOW,
      firestore,
      durable,
      cache,
      keyring: testAeadKeyring()
    });

    expect(result.apply).toBe(true);
    expect(firestore.documentWrites).toEqual(["controlPlaneBackups/h1"]);
    expect(firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
    expect(durable.currentRevision).toBe(1);
    expect(cache.currentRevision).toBe(1);
  });

  it("does not write Blob when the verified recovery copy cannot be established", async () => {
    const firestore = migrationReader();
    const durable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    firestore.writeFailure = true;
    const cache = createMemoryControlHotCache();

    await expect(runControlPlaneMigration({
      apply: true,
      environment: "production",
      householdId: "h1",
      now: TEST_NOW,
      firestore,
      durable,
      cache,
      keyring: testAeadKeyring()
    })).rejects.toThrow();

    expect(durable.currentRevision).toBeUndefined();
    expect(firestore.documentWrites).toEqual([]);
  });

  it("does not overwrite an existing active snapshot when recovery write fails", async () => {
    const firestore = migrationReader();
    firestore.writeFailure = true;
    const current = testControlDocument();
    const durable = new MemoryControlDurableStore({
      envelope: (await import("@cloudframe/server")).encryptControlPlaneDocument(
        current,
        testAeadKeyring()
      ),
      etag: "etag-1"
    }, 0, testAeadKeyring().keys);

    await expect(runControlPlaneMigration({
      apply: true,
      environment: "production",
      householdId: "h1",
      now: TEST_NOW,
      firestore,
      durable,
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring()
    })).rejects.toThrow("RECOVERY_WRITE_FAILED");

    expect(durable.currentRevision).toBe(1);
    expect(durable.currentDocument?.devices["device-1"]?.name).toBe("Living Room");
  });

  it("refuses a different existing active snapshot without replacing it", async () => {
    const firestore = migrationReader();
    const current = testControlDocument();
    const durable = new MemoryControlDurableStore({
      envelope: (await import("@cloudframe/server")).encryptControlPlaneDocument(
        current,
        testAeadKeyring()
      ),
      etag: "etag-1"
    }, 0, testAeadKeyring().keys);

    await expect(runControlPlaneMigration({
      apply: true,
      environment: "production",
      householdId: "h1",
      now: TEST_NOW,
      firestore,
      durable,
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring()
    })).rejects.toThrow("CONTROL_PLANE_OVERWRITE_REFUSED");

    expect(durable.currentDocument?.devices["device-1"]?.name).toBe("Living Room");
  });

  it("restore dry run reads exactly one recovery document and never writes", async () => {
    const firestore = recoveryReader(testControlDocument());
    const durable = new MemoryControlDurableStore(null);
    const cache = createMemoryControlHotCache();

    const result = await restoreControlPlane({
      apply: false,
      environment: "preview",
      householdId: "h1",
      firestore,
      durable,
      cache,
      keyring: testAeadKeyring()
    });

    expect(firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
    expect(firestore.documentWrites).toEqual([]);
    expect(durable.currentRevision).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/token|hash|provider|ciphertext|secret/i);
  });

  it("restore apply writes Blob and cache but never Firestore", async () => {
    const firestore = recoveryReader(testControlDocument());
    const durable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    const cache = createMemoryControlHotCache();

    await restoreControlPlane({
      apply: true,
      environment: "production",
      householdId: "h1",
      firestore,
      durable,
      cache,
      keyring: testAeadKeyring()
    });

    expect(firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
    expect(firestore.documentWrites).toEqual([]);
    expect(durable.currentRevision).toBe(1);
    expect(cache.currentRevision).toBe(1);
  });

  it("rejects unapproved namespaces before any operation", async () => {
    const firestore = migrationReader();

    await expect(runControlPlaneMigration({
      apply: false,
      environment: "staging",
      householdId: "h1",
      now: TEST_NOW,
      firestore,
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring()
    })).rejects.toThrow("CONTROL_PLANE_ENV_INVALID");
    expect(firestore.collectionsRead).toEqual([]);
  });

  it("uses only named collections and exact recovery documents in the production adapter", async () => {
    const firestore = recordingMigrationFirestore();
    const reader = createMigrationFirestoreReader(firestore.client);

    await reader.listCollection("devices");
    await reader.readRecovery("controlPlaneBackups/h1");
    await reader.writeRecovery("controlPlaneBackups/h1", testControlDocument());

    expect(firestore.operations).toEqual([
      ["list", "devices"],
      ["read", "controlPlaneBackups", "h1"],
      ["write", "controlPlaneBackups", "h1"]
    ]);
  });
});

function migrationReader() {
  const records: Record<string, Array<Record<string, any>>> = {
    households: [{
      id: "h1",
      adminPassphraseHash: "argon2-test-hash",
      adminPassphraseVersion: 2,
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8,
      createdAt: TEST_NOW
    }],
    deviceRequests: [{
      id: "request-pending",
      householdId: "h1",
      requestSecretHash: "request-secret-hash",
      requestedName: "Bedroom",
      status: "pending",
      createdAt: TEST_NOW,
      expiresAt: new Date(TEST_NOW.getTime() + 60_000),
      resolvedAt: null,
      approvedDeviceId: null
    }, {
      id: "request-expired",
      householdId: "h1",
      requestSecretHash: "expired-secret-hash",
      requestedName: "Expired",
      status: "pending",
      createdAt: TEST_NOW,
      expiresAt: new Date(TEST_NOW.getTime() - 1),
      resolvedAt: null,
      approvedDeviceId: null
    }],
    devices: [{
      id: "device-1",
      householdId: "h1",
      name: "Living Room",
      enabled: true,
      assignedRootIds: ["root-1"],
      mediaOrder: null,
      slideshowSeconds: null,
      createdAt: TEST_NOW,
      approvedAt: TEST_NOW,
      lastSeenAt: TEST_NOW,
      revokedAt: null
    }],
    sources: [{
      id: "source-1",
      householdId: "h1",
      provider: "google",
      providerAccountId: "account-1",
      providerRootId: "provider-root",
      accountLabel: "family@example.test",
      encryptedRefreshToken: encrypted(1),
      encryptedAccessToken: null,
      accessTokenExpiresAt: null,
      status: "syncing",
      createdAt: TEST_NOW,
      crawlCheckpoint: { mode: "initial" }
    }],
    roots: [{
      id: "root-1",
      householdId: "h1",
      sourceId: "source-1",
      providerNodeId: "provider-trips",
      displayName: "Trips",
      ancestryProviderIds: ["provider-root"],
      enabled: true,
      createdAt: TEST_NOW
    }]
  };
  const collectionsRead: string[] = [];
  const documentReads: string[] = [];
  const documentWrites: string[] = [];
  const reader: LegacyControlPlaneReader & {
    records: typeof records;
    collectionsRead: string[];
    documentReads: string[];
    documentWrites: string[];
    recovery: unknown | null;
    writeFailure: boolean;
  } = {
    records,
    collectionsRead,
    documentReads,
    documentWrites,
    async listCollection(name) {
      collectionsRead.push(name);
      return (records[name] ?? []).map((record) => ({ ...record }));
    },
    async readRecovery(path) {
      documentReads.push(path);
      return reader.recovery ? structuredClone(reader.recovery) : null;
    },
    async writeRecovery(path, document) {
      if (reader.writeFailure) throw new Error("RECOVERY_WRITE_FAILED");
      documentWrites.push(path);
      reader.recovery = structuredClone(document);
    },
    recovery: null,
    writeFailure: false
  };
  return reader;
}

function recoveryReader(document: ReturnType<typeof testControlDocument>) {
  const reader = migrationReader();
  reader.recovery = structuredClone(document);
  return reader;
}

function encrypted(byte: number) {
  return {
    keyVersion: "v1",
    iv: Buffer.alloc(12, byte).toString("base64url"),
    ciphertext: Buffer.from(`cipher-${byte}`).toString("base64url"),
    authTag: Buffer.alloc(16, byte).toString("base64url")
  };
}

function timestampLike(value: Date) {
  return { toDate: () => new Date(value) };
}

function recordingMigrationFirestore() {
  const operations: unknown[][] = [];
  const client = {
    collection(name: string) {
      return {
        async get() {
          operations.push(["list", name]);
          return { docs: [] };
        },
        doc(id: string) {
          return {
            async get() {
              operations.push(["read", name, id]);
              return { id, exists: false, data: () => undefined };
            },
            async set(_value: unknown) {
              void _value;
              operations.push(["write", name, id]);
            }
          };
        }
      };
    }
  };
  return { client, operations };
}
