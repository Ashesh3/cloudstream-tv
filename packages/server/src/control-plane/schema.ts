import { z } from "zod";

import {
  CONTROL_PLANE_LIMITS,
  type ControlPlaneDocumentV2
} from "@cloudframe/shared";

export type ControlPlaneDocumentErrorCode =
  | "CONTROL_PLANE_INVALID"
  | "CONTROL_PLANE_LIMIT_EXCEEDED";

export class ControlPlaneDocumentError extends Error {
  constructor(readonly code: ControlPlaneDocumentErrorCode) {
    super(code);
    this.name = "ControlPlaneDocumentError";
  }
}

const positiveVersion = z.number().int().safe().positive();
const nonEmpty = z.string().min(1);
const visibleName = z
  .string()
  .min(1)
  .max(CONTROL_PLANE_LIMITS.visibleNameLength)
  .refine((value) => value === value.trim());
const timestamp = z.iso.datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const mediaOrder = z.enum(["captured-desc", "captured-asc", "name-asc"]);
const encryptedSecret = z
  .object({
    keyVersion: nonEmpty,
    iv: nonEmpty,
    ciphertext: nonEmpty,
    authTag: nonEmpty
  })
  .strict();

const device = z
  .object({
    id: nonEmpty,
    name: visibleName,
    enabled: z.boolean(),
    assignedRootIds: z.array(nonEmpty),
    mediaOrder: mediaOrder.nullable(),
    slideshowSeconds: z.number().finite().positive().nullable(),
    sessionVersion: positiveVersion,
    createdAt: timestamp,
    approvedAt: timestamp,
    revokedAt: nullableTimestamp
  })
  .strict();

const pendingRequest = z
  .object({
    id: nonEmpty,
    requestedName: visibleName,
    requestSecretHash: nonEmpty,
    status: z.enum(["pending", "approved", "denied", "expired"]),
    createdAt: timestamp,
    expiresAt: timestamp,
    resolvedAt: nullableTimestamp,
    approvedDeviceId: nonEmpty.nullable()
  })
  .strict();

const source = z
  .object({
    id: nonEmpty,
    provider: z.enum(["google", "onedrive"]),
    providerAccountId: nonEmpty,
    providerRootId: nonEmpty,
    accountLabel: visibleName,
    encryptedRefreshToken: encryptedSecret,
    encryptedBootstrapAccessToken: encryptedSecret.nullable(),
    bootstrapAccessTokenExpiresAt: nullableTimestamp,
    credentialVersion: positiveVersion,
    status: z.enum(["healthy", "reauth-required", "disabled"]),
    createdAt: timestamp
  })
  .strict();

const root = z
  .object({
    id: nonEmpty,
    sourceId: nonEmpty,
    providerNodeId: nonEmpty,
    displayName: visibleName,
    ancestryProviderIds: z.array(nonEmpty).max(CONTROL_PLANE_LIMITS.ancestryEntries),
    enabled: z.boolean(),
    createdAt: timestamp
  })
  .strict();

const documentSchema = z
  .object({
    schemaVersion: z.literal(2),
    householdId: nonEmpty,
    revision: positiveVersion,
    updatedAt: timestamp,
    household: z
      .object({
        adminPassphraseHash: nonEmpty,
        adminPassphraseVersion: positiveVersion,
        allowNewDeviceRequests: z.boolean(),
        defaultMediaOrder: mediaOrder,
        defaultSlideshowSeconds: z.number().finite().positive()
      })
      .strict(),
    devices: z.record(z.string(), device),
    pendingDeviceRequests: z.record(z.string(), pendingRequest),
    sources: z.record(z.string(), source),
    roots: z.record(z.string(), root)
  })
  .strict();

function recordSize(value: unknown): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  return Object.keys(value).length;
}

