import { createHash } from "node:crypto";

import type {
  ControlPlaneDevice,
  ControlPlaneDocumentV2,
  ControlPlaneRequest,
  ControlPlaneRoot,
  ControlPlaneSource
} from "../../packages/shared/src/control-plane.ts";
import type {
  EncryptedSecret,
  MediaOrder,
  ProviderKind
} from "../../packages/shared/src/contracts.ts";
import type { VersionedAeadKeyring } from "../../packages/server/src/crypto/aead.ts";
import {
  decryptControlPlaneEnvelope,
  encryptControlPlaneDocument
} from "../../packages/server/src/control-plane/envelope.ts";
import { parseControlPlaneDocument } from "../../packages/server/src/control-plane/schema.ts";
import type {
  ControlDurableStore,
  ControlHotCache,
  StoredControlEnvelope
} from "../../packages/server/src/control-plane/store.ts";

export type ControlPlaneEnvironment = "production" | "preview";
export type LegacyMigrationCollection =
  | "households"
  | "deviceRequests"
  | "devices"
  | "sources"
  | "roots";

export interface LegacyControlPlaneReader {
  listCollection(name: LegacyMigrationCollection): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
  readRecovery(path: string): Promise<unknown | null>;
  writeRecovery(path: string, document: ControlPlaneDocumentV2): Promise<void>;
}

interface FirestoreDocumentLike {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface FirestoreCollectionLike {
  get(): Promise<{ docs: FirestoreDocumentLike[] }>;
  doc(id: string): {
    get(): Promise<FirestoreDocumentLike>;
    set(value: ControlPlaneDocumentV2): Promise<unknown>;
  };
}

export interface MigrationFirestore {
  collection(name: string): FirestoreCollectionLike;
}

export interface ControlPlaneMigrationPlan {
  document: ControlPlaneDocumentV2;
  checksum: string;
}

export interface ControlPlaneOpsResult {
  apply: boolean;
  householdId: string;
  revision: number;
  counts: {
    devices: number;
    pendingRequests: number;
    sources: number;
    roots: number;
  };
  checksum: string;
}

interface CommonOperationOptions {
  apply: boolean;
  environment: string;
  householdId: string;
  firestore: LegacyControlPlaneReader;
  durable: ControlDurableStore;
  cache: ControlHotCache;
  keyring: VersionedAeadKeyring;
}

export interface MigrationOptions extends CommonOperationOptions {
  now: Date;
}

export type RestoreOptions = CommonOperationOptions;

const COLLECTION_ORDER: readonly LegacyMigrationCollection[] = [
  "households",
  "deviceRequests",
  "devices",
  "sources",
  "roots"
];
const CACHE_TTL_SECONDS = 300;

export async function buildControlPlaneMigrationPlan(
  reader: Pick<LegacyControlPlaneReader, "listCollection">,
  householdId: string,
  now: Date
): Promise<ControlPlaneMigrationPlan> {
  requireIdentifier(householdId, "HOUSEHOLD_ID_INVALID");
  requireDate(now);
  const records = new Map<LegacyMigrationCollection, ReadonlyArray<Readonly<Record<string, unknown>>>>();
  for (const collection of COLLECTION_ORDER) {
    records.set(collection, await reader.listCollection(collection));
  }

  const household = uniqueHousehold(records.get("households")!, householdId);
  const sources = sourceRecords(records.get("sources")!, householdId);
  const roots = rootRecords(records.get("roots")!, householdId, sources);
  const retainedRootIds = new Set(
    Object.values(roots).filter((root) => root.enabled).map((root) => root.id)
  );
  const document = parseControlPlaneDocument({
    schemaVersion: 2,
    householdId,
    revision: 1,
    updatedAt: now.toISOString(),
    household: {
      adminPassphraseHash: requiredString(household.adminPassphraseHash),
      adminPassphraseVersion: positiveInteger(household.adminPassphraseVersion),
      allowNewDeviceRequests: requiredBoolean(household.allowNewDeviceRequests),
      defaultMediaOrder: requiredMediaOrder(household.defaultMediaOrder),
      defaultSlideshowSeconds: requiredPositiveNumber(household.defaultSlideshowSeconds)
    },
    devices: deviceRecords(records.get("devices")!, householdId, retainedRootIds),
    pendingDeviceRequests: requestRecords(records.get("deviceRequests")!, householdId, now),
    sources,
    roots
  });

  return { document, checksum: logicalChecksum(document) };
}

export async function runControlPlaneMigration(
  options: MigrationOptions
): Promise<ControlPlaneOpsResult> {
  requireEnvironment(options.environment);
  const plan = await buildControlPlaneMigrationPlan(
    options.firestore,
    options.householdId,
    options.now
  );
  if (options.apply) {
    const recoveryPath = recoveryDocumentPath(options.householdId);
    await options.firestore.writeRecovery(recoveryPath, plan.document);
    const recovery = await options.firestore.readRecovery(recoveryPath);
    verifyLogicalCopy(recovery, plan.document, plan.checksum);
    await writeActiveSnapshot(options, plan.document);
    await verifyActiveSnapshot(options, plan.document, plan.checksum);
  }
  return result(options.apply, plan.document, plan.checksum);
}

export async function restoreControlPlane(
  options: RestoreOptions
): Promise<ControlPlaneOpsResult> {
  requireEnvironment(options.environment);
  requireIdentifier(options.householdId, "HOUSEHOLD_ID_INVALID");
  const recovery = await options.firestore.readRecovery(
    recoveryDocumentPath(options.householdId)
  );
  const document = parseControlPlaneDocument(recovery);
  if (document.householdId !== options.householdId) {
    throw new Error("RECOVERY_HOUSEHOLD_MISMATCH");
  }
  const checksum = logicalChecksum(document);
  if (options.apply) {
    await writeActiveSnapshot(options, document);
    await verifyActiveSnapshot(options, document, checksum);
  }
  return result(options.apply, document, checksum);
}

export function logicalChecksum(document: ControlPlaneDocumentV2): string {
  const parsed = parseControlPlaneDocument(document);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(parsed)), "utf8")
    .digest("hex");
}

