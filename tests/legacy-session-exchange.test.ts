import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createLegacySessionExchange,
  createFirestoreLegacySessionReader,
  type LegacySessionReader
} from "@cloudframe/server";
import { createSealedSessionCodec } from "@cloudframe/server";
import { TEST_NOW, testAeadKeyring, testControlDocument } from "./helpers/control-plane";
import { readFile } from "node:fs/promises";

describe("legacy session exchange", () => {
  it("exchanges a valid device cookie once with zero writes", async () => {
    const harness = exchangeHarness();

    const result = await harness.exchange.exchangeDevice("legacy-device-token", TEST_NOW);

    expect(result?.sealedCookie).toBeTruthy();
    expect(harness.reader.readCount).toBeGreaterThan(0);
    expect(harness.reader.writeCount).toBe(0);
    await expect(harness.exchange.exchangeDevice(result!.sealedCookie, TEST_NOW)).resolves.toBeNull();
    expect(harness.reader.readCount).toBe(3);
  });

  it("exchanges a valid admin cookie bounded by the legacy expiry", async () => {
    const harness = exchangeHarness();

    const result = await harness.exchange.exchangeAdmin("legacy-admin-token", TEST_NOW);
    const claims = harness.codec.openAdmin(result!.sealedCookie);

    expect(claims.expiresAt).toBe(harness.reader.adminSession.expiresAt.getTime());
    expect(claims.adminPassphraseVersion).toBe(2);
    expect(harness.reader.writeCount).toBe(0);
  });

  it("fails closed on duplicate token hashes", async () => {
    const harness = exchangeHarness();
    harness.reader.deviceMatches = 2;

    await expect(harness.exchange.exchangeDevice("legacy-device-token", TEST_NOW)).resolves.toBeNull();

    expect(harness.reader.readCount).toBe(1);
  });

  it("rejects malformed, oversized, and current sealed tokens before Firestore", async () => {
    const harness = exchangeHarness();
    const current = harness.codec.issueDevice({
      version: 2,
      householdId: "h1",
      deviceId: "device-1",
      sessionVersion: 1,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 60_000
    });

    await expect(harness.exchange.exchangeDevice("contains whitespace", TEST_NOW)).resolves.toBeNull();
    await expect(harness.exchange.exchangeDevice("x".repeat(4097), TEST_NOW)).resolves.toBeNull();
    await expect(harness.exchange.exchangeDevice(current, TEST_NOW)).resolves.toBeNull();

    expect(harness.reader.readCount).toBe(0);
  });

  it("fails closed when a reader or active control lookup fails", async () => {
    const readerFailure = exchangeHarness();
    readerFailure.reader.findDeviceSessionsByTokenHash = async () => {
      throw new Error("reader failure with secret detail");
    };
    await expect(readerFailure.exchange.exchangeDevice("legacy-device-token", TEST_NOW)).resolves.toBeNull();

    const controlFailure = exchangeHarness(() => Promise.reject(new Error("blob failure")));
    await expect(controlFailure.exchange.exchangeAdmin("legacy-admin-token", TEST_NOW)).resolves.toBeNull();
  });

  it("validates legacy records against active V2 authorization", async () => {
    const harness = exchangeHarness();
    harness.control.devices["device-1"].enabled = false;

    await expect(harness.exchange.exchangeDevice("legacy-device-token", TEST_NOW)).resolves.toBeNull();

    expect(harness.reader.writeCount).toBe(0);
  });

  it("rejects a legacy device whose current V2 root assignment was filtered out", async () => {
    const harness = exchangeHarness();
    harness.reader.device.assignedRootIds = ["root-1", "legacy-filtered-root"];

    await expect(harness.exchange.exchangeDevice("legacy-device-token", TEST_NOW)).resolves.toBeNull();
  });

  it("rejects stale passphrase, session, device, and household relationships", async () => {
    const admin = exchangeHarness();
    admin.reader.adminSession.passphraseVersion = 1;
    await expect(admin.exchange.exchangeAdmin("legacy-admin-token", TEST_NOW)).resolves.toBeNull();

    const device = exchangeHarness();
    device.reader.device.enabled = false;
    await expect(device.exchange.exchangeDevice("legacy-device-token", TEST_NOW)).resolves.toBeNull();

    const wrongHousehold = exchangeHarness();
    wrongHousehold.reader.deviceSession.householdId = "other";
    await expect(wrongHousehold.exchange.exchangeDevice("legacy-device-token", TEST_NOW)).resolves.toBeNull();
  });

  it("keeps the concrete Firestore reader narrow, duplicate-aware, and read-only", async () => {
    const firestore = recordingFirestore();
    const reader = createFirestoreLegacySessionReader(firestore.client);

    await reader.findAdminSessionsByTokenHash("hash");
    await reader.findDeviceSessionsByTokenHash("hash");
    await reader.readHousehold("h1");
    await reader.readDevice("device-1");

    expect(firestore.operations).toEqual([
      ["query", "adminSessions", "tokenHash", "hash", 2],
      ["query", "deviceSessions", "tokenHash", "hash", 2],
      ["read", "households", "h1"],
      ["read", "devices", "device-1"]
    ]);
    const source = await readFile(
      "packages/server/src/control-plane/legacy-session-exchange.ts",
      "utf8"
    );
    expect(source).not.toContain("FirestoreRepository");
    expect(source).not.toContain("authenticateAdminSession");
    expect(source).not.toContain("authenticateDeviceSession");
    expect(source).not.toMatch(/runTransaction|transaction\.(set|create|update|delete)|firestore\.(set|create|update|delete)/);
  });
});

