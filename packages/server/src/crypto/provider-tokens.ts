import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes
} from "node:crypto";

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";

export interface EncryptedProviderToken {
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface ProviderTokenKeyring {
  currentVersion: string;
  keys: Record<string, Uint8Array>;
}

function requireKey(key: Uint8Array | undefined, version: string): Buffer {
  if (!key) {
    throw new Error(`Provider token key version is unavailable: ${version}`);
  }

  const material = Buffer.from(key);
  if (material.length !== 32) {
    throw new Error(`Provider token key ${version} must be 32 bytes`);
  }

  return material;
}

export function encryptProviderToken(
  token: string,
  keyring: ProviderTokenKeyring
): EncryptedProviderToken {
  const keyVersion = keyring.currentVersion;
  const key = requireKey(keyring.keys[keyVersion], keyVersion);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final()
  ]);

  return {
    keyVersion,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
}

export function decryptProviderToken(
  encrypted: EncryptedProviderToken,
  keys: Record<string, Uint8Array>
): string {
  const key = requireKey(keys[encrypted.keyVersion], encrypted.keyVersion);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(encrypted.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64url")),
    decipher.final()
  ]).toString("utf8");
}
