import {
  SealedValueError,
  openJson,
  sealJson,
  type VersionedAeadKeyring,
} from "../crypto/aead";

const MEDIA_PURPOSE = "cloudframe/media-item/v1";
export const MEDIA_HANDLE_LIFETIME_MS = 12 * 60 * 60_000;

export interface MediaHandleClaims {
  version: 1;
  householdId: string;
  deviceId: string;
  sourceId: string;
  rootId: string;
  rootProviderNodeId: string;
  providerNodeId: string;
  parentProviderNodeId: string | null;
  kind: "image" | "video";
  name: string;
  mimeType: string;
  credentialVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface MediaHandleCodec {
  seal(claims: MediaHandleClaims): string;
  open(handle: string): MediaHandleClaims;
}

type UnknownRecord = Record<string, unknown>;

function invalid(): never {
  throw new SealedValueError("SEALED_VALUE_INVALID");
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as UnknownRecord;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) invalid();
  return value as number;
}

function parseMedia(value: unknown, now: Date): MediaHandleClaims {
  const input = record(value);
  const issuedAt = integer(input.issuedAt);
  const expiresAt = integer(input.expiresAt);
  const kind = input.kind;
  if (
    input.version !== 1 ||
    (kind !== "image" && kind !== "video") ||
    expiresAt <= now.getTime() ||
    expiresAt - issuedAt <= 0 ||
    expiresAt - issuedAt > MEDIA_HANDLE_LIFETIME_MS
  ) {
    invalid();
  }
  const mimeType = string(input.mimeType);
  if (!mimeType.startsWith(`${kind}/`)) invalid();
  const credentialVersion = integer(input.credentialVersion);
  if (credentialVersion < 1) invalid();
  return {
    version: 1,
    householdId: string(input.householdId),
    deviceId: string(input.deviceId),
    sourceId: string(input.sourceId),
    rootId: string(input.rootId),
    rootProviderNodeId: string(input.rootProviderNodeId),
    providerNodeId: string(input.providerNodeId),
    parentProviderNodeId: nullableString(input.parentProviderNodeId),
    kind,
    name: string(input.name),
    mimeType,
    credentialVersion,
    issuedAt,
    expiresAt,
  };
}

export function createMediaHandleCodec(
  keyring: VersionedAeadKeyring,
  now: () => Date = () => new Date(),
): MediaHandleCodec {
  return {
    seal(claims) {
      return sealJson(MEDIA_PURPOSE, parseMedia(claims, now()), keyring);
    },
    open(handle) {
      return openJson(MEDIA_PURPOSE, handle, keyring.keys, (value) =>
        parseMedia(value, now()),
      );
    },
  };
}
