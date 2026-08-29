import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveLocalKeyMaterial,
  loadOrCreateMasterKey,
} from "../packages/server/src/runtime/local-keys";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cloudframe-keys-"));
  directories.push(directory);
  return directory;
}

describe("local self-hosted keys", () => {
  it("creates one persistent 32-byte master key with private permissions", async () => {
    const directory = await temporaryDataDirectory();

    const first = await loadOrCreateMasterKey(directory);
    const second = await loadOrCreateMasterKey(directory);

    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    if (process.platform !== "win32") {
      expect((await stat(join(directory, "secrets", "master.key"))).mode & 0o777)
        .toBe(0o600);
    }
  });

  it("converges concurrent first-run callers on the same key", async () => {
    const directory = await temporaryDataDirectory();

    const keys = await Promise.all(Array.from(
      { length: 4 },
      () => loadOrCreateMasterKey(directory),
    ));

    expect(keys.every((key) => key.equals(keys[0]!))).toBe(true);
  });

  it("derives domain-separated keyrings and application secrets", async () => {
    const directory = await temporaryDataDirectory();
    const masterKey = await loadOrCreateMasterKey(directory);

    const keys = deriveLocalKeyMaterial(masterKey);
    const encryptedKeyHex = [
      keys.controlPlane,
      keys.providerTokens,
      keys.sessions,
      keys.browseHandles,
    ].map((keyring) => Buffer.from(keyring.keys.local_v1!).toString("hex"));
    const stringSecrets = [
      keys.browseIdSecret,
      keys.rootIdSecret,
      keys.csrfSecret,
      keys.rateLimitSecret,
      keys.passphrasePepper,
      keys.setupCodePepper,
    ];

    expect(new Set(encryptedKeyHex).size).toBe(4);
    expect(Buffer.from(keys.controlPlane.keys.local_v1!)).not.toEqual(masterKey);
    expect(new Set(stringSecrets).size).toBe(stringSecrets.length);
    for (const secret of stringSecrets) {
      expect(Buffer.byteLength(secret, "utf8")).toBeGreaterThanOrEqual(32);
    }
  });

  it("rejects an existing master key with the wrong length", async () => {
    const directory = await temporaryDataDirectory();
    await mkdir(join(directory, "secrets"), { recursive: true });
    await writeFile(join(directory, "secrets", "master.key"), Buffer.alloc(31));

    await expect(loadOrCreateMasterKey(directory)).rejects.toThrow("MASTER_KEY_INVALID");
  });
});