function exchangeHarness(
  loadControlDocument?: () => Promise<ReturnType<typeof testControlDocument>>
) {
  const codec = createSealedSessionCodec(testAeadKeyring(), () => TEST_NOW);
  const control = testControlDocument();
  control.household.adminPassphraseVersion = 2;
  const reader = new RecordingLegacyReader();
  return {
    codec,
    control,
    reader,
    exchange: createLegacySessionExchange({
      reader,
      codec,
      householdId: "h1",
      loadControlDocument: loadControlDocument ?? (async () => structuredClone(control)),
      sessionLifetimeMs: 365 * 24 * 60 * 60 * 1000
    })
  };
}

class RecordingLegacyReader implements LegacySessionReader {
  readCount = 0;
  writeCount = 0;
  deviceMatches = 1;
  adminSession = {
    id: "admin-session-1",
    householdId: "h1",
    tokenHash: digest("legacy-admin-token"),
    passphraseVersion: 2,
    createdAt: TEST_NOW,
    lastSeenAt: TEST_NOW,
    expiresAt: new Date(TEST_NOW.getTime() + 30_000),
    revokedAt: null
  };
  deviceSession = {
    id: "device-session-1",
    householdId: "h1",
    deviceId: "device-1",
    tokenHash: digest("legacy-device-token"),
    createdAt: TEST_NOW,
    lastSeenAt: TEST_NOW,
    expiresAt: new Date(TEST_NOW.getTime() + 30_000),
    revokedAt: null
  };
  household = {
    id: "h1",
    createdAt: TEST_NOW,
    allowNewDeviceRequests: true,
    defaultMediaOrder: "captured-desc" as const,
    defaultSlideshowSeconds: 8,
    adminPassphraseHash: "argon2-test-hash",
    adminPassphraseVersion: 2
  };
  device = {
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
  };

  async findAdminSessionsByTokenHash(hash: string) {
    this.readCount += 1;
    return hash === this.adminSession.tokenHash ? [structuredClone(this.adminSession)] : [];
  }

  async findDeviceSessionsByTokenHash(hash: string) {
    this.readCount += 1;
    return hash === this.deviceSession.tokenHash
      ? Array.from({ length: this.deviceMatches }, (_, index) => ({
          ...structuredClone(this.deviceSession),
          id: `device-session-${index + 1}`
        }))
      : [];
  }

  async readHousehold(id: string) {
    this.readCount += 1;
    return id === this.household.id ? structuredClone(this.household) : null;
  }

  async readDevice(id: string) {
    this.readCount += 1;
    return id === this.device.id ? structuredClone(this.device) : null;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordingFirestore() {
  const operations: unknown[][] = [];
  const client = {
    collection(name: string) {
      let field = "";
      let value: unknown;
      let limit = 0;
      const query = {
        where(nextField: string, _operator: "==", nextValue: unknown) {
          field = nextField;
          value = nextValue;
          return query;
        },
        limit(nextLimit: number) {
          limit = nextLimit;
          return query;
        },
        async get() {
          operations.push(["query", name, field, value, limit]);
          return { docs: [] };
        },
        doc(id: string) {
          return {
            async get() {
              operations.push(["read", name, id]);
              return { id, exists: false, data: () => undefined };
            }
          };
        }
      };
      return query;
    }
  };
  return { client, operations };
}
