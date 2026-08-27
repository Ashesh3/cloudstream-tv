import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes
} from "node:crypto";

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const TOKEN_PREFIX = "a1";
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KEY_VERSION = /^[A-Za-z0-9_-]+$/;

export interface VersionedAeadKeyring {
  currentVersion: string;
  keys: Record<string, Uint8Array>;
}

export class SealedValueError extends Error {
  readonly code = "SEALED_VALUE_INVALID";

  constructor(code: "SEALED_VALUE_INVALID") {
    super(code);
    this.name = "SealedValueError";
  }
}

function invalid(): SealedValueError {
  return new SealedValueError("SEALED_VALUE_INVALID");
}

function requireKey(key: Uint8Array | undefined): Buffer {
  if (!key) {
    throw invalid();
  }

  const material = Buffer.from(key);
  if (material.length !== 32) {
    throw invalid();
  }

  return material;
}

function decodeSegment(segment: string): Buffer {
  if (!BASE64URL.test(segment)) {
    throw invalid();
  }

  const decoded = Buffer.from(segment, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== segment) {
    throw invalid();
  }

  return decoded;
}

export function sealJson(
  purpose: string,
  value: unknown,
  keyring: VersionedAeadKeyring
): string {
  try {
    if (typeof purpose !== "string" || purpose.length === 0) {
      throw invalid();
    }

    const keyVersion = keyring.currentVersion;
    if (!KEY_VERSION.test(keyVersion)) {
      throw invalid();
    }

    const key = requireKey(keyring.keys[keyVersion]);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw invalid();
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(encoded, "utf8"),
      cipher.final()
    ]);

    return [
      TOKEN_PREFIX,
      keyVersion,
      iv.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url")
    ].join(".");
  } catch {
    throw invalid();
  }
}

export function openJson<T>(
  purpose: string,
  token: string,
  keys: Record<string, Uint8Array>,
  parse: (value: unknown) => T
): T {
  try {
    if (typeof purpose !== "string" || purpose.length === 0 || typeof token !== "string") {
      throw invalid();
    }

    const segments = token.split(".");
    if (segments.length !== 5 || segments[0] !== TOKEN_PREFIX) {
      throw invalid();
    }

    const [, keyVersion, ivSegment, ciphertextSegment, authTagSegment] = segments;
    if (!KEY_VERSION.test(keyVersion)) {
      throw invalid();
    }

    const key = requireKey(keys[keyVersion]);
    const iv = decodeSegment(ivSegment);
    const ciphertext = decodeSegment(ciphertextSegment);
    const authTag = decodeSegment(authTagSegment);
    if (iv.length !== 12 || authTag.length !== 16) {
      throw invalid();
    }

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(purpose, "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]).toString("utf8");

    return parse(JSON.parse(plaintext) as unknown);
  } catch {
    throw invalid();
  }
}
