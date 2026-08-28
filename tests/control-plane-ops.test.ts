import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildControlPlaneMigrationPlan,
  createMigrationFirestoreReader,
  loadOperatorCredentials,
  loadProviderTokenKeys,
  restoreControlPlane,
  runControlPlaneMigration,
  type LegacyControlPlaneReader
} from "../scripts/lib/control-plane-ops";
import {
  MemoryControlDurableStore,
  createMemoryControlHotCache
} from "../packages/server/src/control-plane/memory";
import { TEST_NOW, testAeadKeyring, testControlDocument } from "./helpers/control-plane";
import { encryptProviderToken } from "@cloudframe/server";
import { createCipheriv } from "node:crypto";

describe("control-plane operations", () => {
  it("reads only the five migration collections in deterministic order", async () => {
    const reader = migrationReader();

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys());

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

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys());

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

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys());

    expect(plan.document.sources).not.toHaveProperty("source-unverified");
    expect(plan.document.roots).not.toHaveProperty("root-disabled");
    expect(plan.document.devices["device-1"].assignedRootIds).toEqual(["root-1"]);
  });

  it("maps legacy indexing failures without inventing OAuth invalidity", async () => {
    const reader = migrationReader();
    reader.records.sources[0].status = "error";
    reader.records.sources[0].lastSyncErrorCode = "PROVIDER_QUOTA_EXCEEDED";

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys());

    expect(plan.document.sources["source-1"].status).toBe("healthy");
  });

  it("does not infer OAuth invalidity from future migration markers", async () => {
    const reader = migrationReader();
    reader.records.sources[0].status = "error";
    reader.records.sources[0].lastSyncErrorCode = "MIGRATION_FUTURE_DIAGNOSTIC";

    const plan = await buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys());

    expect(plan.document.sources["source-1"].status).toBe("healthy");
  });

  it("normalizes bootstrap access tokens as an atomic unexpired pair", async () => {
    const valid = migrationReader();
    valid.records.sources[0].encryptedAccessToken = stableEncrypted("access-token", "v2");
    valid.records.sources[0].accessTokenExpiresAt = new Date(TEST_NOW.getTime() + 60_000);
    const validPlan = await buildControlPlaneMigrationPlan(valid, "h1", TEST_NOW, providerKeys());
    expect(validPlan.document.sources["source-1"].encryptedBootstrapAccessToken?.keyVersion).toBe("v2");
    await expect(restoreControlPlane({
      apply: false, environment: "preview", householdId: "h1",
      firestore: recoveryReader(validPlan.document), durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).resolves.toMatchObject({ apply: false });

    const half = migrationReader();
    half.records.sources[0].encryptedAccessToken = stableEncrypted("access-token", "v1");
    const halfPlan = await buildControlPlaneMigrationPlan(half, "h1", TEST_NOW, providerKeys());
    expect(halfPlan.document.sources["source-1"].encryptedBootstrapAccessToken).toBeNull();
    expect(halfPlan.document.sources["source-1"].bootstrapAccessTokenExpiresAt).toBeNull();

    const expired = migrationReader();
    expired.records.sources[0].encryptedAccessToken = stableEncrypted("access-token", "v1");
    expired.records.sources[0].accessTokenExpiresAt = new Date(TEST_NOW.getTime() - 1);
    const expiredPlan = await buildControlPlaneMigrationPlan(expired, "h1", TEST_NOW, providerKeys());
    expect(expiredPlan.document.sources["source-1"].encryptedBootstrapAccessToken).toBeNull();
  });

  it("rejects malformed, unavailable-key, and tampered provider secrets", async () => {
    for (const mutate of [
      (reader: ReturnType<typeof migrationReader>) => { reader.records.sources[0].encryptedRefreshToken.iv = "***"; },
      (reader: ReturnType<typeof migrationReader>) => { reader.records.sources[0].encryptedRefreshToken.keyVersion = "missing"; },
      (reader: ReturnType<typeof migrationReader>) => { reader.records.sources[0].encryptedRefreshToken.authTag = Buffer.alloc(16, 3).toString("base64url"); }
    ]) {
      const reader = migrationReader();
      mutate(reader);
      await expect(buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys()))
        .rejects.toThrow("PROVIDER_TOKEN_INVALID");
    }
  });

  it("rejects reserved and duplicate IDs", async () => {
    for (const id of ["__proto__", "constructor", "prototype"]) {
      const reader = migrationReader();
      reader.records.devices[0].id = id;
      await expect(buildControlPlaneMigrationPlan(reader, "h1", TEST_NOW, providerKeys())).rejects.toThrow();
    }
    const duplicate = migrationReader();
    duplicate.records.devices.push({ ...duplicate.records.devices[0] });
    await expect(buildControlPlaneMigrationPlan(duplicate, "h1", TEST_NOW, providerKeys())).rejects.toThrow();
  });

  it("produces deterministic logical checksums despite randomized ciphertext", async () => {
    const fixture = migrationReader();
    const first = await runControlPlaneMigration({
      apply: false,
      environment: "preview",
      householdId: "h1",
      now: TEST_NOW,
      firestore: cloneMigrationReader(fixture),
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });
    const second = await runControlPlaneMigration({
      apply: false,
      environment: "preview",
      householdId: "h1",
      now: TEST_NOW,
      firestore: cloneMigrationReader(fixture),
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
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
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });

    expect(result.apply).toBe(true);
    expect(firestore.documentWrites).toEqual(["controlPlaneBackups/h1"]);
    expect(firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
    expect(durable.currentRevision).toBe(1);
    expect(cache.currentRevision).toBe(1);
  });

  it("reports incomplete recovery after a committed Blob when recovery cannot be established", async () => {
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
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow();

    expect(durable.currentRevision).toBe(1);
    expect(firestore.documentWrites).toEqual([]);
  });

  it("preflight conflict and Blob failures leave the recovery document untouched", async () => {
    const conflictFirestore = migrationReader();
    const conflictDurable = new MemoryControlDurableStore({
      envelope: { broken: true } as never, etag: "etag-1"
    }, 1, testAeadKeyring().keys);
    await expect(runControlPlaneMigration({
      apply: true, environment: "preview", householdId: "h1", now: TEST_NOW,
      firestore: conflictFirestore, durable: conflictDurable,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow();
    expect(conflictFirestore.documentWrites).toEqual([]);

    const failedFirestore = migrationReader();
    const failedDurable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    failedDurable.create = async () => { throw new Error("blob transport secret"); };
    await expect(runControlPlaneMigration({
      apply: true, environment: "preview", householdId: "h1", now: TEST_NOW,
      firestore: failedFirestore, durable: failedDurable,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_BLOB_UNAVAILABLE");
    expect(failedFirestore.documentWrites).toEqual([]);
  });

  it("does not overwrite an existing active snapshot when recovery write fails", async () => {
    const firestore = migrationReader();
    firestore.writeFailure = true;
    const plan = await buildControlPlaneMigrationPlan(
      firestore, "h1", TEST_NOW, providerKeys()
    );
    firestore.collectionsRead.splice(0);
    const current = plan.document;
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
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_RECOVERY_INCOMPLETE");

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
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_OVERWRITE_REFUSED");

    expect(durable.currentDocument?.devices["device-1"]?.name).toBe("Living Room");
  });

  it("restore dry run reads exactly one recovery document and never writes", async () => {
    const firestore = recoveryReader(migratedControlDocument());
    const durable = new MemoryControlDurableStore(null);
    const cache = createMemoryControlHotCache();

    const result = await restoreControlPlane({
      apply: false,
      environment: "preview",
      householdId: "h1",
      firestore,
      durable,
      cache,
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });

    expect(firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
    expect(firestore.documentWrites).toEqual([]);
    expect(durable.currentRevision).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/token|hash|provider|ciphertext|secret/i);
  });

  it("emits one secret-safe restore-read event and ignores observer failures", async () => {
    const events: unknown[] = [];
    const firestore = recoveryReader(migratedControlDocument());
    await restoreControlPlane({
      apply: false,
      environment: "preview",
      householdId: "h1",
      firestore,
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring(),
      providerTokenKeys: providerKeys(),
      requestId: "restore-1",
      observer: { emit: event => events.push(event) }
    });
    expect(events).toEqual([{
      level: "info",
      event: "control_plane_restore_read",
      requestId: "restore-1",
      householdId: "h1",
      count: 1
    }]);
    expect(JSON.stringify(events)).not.toMatch(/ciphertext|authTag|token|providerNodeId/);

    await expect(restoreControlPlane({
      apply: false,
      environment: "preview",
      householdId: "h1",
      firestore: recoveryReader(migratedControlDocument()),
      durable: new MemoryControlDurableStore(null),
      cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring(),
      providerTokenKeys: providerKeys(),
      observer: { emit: () => { throw new Error("observer failed"); } }
    })).resolves.toMatchObject({ apply: false });
  });

  it("restore apply writes Blob and cache but never Firestore", async () => {
    const firestore = recoveryReader(migratedControlDocument());
    const durable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    const cache = createMemoryControlHotCache();

    await restoreControlPlane({
      apply: true,
      environment: "production",
      householdId: "h1",
      firestore,
      durable,
      cache,
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });

    expect(firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
    expect(firestore.documentWrites).toEqual([]);
    expect(durable.currentRevision).toBe(1);
    expect(cache.currentRevision).toBe(1);
  });

  it("restore repairs missing and corrupt active snapshots with CAS", async () => {
    const document = migratedControlDocument();
    const missing = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    await restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(document), durable: missing,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });
    expect(missing.currentRevision).toBe(1);

    const corrupt = new MemoryControlDurableStore({
      envelope: { broken: "secret-ciphertext" } as never,
      etag: "etag-1"
    }, 0, testAeadKeyring().keys);
    await restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(document), durable: corrupt,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });
    expect(corrupt.currentRevision).toBe(1);
    expect(corrupt.writeAttempts).toBe(1);
  });

  it("restore repairs an active snapshot sealed with an unavailable old key", async () => {
    const recovery = migratedControlDocument();
    const oldKeyring = { currentVersion: "old", keys: { old: Buffer.alloc(32, 6) } };
    const durable = new MemoryControlDurableStore({
      envelope: (await import("@cloudframe/server")).encryptControlPlaneDocument(recovery, oldKeyring),
      etag: "etag-1"
    }, 0, testAeadKeyring().keys);

    await restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(recovery), durable,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });

    expect(durable.currentRevision).toBe(1);
    expect(durable.writeAttempts).toBe(1);
  });

  it("restore refuses a newer valid active snapshot and concurrent ETag changes", async () => {
    const recovery = migratedControlDocument();
    const newer = migratedControlDocument();
    newer.revision = 2;
    const durable = new MemoryControlDurableStore({
      envelope: (await import("@cloudframe/server")).encryptControlPlaneDocument(newer, testAeadKeyring()),
      etag: "etag-1"
    }, 0, testAeadKeyring().keys);
    await expect(restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(recovery), durable,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_OVERWRITE_REFUSED");

    const concurrent = new MemoryControlDurableStore({
      envelope: { broken: true } as never, etag: "etag-1"
    }, 1, testAeadKeyring().keys);
    await expect(restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(recovery), durable: concurrent,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_CONFLICT");
  });

  it("restore fails closed when Blob inspection or body transport is unavailable", async () => {
    const document = migratedControlDocument();
    const inspectFailure = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    inspectFailure.inspect = async () => { throw new Error("auth token secret"); };
    await expect(restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(document), durable: inspectFailure,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_BLOB_UNAVAILABLE");

    const readFailure = new MemoryControlDurableStore({
      envelope: { broken: true } as never, etag: "etag-1"
    }, 0, testAeadKeyring().keys);
    readFailure.read = async () => { throw new Error("transport provider id secret"); };
    await expect(restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(document), durable: readFailure,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_BLOB_UNAVAILABLE");
  });

  it("treats cache replacement and eviction failures as best effort", async () => {
    const firestore = migrationReader();
    const cache = createMemoryControlHotCache(1);
    cache.delete = async () => { throw new Error("cache delete failure"); };
    const result = await runControlPlaneMigration({
      apply: true, environment: "preview", householdId: "h1", now: TEST_NOW,
      firestore, durable: new MemoryControlDurableStore(null, 0, testAeadKeyring().keys),
      cache, keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    });
    expect(result.apply).toBe(true);
    expect(firestore.documentWrites).toEqual(["controlPlaneBackups/h1"]);
  });

  it("repairs recovery on rerun after an identical active commit", async () => {
    const firestore = migrationReader();
    firestore.writeFailure = true;
    const durable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
    const options = {
      apply: true, environment: "preview", householdId: "h1", now: TEST_NOW,
      firestore, durable, cache: createMemoryControlHotCache(),
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    };
    await expect(runControlPlaneMigration(options)).rejects.toThrow("CONTROL_PLANE_RECOVERY_INCOMPLETE");
    firestore.writeFailure = false;
    await expect(runControlPlaneMigration(options)).resolves.toMatchObject({ apply: true });
    expect(durable.writeAttempts).toBe(0);
  });

  it("migration detects same-logical and different-body ETag races", async () => {
    for (const changed of [false, true]) {
      const firestore = migrationReader();
      const plan = await buildControlPlaneMigrationPlan(firestore, "h1", TEST_NOW, providerKeys());
      const concurrent = structuredClone(plan.document);
      if (changed) concurrent.household.allowNewDeviceRequests = false;
      const durable = new MemoryControlDurableStore({
        envelope: (await import("@cloudframe/server")).encryptControlPlaneDocument(plan.document, testAeadKeyring()),
        etag: "etag-1"
      }, 0, testAeadKeyring().keys);
      const originalRead = durable.read.bind(durable);
      let reads = 0;
      durable.read = async (...args) => {
        reads += 1;
        if (reads === 2) durable.replaceOutOfBand(concurrent);
        return originalRead(...args);
      };
      await expect(runControlPlaneMigration({
        apply: true, environment: "preview", householdId: "h1", now: TEST_NOW,
        firestore, durable, cache: createMemoryControlHotCache(),
        keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
      })).rejects.toThrow("CONTROL_PLANE_CONFLICT");
    }
  });

  it("restore detects same-logical and different-body ETag races", async () => {
    for (const changed of [false, true]) {
      const recovery = migratedControlDocument();
      const durable = new MemoryControlDurableStore(null, 0, testAeadKeyring().keys);
      const originalRead = durable.read.bind(durable);
      const originalCreate = durable.create.bind(durable);
      durable.create = async (envelope) => {
        const committed = await originalCreate(envelope);
        const concurrent = structuredClone(recovery);
        if (changed) concurrent.household.allowNewDeviceRequests = false;
        durable.replaceOutOfBand(concurrent);
        return committed;
      };
      durable.read = async (...args) => {
        return originalRead(...args);
      };
      await expect(restoreControlPlane({
        apply: true, environment: "preview", householdId: "h1",
        firestore: recoveryReader(recovery), durable,
        cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
      })).rejects.toThrow("CONTROL_PLANE_CONFLICT");
    }
  });

  it("refuses same-revision recovery when active content differs", async () => {
    const recovery = migratedControlDocument();
    const active = structuredClone(recovery);
    active.household.allowNewDeviceRequests = !active.household.allowNewDeviceRequests;
    const durable = new MemoryControlDurableStore({
      envelope: (await import("@cloudframe/server")).encryptControlPlaneDocument(active, testAeadKeyring()),
      etag: "etag-1"
    }, 0, testAeadKeyring().keys);

    await expect(restoreControlPlane({
      apply: true, environment: "preview", householdId: "h1",
      firestore: recoveryReader(recovery), durable,
      cache: createMemoryControlHotCache(), keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_OVERWRITE_REFUSED");
  });

  it("requires a dedicated matching operator credential file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloudframe-operator-"));
    try {
      const email = "operator@project-1.iam.gserviceaccount.com";
      const service = join(directory, "service.json");
      await writeFile(service, JSON.stringify(validServiceCredential(email)));
      await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: service }))
        .resolves.toEqual({ keyFilename: service });
      await expect(loadOperatorCredentials({
        operatorEmail: email, credentialFile: service, runtimeWriterEmail: email
      })).rejects.toThrow("OPERATOR_IDENTITY_INVALID");
      await expect(loadOperatorCredentials({
        operatorEmail: "other@project-1.iam.gserviceaccount.com", credentialFile: service
      })).rejects.toThrow("OPERATOR_CREDENTIALS_INVALID");
      await expect(loadOperatorCredentials({
        operatorEmail: "OPERATOR@PROJECT-1.IAM.GSERVICEACCOUNT.COM", credentialFile: service
      })).resolves.toEqual({ keyFilename: service });

      const external = join(directory, "external.json");
      await writeFile(external, JSON.stringify(validExternalCredential(email)));
      await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: external }))
        .resolves.toEqual({ keyFilename: external });
      const urlExternal = join(directory, "external-url.json");
      await writeFile(urlExternal, JSON.stringify(validExternalCredential(email, {
        credential_source: {
          url: "https://metadata.example.test/token",
          format: { type: "json", subject_token_field_name: "value" }
        }
      })));
      await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: urlExternal }))
        .resolves.toEqual({ keyFilename: urlExternal });
      await expect(loadOperatorCredentials({ operatorEmail: undefined, credentialFile: external }))
        .rejects.toThrow("OPERATOR_IDENTITY_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unusable and mixed-case-reused operator credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloudframe-operator-invalid-"));
    const email = "operator@project-1.iam.gserviceaccount.com";
    try {
      const missing = join(directory, "missing.json");
      await writeFile(missing, JSON.stringify({ type: "service_account", client_email: email }));
      await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: missing }))
        .rejects.toThrow("OPERATOR_CREDENTIALS_INVALID");

      const malformedPem = join(directory, "pem.json");
      await writeFile(malformedPem, JSON.stringify({
        type: "service_account", project_id: "project-1", private_key_id: "key-1",
        private_key: "not-a-pem", client_email: email,
        client_id: "123", token_uri: "https://oauth2.googleapis.com/token"
      }));
      await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: malformedPem }))
        .rejects.toThrow("OPERATOR_CREDENTIALS_INVALID");

      const wif = join(directory, "wif.json");
      await writeFile(wif, JSON.stringify(validExternalCredential(email, { credential_source: {} })));
      await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: wif }))
        .rejects.toThrow("OPERATOR_CREDENTIALS_INVALID");

      const mixed = join(directory, "mixed.json");
      await writeFile(mixed, JSON.stringify(validServiceCredential("Operator@Project-1.Iam.Gserviceaccount.Com")));
      await expect(loadOperatorCredentials({
        operatorEmail: "Operator@Project-1.Iam.Gserviceaccount.Com", credentialFile: mixed,
        runtimeWriterEmail: "operator@project-1.iam.gserviceaccount.com"
      })).rejects.toThrow("OPERATOR_IDENTITY_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-canonical Google service-account principals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloudframe-email-invalid-"));
    const credential = join(directory, "credential.json");
    try {
      await writeFile(credential, JSON.stringify(validServiceCredential(
        "operator@project-1.iam.gserviceaccount.com"
      )));
      for (const email of [
        "operator@example",
        "x@bad-.com",
        "x@bad..iam.gserviceaccount.com",
        "x@example.com",
        `${"x".repeat(120)}@${"y".repeat(120)}.iam.gserviceaccount.com`
      ]) {
        await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: credential }))
          .rejects.toThrow("OPERATOR_IDENTITY_INVALID");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported and malformed WIF credential sources", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cloudframe-wif-invalid-"));
    const email = "operator@project-1.iam.gserviceaccount.com";
    try {
      const invalidSources = [
        { credential_source: { anything: "x" } },
        { credential_source: { file: "C:/token", url: "https://metadata.test/token", format: { type: "text" } } },
        { credential_source: { url: "javascript:alert(1)", format: { type: "text" } } },
        { credential_source: { url: "https://user:pass@metadata.test/token", format: { type: "text" } } },
        { credential_source: { url: "https://metadata.test/token#fragment", format: { type: "text" } } },
        { credential_source: { file: "C:/token", format: { type: "json" } } },
        { audience: "malformed-audience" }
      ];
      for (const [index, patch] of invalidSources.entries()) {
        const file = join(directory, `invalid-${index}.json`);
        await writeFile(file, JSON.stringify(validExternalCredential(email, patch)));
        await expect(loadOperatorCredentials({ operatorEmail: email, credentialFile: file }))
          .rejects.toThrow("OPERATOR_CREDENTIALS_INVALID");
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("loads documented uppercase provider key suffixes as canonical lowercase versions", () => {
    const keys = loadProviderTokenKeys({
      PROVIDER_TOKEN_KEY_VERSION: "v1",
      "PROVIDER_TOKEN_KEY_V1": Buffer.alloc(32, 1).toString("base64url"),
      "PROVIDER_TOKEN_KEY_OLD": Buffer.alloc(32, 2).toString("base64url")
    });
    expect(Object.keys(keys)).toEqual(["v1", "old"]);
    expect(keys.v1).toEqual(Buffer.alloc(32, 1));
  });

  it("rejects missing current provider keys and ambiguous version aliases", () => {
    expect(() => loadProviderTokenKeys({
      PROVIDER_TOKEN_KEY_V1: Buffer.alloc(32, 1).toString("base64url")
    })).toThrow("PROVIDER_TOKEN_KEYS_INVALID");
    expect(() => loadProviderTokenKeys({
      PROVIDER_TOKEN_KEY_VERSION: "v1",
      PROVIDER_TOKEN_KEY_V1: Buffer.alloc(32, 1).toString("base64url"),
      PROVIDER_TOKEN_KEY_old: Buffer.alloc(32, 2).toString("base64url")
    })).toThrow("PROVIDER_TOKEN_KEYS_INVALID");
    expect(() => loadProviderTokenKeys({
      PROVIDER_TOKEN_KEY_VERSION: "MiXeD",
      "PROVIDER_TOKEN_KEY_MIXED": Buffer.alloc(32, 1).toString("base64url")
    })).toThrow("PROVIDER_TOKEN_KEYS_INVALID");
    expect(() => loadProviderTokenKeys({
      PROVIDER_TOKEN_KEY_VERSION: "V1",
      "PROVIDER_TOKEN_KEY_V1": Buffer.alloc(32, 1).toString("base64url"),
      "PROVIDER_TOKEN_KEY_v1": Buffer.alloc(32, 2).toString("base64url")
    })).toThrow("PROVIDER_TOKEN_KEYS_INVALID");
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
      keyring: testAeadKeyring(), providerTokenKeys: providerKeys()
    })).rejects.toThrow("CONTROL_PLANE_ENV_INVALID");
    expect(firestore.collectionsRead).toEqual([]);
  });

  it("uses only named collections and exact recovery documents in the production adapter", async () => {
    const firestore = recordingMigrationFirestore();
    const reader = createMigrationFirestoreReader(firestore.client);

    await reader.readHousehold("h1");
    await reader.queryHouseholdCollection("devices", "h1");
    await reader.readRecovery("controlPlaneBackups/h1");
    await reader.writeRecovery("controlPlaneBackups/h1", testControlDocument());

    expect(firestore.operations).toEqual([
      ["read", "households", "h1"],
      ["query", "devices", "householdId", "h1"],
      ["read", "controlPlaneBackups", "h1"],
      ["write", "controlPlaneBackups", "h1"]
    ]);
  });

  it("production migration adapter never returns unrelated household records", async () => {
    const operations: unknown[][] = [];
    const client = {
      collection(name: string) {
        let householdId = "";
        const collection = {
          where(_field: string, _operator: "==", value: unknown) {
            householdId = String(value);
            return collection;
          },
          async get() {
            operations.push([name, householdId]);
            return { docs: householdId === "h1" ? [{
              id: "device-h1", exists: true,
              data: () => ({ householdId: "h1" })
            }] : [] };
          },
          doc(id: string) {
            return { async get() { return { id, exists: false, data: () => undefined }; }, async set() {} };
          }
        };
        return collection;
      }
    };
    const reader = createMigrationFirestoreReader(client);
    const records = await reader.queryHouseholdCollection("devices", "h1");

    expect(records).toEqual([{ id: "device-h1", householdId: "h1" }]);
    expect(operations).toEqual([["devices", "h1"]]);
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
      encryptedRefreshToken: stableEncrypted("refresh-token", "v1"),
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
    async readHousehold(id) {
      collectionsRead.push("households");
      return records.households.find((record) => record.id === id) ?? null;
    },
    async queryHouseholdCollection(name, id) {
      collectionsRead.push(name);
      return (records[name] ?? [])
        .filter((record) => record.householdId === id)
        .map((record) => ({ ...record }));
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

function migratedControlDocument() {
  const document = testControlDocument();
  document.sources["source-1"].encryptedRefreshToken = encrypted("refresh-token", "v1");
  return document;
}

function cloneMigrationReader(source: ReturnType<typeof migrationReader>) {
  const clone = migrationReader();
  clone.records = source.records;
  return clone;
}

function providerKeys() {
  return { v1: Buffer.alloc(32, 9), v2: Buffer.alloc(32, 10) };
}

function encrypted(value: string, version: "v1" | "v2") {
  return encryptProviderToken(value, {
    currentVersion: version,
    keys: providerKeys()
  });
}

function stableEncrypted(value: string, version: "v1" | "v2") {
  const iv = Buffer.alloc(12, version === "v1" ? 1 : 2);
  const cipher = createCipheriv("aes-256-gcm", providerKeys()[version], iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    keyVersion: version,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
}

function timestampLike(value: Date) {
  return { toDate: () => new Date(value) };
}

function validServiceCredential(email: string) {
  return {
    type: "service_account",
    project_id: "project-1",
    private_key_id: "key-1",
    private_key: "-----BEGIN PRIVATE KEY-----\nQUJDRA==\n-----END PRIVATE KEY-----\n",
    client_email: email,
    client_id: "123456789",
    token_uri: "https://oauth2.googleapis.com/token"
  };
}

function validExternalCredential(
  email: string,
  patch: Record<string, unknown> = {}
) {
  return {
    type: "external_account",
    audience: "//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/provider",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    credential_source: { file: "C:/secure/oidc-token", format: { type: "text" } },
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email.toLowerCase())}:generateAccessToken`,
    ...patch
  };
}

function recordingMigrationFirestore() {
  const operations: unknown[][] = [];
  const client = {
    collection(name: string) {
      let field = "";
      let value: unknown;
      const collection = {
        where(nextField: string, _operator: "==", nextValue: unknown) {
          field = nextField;
          value = nextValue;
          return collection;
        },
        async get() {
          operations.push(["query", name, field, value]);
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
      return collection;
    }
  };
  return { client, operations };
}
