import { createHmac } from "node:crypto";

import {
  SealedValueError,
  openJson,
  sealJson,
  type VersionedAeadKeyring
} from "../crypto/aead";

const ITEM_PURPOSE = "cloudframe/browse-item/v2";
const CURSOR_PURPOSE = "cloudframe/browse-cursor/v2";

export interface BrowseItemClaims {
  version: 2;
  householdId: string;
  deviceId: string;
  sourceId: string;
  rootId: string;
  providerNodeId: string;
  parentProviderNodeId: string | null;
  kind: "folder" | "image" | "video";
  name: string;
  mimeType: string | null;
  credentialVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface BrowseCursorClaims {
  version: 2;
  householdId: string;
  deviceId: string;
  sourceId: string;
  rootId: string;
  folderProviderNodeId: string;
  providerCursor: string;
  credentialVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface BrowseHandleCodec {
  sealItem(claims: BrowseItemClaims): string;
  openItem(handle: string): BrowseItemClaims;
  sealCursor(claims: BrowseCursorClaims): string;
  openCursor(cursor: string): BrowseCursorClaims;
  stableItemId(householdId: string, sourceId: string, providerNodeId: string): string;
}

type UnknownRecord = Record<string, unknown>;

function fail(): never {
  throw new SealedValueError("SEALED_VALUE_INVALID");
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail();
  }
  return value as UnknownRecord;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    fail();
  }
  return value as number;
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 1) {
    fail();
  }
  return parsed;
}

function common(value: UnknownRecord, now: Date) {
  if (value.version !== 2) {
    fail();
  }
  const issuedAt = integer(value.issuedAt);
  const expiresAt = integer(value.expiresAt);
  if (expiresAt <= now.getTime()) {
    fail();
  }
  return {
    version: 2 as const,
    householdId: string(value.householdId),
    deviceId: string(value.deviceId),
    sourceId: string(value.sourceId),
    rootId: string(value.rootId),
    credentialVersion: positiveInteger(value.credentialVersion),
    issuedAt,
    expiresAt
  };
}

function parseItem(value: unknown, now: Date): BrowseItemClaims {
  const input = record(value);
  const kind = input.kind;
  if (kind !== "folder" && kind !== "image" && kind !== "video") {
    fail();
  }
  return {
    ...common(input, now),
    providerNodeId: string(input.providerNodeId),
    parentProviderNodeId: nullableString(input.parentProviderNodeId),
    kind,
    name: string(input.name),
    mimeType: nullableString(input.mimeType)
  };
}

function parseCursor(value: unknown, now: Date): BrowseCursorClaims {
  const input = record(value);
  return {
    ...common(input, now),
    folderProviderNodeId: string(input.folderProviderNodeId),
    providerCursor: string(input.providerCursor)
  };
}

export function createBrowseHandleCodec(
  keyring: VersionedAeadKeyring,
  browseIdSecret: string,
  now: () => Date = () => new Date()
): BrowseHandleCodec {
  return {
    sealItem(claims) {
      return sealJson(ITEM_PURPOSE, parseItem(claims, now()), keyring);
    },
    openItem(handle) {
      return openJson(ITEM_PURPOSE, handle, keyring.keys, (value) => parseItem(value, now()));
    },
    sealCursor(claims) {
      return sealJson(CURSOR_PURPOSE, parseCursor(claims, now()), keyring);
    },
    openCursor(cursor) {
      return openJson(CURSOR_PURPOSE, cursor, keyring.keys, (value) => parseCursor(value, now()));
    },
    stableItemId(householdId, sourceId, providerNodeId) {
      return `item_${createHmac("sha256", browseIdSecret)
        .update(`${householdId.length}:${householdId}${sourceId.length}:${sourceId}${providerNodeId.length}:${providerNodeId}`)
        .digest("base64url")}`;
    }
  };
}