export function requireControlPlaneEnvironment(value: string): ControlPlaneEnvironment {
  return requireEnvironment(value);
}

export function createMigrationFirestoreReader(
  firestore: MigrationFirestore
): LegacyControlPlaneReader {
  return {
    async listCollection(name) {
      const snapshot = await firestore.collection(name).get();
      return snapshot.docs.map((document) => ({
        ...decodeFirestoreValue(document.data()) as Record<string, unknown>,
        id: document.id
      }));
    },
    async readRecovery(path) {
      const [collection, id] = splitRecoveryPath(path);
      const document = await firestore.collection(collection).doc(id).get();
      return document.exists ? decodeFirestoreValue(document.data()) : null;
    },
    async writeRecovery(path, document) {
      const [collection, id] = splitRecoveryPath(path);
      await firestore.collection(collection).doc(id).set(document);
    }
  };
}

function sourceRecords(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  householdId: string
): Record<string, ControlPlaneSource> {
  const sources: Record<string, ControlPlaneSource> = {};
  for (const value of sortedForHousehold(records, householdId)) {
    const id = requiredString(value.id);
    const providerAccountId = verifiedString(value.providerAccountId);
    const providerRootId = verifiedString(value.providerRootId);
    if (!providerAccountId || !providerRootId) continue;
    const status = value.status === "disabled"
      ? "disabled"
      : explicitlyNeedsReauthorization(value)
        ? "reauth-required"
        : "healthy";
    sources[id] = {
      id,
      provider: requiredProvider(value.provider),
      providerAccountId,
      providerRootId,
      accountLabel: requiredVisibleName(value.accountLabel),
      encryptedRefreshToken: requiredEncryptedSecret(value.encryptedRefreshToken),
      encryptedBootstrapAccessToken: value.encryptedAccessToken == null
        ? null
        : requiredEncryptedSecret(value.encryptedAccessToken),
      bootstrapAccessTokenExpiresAt: optionalIso(value.accessTokenExpiresAt),
      credentialVersion: 1,
      status,
      createdAt: requiredIso(value.createdAt)
    };
  }
  return sources;
}

