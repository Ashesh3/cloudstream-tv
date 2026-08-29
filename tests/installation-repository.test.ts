import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInstallationRepository,
  createSqliteControlPlaneStore,
  initializeInstallation,
  openLocalDatabase,
} from "@cloudframe/server";
import { TEST_NOW, testAeadKeyring } from "./helpers/control-plane";

const directories: string[] = [];
const SETUP_PEPPER = "setup-pepper-that-is-long-enough";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-installation-"));
  directories.push(dataDir);
  const local = await openLocalDatabase({ dataDir, now: () => TEST_NOW });
  const controlStore = createSqliteControlPlaneStore({
    connection: local.connection,
    keyring: testAeadKeyring(),
    now: () => TEST_NOW,
  });
  const repository = createInstallationRepository({
    connection: local.connection,
    controlStore,
    setupCodePepper: SETUP_PEPPER,
  });
  return { local, controlStore, repository };
}

describe("installation repository", () => {
  it("initializes once and returns the plaintext setup code only to the insert winner", async () => {
    const { local, repository } = await harness();
    try {
      const bytes = (size: number) => Buffer.alloc(size, 1);
      const initialized = await initializeInstallation(
        repository,
        () => TEST_NOW,
        bytes,
      );
      const repeated = await initializeInstallation(
        repository,
        () => new Date(TEST_NOW.getTime() + 1_000),
        bytes,
      );

      expect(initialized.householdId).toMatch(/^household-[0-9a-f-]{36}$/);
      expect(initialized.setupCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(repeated).toEqual({ householdId: initialized.householdId });

      const row = local.connection.prepare(
        "SELECT household_id, setup_code_hash, configured, created_at FROM installation WHERE singleton = 1",
      ).get() as Record<string, unknown>;
      expect(row).toMatchObject({
        household_id: initialized.householdId,
        configured: 0,
        created_at: TEST_NOW.toISOString(),
      });
      expect(row.setup_code_hash).toBe(
        createHmac("sha256", SETUP_PEPPER)
          .update(initialized.setupCode!, "utf8")
          .digest("base64url"),
      );
      expect(JSON.stringify(row)).not.toContain(initialized.setupCode!);
    } finally {
      local.close();
    }
  });
});