function limitExceeded(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    recordSize(candidate.devices) > CONTROL_PLANE_LIMITS.devices ||
    recordSize(candidate.pendingDeviceRequests) > CONTROL_PLANE_LIMITS.pendingRequests ||
    recordSize(candidate.sources) > CONTROL_PLANE_LIMITS.sources ||
    recordSize(candidate.roots) > CONTROL_PLANE_LIMITS.roots
  ) {
    return true;
  }

  const visibleNames = [
    ...recordValues(candidate.devices, "name"),
    ...recordValues(candidate.pendingDeviceRequests, "requestedName"),
    ...recordValues(candidate.sources, "accountLabel"),
    ...recordValues(candidate.roots, "displayName")
  ];
  if (
    visibleNames.some(
      (name) =>
        typeof name === "string" &&
        name.length > CONTROL_PLANE_LIMITS.visibleNameLength
    )
  ) {
    return true;
  }

  if (typeof candidate.roots !== "object" || candidate.roots === null) {
    return false;
  }

  let ancestryEntries = 0;
  for (const entry of Object.values(candidate.roots)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const ancestry = (entry as Record<string, unknown>).ancestryProviderIds;
    if (Array.isArray(ancestry)) {
      ancestryEntries += ancestry.length;
    }
  }
  return ancestryEntries > CONTROL_PLANE_LIMITS.ancestryEntries;
}

function recordValues(record: unknown, property: string): unknown[] {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return [];
  }
  return Object.values(record).map((entry) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)[property]
      : undefined
  );
}

function assertRecordIds(
  records: Record<string, { id: string }>
): void {
  for (const [key, value] of Object.entries(records)) {
    if (key !== value.id) {
      throw new ControlPlaneDocumentError("CONTROL_PLANE_INVALID");
    }
  }
}

function assertCrossRecordInvariants(document: ControlPlaneDocumentV2): void {
  assertRecordIds(document.devices);
  assertRecordIds(document.pendingDeviceRequests);
  assertRecordIds(document.sources);
  assertRecordIds(document.roots);

  for (const deviceValue of Object.values(document.devices)) {
    for (const rootId of deviceValue.assignedRootIds) {
      const assignedRoot = document.roots[rootId];
      if (!assignedRoot || !assignedRoot.enabled) {
        throw new ControlPlaneDocumentError("CONTROL_PLANE_INVALID");
      }
    }
  }

  for (const rootValue of Object.values(document.roots)) {
    if (!document.sources[rootValue.sourceId]) {
      throw new ControlPlaneDocumentError("CONTROL_PLANE_INVALID");
    }
    if (new Set(rootValue.ancestryProviderIds).size !== rootValue.ancestryProviderIds.length) {
      throw new ControlPlaneDocumentError("CONTROL_PLANE_INVALID");
    }
  }
}

export function parseControlPlaneDocument(value: unknown): ControlPlaneDocumentV2 {
  if (limitExceeded(value)) {
    throw new ControlPlaneDocumentError("CONTROL_PLANE_LIMIT_EXCEEDED");
  }

  const result = documentSchema.safeParse(value);
  if (!result.success) {
    throw new ControlPlaneDocumentError("CONTROL_PLANE_INVALID");
  }

  const document = result.data as ControlPlaneDocumentV2;
  assertCrossRecordInvariants(document);
  return document;
}

export function cloneControlPlaneDocument(
  document: ControlPlaneDocumentV2
): ControlPlaneDocumentV2 {
  return parseControlPlaneDocument(document);
}

export function pruneExpiredRequests(
  document: ControlPlaneDocumentV2,
  now: Date
): ControlPlaneDocumentV2 {
  const cloned = cloneControlPlaneDocument(document);
  const resolvedAt = now.toISOString();

  for (const request of Object.values(cloned.pendingDeviceRequests)) {
    if (request.status === "pending" && Date.parse(request.expiresAt) <= now.getTime()) {
      request.status = "expired";
      request.resolvedAt = resolvedAt;
    }
  }

  return cloned;
}