function rootRecords(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  householdId: string,
  sources: Record<string, ControlPlaneSource>
): Record<string, ControlPlaneRoot> {
  const roots: Record<string, ControlPlaneRoot> = {};
  for (const value of sortedForHousehold(records, householdId)) {
    const sourceId = requiredString(value.sourceId);
    if (!sources[sourceId] || value.enabled !== true) continue;
    const id = requiredString(value.id);
    roots[id] = {
      id,
      sourceId,
      providerNodeId: requiredString(value.providerNodeId),
      displayName: requiredVisibleName(value.displayName),
      ancestryProviderIds: requiredStringArray(value.ancestryProviderIds),
      enabled: value.enabled === true,
      createdAt: requiredIso(value.createdAt)
    };
  }
  return roots;
}

function deviceRecords(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  householdId: string,
  retainedRootIds: ReadonlySet<string>
): Record<string, ControlPlaneDevice> {
  const devices: Record<string, ControlPlaneDevice> = {};
  for (const value of sortedForHousehold(records, householdId)) {
    const id = requiredString(value.id);
    const assignedRootIds = requiredStringArray(value.assignedRootIds)
      .filter((rootId) => retainedRootIds.has(rootId));
    devices[id] = {
      id,
      name: requiredVisibleName(value.name),
      enabled: requiredBoolean(value.enabled),
      assignedRootIds,
      mediaOrder: value.mediaOrder == null ? null : requiredMediaOrder(value.mediaOrder),
      slideshowSeconds: value.slideshowSeconds == null
        ? null
        : requiredPositiveNumber(value.slideshowSeconds),
      sessionVersion: 1,
      createdAt: requiredIso(value.createdAt),
      approvedAt: requiredIso(value.approvedAt),
      revokedAt: optionalIso(value.revokedAt)
    };
  }
  return devices;
}

function requestRecords(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  householdId: string,
  now: Date
): Record<string, ControlPlaneRequest> {
  const requests: Record<string, ControlPlaneRequest> = {};
  for (const value of sortedForHousehold(records, householdId)) {
    if (value.status !== "pending") continue;
    const expiresAt = requiredIso(value.expiresAt);
    if (Date.parse(expiresAt) <= now.getTime()) continue;
    const id = requiredString(value.id);
    requests[id] = {
      id,
      requestedName: requiredVisibleName(value.requestedName),
      requestSecretHash: requiredString(value.requestSecretHash),
      status: "pending",
      createdAt: requiredIso(value.createdAt),
      expiresAt,
      resolvedAt: null,
      approvedDeviceId: null
    };
  }
  return requests;
}

function uniqueHousehold(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  householdId: string
): Readonly<Record<string, unknown>> {
  const matches = records.filter((value) => value.id === householdId);
  if (matches.length !== 1) throw new Error("HOUSEHOLD_NOT_FOUND");
  return matches[0]!;
}

function sortedForHousehold(
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  householdId: string
): Array<Readonly<Record<string, unknown>>> {
  return records
    .filter((value) => value.householdId === householdId)
    .slice()
    .sort((left, right) => compareCodeUnits(String(left.id ?? ""), String(right.id ?? "")));
}

function explicitlyNeedsReauthorization(value: Readonly<Record<string, unknown>>): boolean {
  if (value.status === "reauth-required") return true;
  const code = value.lastSyncErrorCode;
  return typeof code === "string" && (
    code === "PROVIDER_REAUTH_REQUIRED" ||
    code === "INVALID_GRANT" ||
    code === "invalid_grant" ||
    code.startsWith("MIGRATION_")
  );
}

async function writeActiveSnapshot(
  options: CommonOperationOptions,
  document: ControlPlaneDocumentV2
): Promise<void> {
  const envelope = encryptControlPlaneDocument(document, options.keyring);
  const current = await options.durable.read();
  if (isNotModified(current)) throw new Error("CONTROL_PLANE_VERIFY_FAILED");
  if (current !== null) {
    const currentDocument = decryptControlPlaneEnvelope(
      current.envelope,
      options.keyring.keys
    );
    if (
      currentDocument.householdId !== document.householdId ||
      currentDocument.revision > document.revision ||
      (currentDocument.revision === document.revision &&
        logicalChecksum(currentDocument) !== logicalChecksum(document))
    ) {
      throw new Error("CONTROL_PLANE_OVERWRITE_REFUSED");
    }
  }
  const committed = current === null
    ? await options.durable.create(envelope)
    : await options.durable.replace(envelope, current.etag);
  await options.cache.set({ envelope, etag: committed.etag }, CACHE_TTL_SECONDS);
}

