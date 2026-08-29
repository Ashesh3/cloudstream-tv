import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteControlPlaneStore,
  openLocalDatabase,
} from "@cloudframe/server";
import {
  TEST_NOW,
  testAeadKeyring,
  testControlDocument,
} from "./helpers/control-plane";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-control-sqlite-"));
  directories.push(dataDir);
  const local = await openLocalDatabase({ dataDir, now: () => TEST_NOW });
  const store = createSqliteControlPlaneStore({
    connection: local.connection,
    keyring: testAeadKeyring(),
    now: () => TEST_NOW,
  });
  return { local, store };
}

describe("SQLite control-plane store", () => {
  it("reports an unconfigured installation and initializes revision one once", async () => {
    const { local, store } = await createHarness();
    try {
      expect(await store.isConfigured()).toBe(false);
      await expect(store.load()).rejects.toThrow("CONTROL_PLANE_UNAVAILABLE");

      const document = testControlDocument();
      await store.initialize(document);

      expect(await store.isConfigured()).toBe(true);
      expect((await store.load()).document).toEqual(document);
      await expect(store.initialize(document)).rejects.toThrow("CONTROL_PLANE_CONFLICT");
    } finally {
      local.close();
    }
  });

  it("mutates one revision transactionally and returns the reducer result", async () => {
    const { local, store } = await createHarness();
    try {
      await store.initialize(testControlDocument());

      const result = await store.mutate("settings", (current) => ({
        changed: true,
        next: {
          ...current,
          revision: current.revision + 1,
          household: {
            ...current.household,
            defaultSlideshowSeconds: 12,
          },
        },
        result: "updated",
      }));

      expect(result).toBe("updated");
      expect((await store.load()).document).toMatchObject({
        revision: 2,
        household: { defaultSlideshowSeconds: 12 },
      });
    } finally {
      local.close();
    }
  });

  it("stores only an encrypted envelope", async () => {
    const { local, store } = await createHarness();
    try {
      const document = testControlDocument();
      await store.initialize(document);
      const row = local.connection.prepare(
        "SELECT envelope_json FROM control_state WHERE singleton = 1",
      ).get() as { envelope_json: string };

      expect(row.envelope_json).not.toContain(document.household.adminPassphraseHash);
      expect(row.envelope_json).not.toContain(document.sources["source-1"]!.encryptedRefreshToken.ciphertext);
      expect(JSON.parse(row.envelope_json)).toMatchObject({
        envelopeVersion: 1,
        revision: 1,
      });
    } finally {
      local.close();
    }
  });

  it("rolls back invalid revision increments without altering the stored document", async () => {
    const { local, store } = await createHarness();
    try {
      await store.initialize(testControlDocument());

      await expect(store.mutate("settings", (current) => ({
        changed: true,
        next: { ...current, revision: current.revision + 2 },
        result: undefined,
      }))).rejects.toMatchObject({ code: "CONTROL_PLANE_INVALID" });

      expect((await store.load()).document).toEqual(testControlDocument());
    } finally {
      local.close();
    }
  });

  it("rolls back invalid documents and leaves the transaction usable", async () => {
    const { local, store } = await createHarness();
    try {
      await store.initialize(testControlDocument());

      await expect(store.mutate("settings", (current) => ({
        changed: true,
        next: {
          ...current,
          revision: current.revision + 1,
          household: { ...current.household, defaultSlideshowSeconds: -1 },
        },
        result: undefined,
      }))).rejects.toMatchObject({ code: "CONTROL_PLANE_INVALID" });

      await expect(store.mutate("noop", (current) => ({
        changed: false,
        next: current,
        result: "still-open",
      }))).resolves.toBe("still-open");
      expect((await store.load()).document.revision).toBe(1);
    } finally {
      local.close();
    }
  });

  it("initializes inside an installation-owned transaction without committing it", async () => {
    const { local, store } = await createHarness();
    try {
      local.connection.exec("BEGIN IMMEDIATE");
      store.initializeWithinTransaction(testControlDocument());
      expect(local.connection.prepare("SELECT COUNT(*) AS count FROM control_state").get())
        .toEqual({ count: 1 });
      local.connection.exec("ROLLBACK");

      expect(await store.isConfigured()).toBe(false);
    } finally {
      local.close();
    }
  });

  it("emits request-scoped, secret-free local read and write telemetry", async () => {
    const { local, store } = await createHarness();
    const events: unknown[] = [];
    try {
      await store.initialize(testControlDocument());
      await store.withTelemetry!(
        { emit: (event) => events.push(event) },
        "request-1",
        async () => {
          await store.load();
          await store.mutate("settings", (current) => ({
            changed: true,
            next: { ...current, revision: current.revision + 1 },
            result: undefined,
          }));
        },
      );

      expect(events).toEqual([
        {
          level: "info",
          event: "control_plane_sqlite_read",
          requestId: "request-1",
          householdId: "h1",
          count: 1,
        },
        {
          level: "info",
          event: "control_plane_sqlite_write",
          requestId: "request-1",
          householdId: "h1",
          revision: 2,
          count: 1,
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/argon2-test-hash|cipher-/);
    } finally {
      local.close();
    }
  });
});
