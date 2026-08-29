import { hkdfSync, randomBytes } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { VersionedAeadKeyring } from "../crypto/aead";
import type { ProviderTokenKeyring } from "../crypto/provider-tokens";

const VERSION = "local_v1";
const MASTER_KEY_BYTES = 32;
const HKDF_SALT = Buffer.from("cloudframe/self-hosted/v1", "utf8");

export interface LocalKeyMaterial {
  controlPlane: VersionedAeadKeyring;
  providerTokens: ProviderTokenKeyring;
  sessions: VersionedAeadKeyring;
  browseHandles: VersionedAeadKeyring;
  browseIdSecret: string;
  rootIdSecret: string;
  csrfSecret: string;
  rateLimitSecret: string;
  passphrasePepper: string;
  setupCodePepper: string;
}

export async function loadOrCreateMasterKey(dataDir: string): Promise<Buffer> {
  const secretsDirectory = join(dataDir, "secrets");
  const keyPath = join(secretsDirectory, "master.key");
  await mkdir(secretsDirectory, { recursive: true, mode: 0o700 });

  let created = false;
  try {
    const handle = await open(keyPath, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(randomBytes(MASTER_KEY_BYTES));
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isAlreadyExists(error)) {
      if (created) await unlink(keyPath).catch(() => undefined);
      throw error;
    }
  }

  const key = await readFile(keyPath);
  if (key.length !== MASTER_KEY_BYTES) {
    throw new Error("MASTER_KEY_INVALID");
  }
  return key;
}

export function deriveLocalKeyMaterial(masterKey: Uint8Array): LocalKeyMaterial {
  if (masterKey.byteLength !== MASTER_KEY_BYTES) {
    throw new Error("MASTER_KEY_INVALID");
  }

  return {
    controlPlane: keyring(masterKey, "control-plane"),
    providerTokens: keyring(masterKey, "provider-tokens"),
    sessions: keyring(masterKey, "sessions"),
    browseHandles: keyring(masterKey, "browse-handles"),
    browseIdSecret: secret(masterKey, "browse-id-secret"),
    rootIdSecret: secret(masterKey, "root-id-secret"),
    csrfSecret: secret(masterKey, "csrf-secret"),
    rateLimitSecret: secret(masterKey, "rate-limit-secret"),
    passphrasePepper: secret(masterKey, "passphrase-pepper"),
    setupCodePepper: secret(masterKey, "setup-code-pepper"),
  };
}

function keyring(masterKey: Uint8Array, label: string): VersionedAeadKeyring {
  return {
    currentVersion: VERSION,
    keys: { [VERSION]: derive(masterKey, label) },
  };
}

function secret(masterKey: Uint8Array, label: string): string {
  return derive(masterKey, label).toString("base64url");
}

function derive(masterKey: Uint8Array, label: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(masterKey),
    HKDF_SALT,
    Buffer.from(label, "utf8"),
    MASTER_KEY_BYTES,
  ));
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
