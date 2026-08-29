import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createInstallationRepository,
  createInstallationService,
  createSqliteControlPlaneStore,
  initializeInstallation,
  openLocalDatabase,
  verifyPassphrase,
} from "@cloudframe/server";
import { TEST_NOW, testAeadKeyring } from "./helpers/control-plane";

const directories: string[] = [];
const PASSPHRASE_PEPPER = "passphrase-pepper-that-is-long-enough";
const VALID_PASSPHRASE = "correct horse battery staple";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function harness() {
  const dataDir = await mkdtemp(join(tmpdir(), "cloudframe-install-service-"));
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
    setupCodePepper: "setup-pepper-that-is-long-enough",
  });
  const initialized = await initializeInstallation(
    repository,
    () => TEST_NOW,
    (size) => Buffer.alloc(size, 2),
  );
  const service = createInstallationService({
    repository,
    passphrasePepper: PASSPHRASE_PEPPER,
    now: () => TEST_NOW,
  });
  return { local, controlStore, initialized, service };
}

describe("installation service", () => {
  it("reports status and atomically claims one fresh installation", async () => {
    const { local, controlStore, initialized, service } = await harness();
    try {
      await expect(service.status()).resolves.toEqual({ state: "unconfigured" });
      await expect(service.claim({
        setupCode: initialized.setupCode!,
        passphrase: "short",
      })).rejects.toMatchObject({ code: "INVALID_PASSPHRASE" });
      await expect(service.claim({
        setupCode: "wrong-code",
        passphrase: VALID_PASSPHRASE,
      })).rejects.toMatchObject({ code: "SETUP_CODE_INVALID" });

      await expect(service.claim({
        setupCode: initialized.setupCode!,
        passphrase: VALID_PASSPHRASE,
      })).resolves.toEqual({ configured: true });
      await expect(service.status()).resolves.toEqual({ state: "configured" });
      await expect(service.claim({
        setupCode: initialized.setupCode!,
        passphrase: VALID_PASSPHRASE,
      })).rejects.toMatchObject({ code: "INSTALLATION_ALREADY_CONFIGURED" });

      const { document } = await controlStore.load();
      expect(document).toMatchObject({
        schemaVersion: 2,
        householdId: initialized.householdId,
        revision: 1,
        updatedAt: TEST_NOW.toISOString(),
        household: {
          adminPassphraseVersion: 1,
          allowNewDeviceRequests: true,
          defaultMediaOrder: "captured-desc",
          defaultSlideshowSeconds: 8,
        },
        devices: {},
        pendingDeviceRequests: {},
        sources: {},
        roots: {},
      });
      await expect(verifyPassphrase(
        document.household.adminPassphraseHash,
        VALID_PASSPHRASE,
        PASSPHRASE_PEPPER,
      )).resolves.toBe(true);
      expect(document.household.adminPassphraseHash).not.toContain(VALID_PASSPHRASE);
    } finally {
      local.close();
    }
  });

  it.each([
    "",
    "a".repeat(15),
    "a".repeat(1025),
  ])("rejects passphrase length before changing installation state", async (passphrase) => {
    const { local, initialized, service } = await harness();
    try {
      await expect(service.claim({
        setupCode: initialized.setupCode!,
        passphrase,
      })).rejects.toMatchObject({ code: "INVALID_PASSPHRASE" });
      await expect(service.status()).resolves.toEqual({ state: "unconfigured" });
    } finally {
      local.close();
    }
  });
});
