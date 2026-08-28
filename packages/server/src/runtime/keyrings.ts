import type { VersionedAeadKeyring } from "../crypto/aead";
import type { ProviderTokenKeyring } from "../crypto/provider-tokens";

const KEY_VERSION = /^[A-Za-z0-9_-]{1,64}$/;

export function versionedAeadKeyringFromEnv(
  environment: NodeJS.ProcessEnv,
  prefix: "CONTROL_PLANE_KEY" | "SESSION_KEY" | "BROWSE_HANDLE_KEY"
): VersionedAeadKeyring {
  return keyring(environment, prefix);
}

export function providerTokenKeyringFromEnv(
  environment: NodeJS.ProcessEnv
): ProviderTokenKeyring {
  return keyring(environment, "PROVIDER_TOKEN_KEY");
}

function keyring(
  environment: NodeJS.ProcessEnv,
  prefix: string
): VersionedAeadKeyring {
  const currentVersion = required(environment, `${prefix}_VERSION`);
  if (!KEY_VERSION.test(currentVersion)) throw new Error(`${prefix}_INVALID`);
  const keys: Record<string, Uint8Array> = {};
  const canonicalVersions = new Set<string>();
  const stem = `${prefix}_`;
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith(stem) || name === `${prefix}_VERSION` || value === undefined) continue;
    const version = name.slice(stem.length);
    const canonical = version.toLocaleLowerCase("en");
    if (
      !KEY_VERSION.test(version) ||
      Object.hasOwn(keys, version) ||
      canonicalVersions.has(canonical)
    ) {
      throw new Error(`${prefix}_INVALID`);
    }
    canonicalVersions.add(canonical);
    keys[version] = decodeKey(value, prefix);
  }
  if (!keys[currentVersion]) throw new Error(`${prefix}_INVALID`);
  return { currentVersion, keys };
}

function decodeKey(value: string, name: string): Buffer {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new Error(`${name}_INVALID`);
  }
  return key;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value !== value.trim()) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