async function verifyActiveSnapshot(
  options: CommonOperationOptions,
  expected: ControlPlaneDocumentV2,
  checksum: string
): Promise<void> {
  const stored = await options.durable.read();
  if (stored === null || isNotModified(stored)) throw new Error("CONTROL_PLANE_VERIFY_FAILED");
  const opened = decryptControlPlaneEnvelope(stored.envelope, options.keyring.keys);
  verifyLogicalCopy(opened, expected, checksum);
}

function verifyLogicalCopy(value: unknown, expected: ControlPlaneDocumentV2, checksum: string): void {
  const parsed = parseControlPlaneDocument(value);
  if (
    parsed.householdId !== expected.householdId ||
    parsed.revision !== expected.revision ||
    logicalChecksum(parsed) !== checksum
  ) {
    throw new Error("CONTROL_PLANE_VERIFY_FAILED");
  }
}

function result(
  apply: boolean,
  document: ControlPlaneDocumentV2,
  checksum: string
): ControlPlaneOpsResult {
  return {
    apply,
    householdId: document.householdId,
    revision: document.revision,
    counts: {
      devices: Object.keys(document.devices).length,
      pendingRequests: Object.keys(document.pendingDeviceRequests).length,
      sources: Object.keys(document.sources).length,
      roots: Object.keys(document.roots).length
    },
    checksum
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, stableValue(child)])
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function recoveryDocumentPath(householdId: string): string {
  return `controlPlaneBackups/${householdId}`;
}

function splitRecoveryPath(path: string): [string, string] {
  const match = /^controlPlaneBackups\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})$/.exec(path);
  if (!match) throw new Error("RECOVERY_PATH_INVALID");
  return ["controlPlaneBackups", match[1]!];
}

function decodeFirestoreValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) return value.toDate();
  if (Array.isArray(value)) return value.map(decodeFirestoreValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [name, decodeFirestoreValue(child)])
  );
}

function isNotModified(
  value: StoredControlEnvelope | { notModified: true } | null
): value is { notModified: true } {
  return value !== null && "notModified" in value;
}

function requireEnvironment(value: string): ControlPlaneEnvironment {
  if (value !== "production" && value !== "preview") {
    throw new Error("CONTROL_PLANE_ENV_INVALID");
  }
  return value;
}

function requireDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("MIGRATION_RECORD_INVALID");
  }
}

function requireIdentifier(value: unknown, code = "MIGRATION_RECORD_INVALID"): string {
  const parsed = requiredString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(parsed)) throw new Error(code);
  return parsed;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error("MIGRATION_RECORD_INVALID");
  }
  return value;
}

function verifiedString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) return null;
  return value;
}

function requiredVisibleName(value: unknown): string {
  const parsed = requiredString(value);
  if (parsed.length > 120) throw new Error("MIGRATION_RECORD_INVALID");
  return parsed;
}

function requiredBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("MIGRATION_RECORD_INVALID");
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("MIGRATION_RECORD_INVALID");
  return Number(value);
}

function requiredPositiveNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("MIGRATION_RECORD_INVALID");
  }
  return value;
}

function requiredMediaOrder(value: unknown): MediaOrder {
  if (value !== "captured-desc" && value !== "captured-asc" && value !== "name-asc") {
    throw new Error("MIGRATION_RECORD_INVALID");
  }
  return value;
}

function requiredProvider(value: unknown): ProviderKind {
  if (value !== "google" && value !== "onedrive") throw new Error("MIGRATION_RECORD_INVALID");
  return value;
}

function requiredEncryptedSecret(value: unknown): EncryptedSecret {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("MIGRATION_RECORD_INVALID");
  }
  const record = value as Record<string, unknown>;
  return {
    keyVersion: requiredString(record.keyVersion),
    iv: requiredString(record.iv),
    ciphertext: requiredString(record.ciphertext),
    authTag: requiredString(record.authTag)
  };
}

function requiredStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("MIGRATION_RECORD_INVALID");
  return value.map(requiredString);
}

function optionalIso(value: unknown): string | null {
  return value == null ? null : requiredIso(value);
}

function requiredIso(value: unknown): string {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  ) {
    date = value.toDate();
  } else if (typeof value === "string") {
    date = new Date(value);
  } else {
    throw new Error("MIGRATION_RECORD_INVALID");
  }
  requireDate(date);
  return date.toISOString();
}
