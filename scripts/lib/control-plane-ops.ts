import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

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
import { decryptProviderToken } from "../../packages/server/src/crypto/provider-tokens.ts";
import {
  decryptControlPlaneEnvelope,
  encryptControlPlaneDocument,
  type ControlPlaneEnvelopeV1
} from "../../packages/server/src/control-plane/envelope.ts";
import { parseControlPlaneDocument } from "../../packages/server/src/control-plane/schema.ts";
import type {
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
  readHousehold(householdId: string): Promise<Readonly<Record<string, unknown>> | null>;
  queryHouseholdCollection(
    name: Exclude<LegacyMigrationCollection, "households">,
    householdId: string
  ): Promise<ReadonlyArray<Readonly<Record<string, unknown>>>>;
  readRecovery(path: string): Promise<unknown | null>;
  writeRecovery(path: string, document: ControlPlaneDocumentV2): Promise<void>;
}

interface FirestoreDocumentLike {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface FirestoreQueryLike {
  where(field: string, operator: "==", value: unknown): FirestoreQueryLike;
  get(): Promise<{ docs: FirestoreDocumentLike[] }>;
}

interface FirestoreCollectionLike extends FirestoreQueryLike {
  doc(id: string): {
    get(): Promise<FirestoreDocumentLike>;
    set(value: ControlPlaneDocumentV2): Promise<unknown>;
  };
}

export interface MigrationFirestore {
  collection(name: string): FirestoreCollectionLike;
}

export type RecoveryBlobState =
  | { status: "missing" }
  | { status: "present"; etag: string };

export interface RecoveryDurableStore {
  inspect(): Promise<RecoveryBlobState>;
  read(ifNoneMatch?: string): Promise<StoredControlEnvelope | { notModified: true } | null>;
  create(envelope: ControlPlaneEnvelopeV1): Promise<{ etag: string }>;
  replace(envelope: ControlPlaneEnvelopeV1, expectedEtag: string): Promise<{ etag: string }>;
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

export class ControlPlaneOperationError extends Error {
  readonly code:
    | "CONTROL_PLANE_BLOB_UNAVAILABLE"
    | "CONTROL_PLANE_CONFLICT"
    | "CONTROL_PLANE_OVERWRITE_REFUSED"
    | "CONTROL_PLANE_RECOVERY_INCOMPLETE"
    | "CONTROL_PLANE_VERIFY_FAILED";

  constructor(code: ControlPlaneOperationError["code"]) {
    super(code);
    this.name = "ControlPlaneOperationError";
    this.code = code;
  }
}

interface CommonOperationOptions {
  apply: boolean;
  environment: string;
  householdId: string;
  firestore: LegacyControlPlaneReader;
  durable: RecoveryDurableStore;
  cache: ControlHotCache;
  keyring: VersionedAeadKeyring;
  providerTokenKeys: Record<string, Uint8Array>;
}

export interface MigrationOptions extends CommonOperationOptions {
  now: Date;
}

export type RestoreOptions = CommonOperationOptions;

export interface OperatorCredentialOptions {
  operatorEmail: string | undefined;
  credentialFile: string | undefined;
  runtimeWriterEmail?: string | undefined;
  legacyReaderEmail?: string | undefined;
}

export interface OperatorCredentials {
  keyFilename: string;
}

const CACHE_TTL_SECONDS = 300;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

export async function buildControlPlaneMigrationPlan(
  reader: Pick<LegacyControlPlaneReader, "readHousehold" | "queryHouseholdCollection">,
  householdId: string,
  now: Date,
  providerTokenKeys: Record<string, Uint8Array>
): Promise<ControlPlaneMigrationPlan> {
  requireIdentifier(householdId, "HOUSEHOLD_ID_INVALID");
  requireDate(now);
  const reads: Record<LegacyMigrationCollection, ReadonlyArray<Readonly<Record<string, unknown>>>> = {
    households: [], deviceRequests: [], devices: [], sources: [], roots: []
  };
  const household = await reader.readHousehold(householdId);
  reads.households = household ? [household] : [];
  const scopedCollections: Array<Exclude<LegacyMigrationCollection, "households">> = [
    "deviceRequests", "devices", "sources", "roots"
  ];
  for (const collection of scopedCollections) {
    reads[collection] = await reader.queryHouseholdCollection(collection, householdId);
  }
  const exactHousehold = uniqueHousehold(reads.households, householdId);
  const sources = sourceRecords(reads.sources, householdId, now, providerTokenKeys);
  const roots = rootRecords(reads.roots, householdId, sources);
  const enabledRootIds = new Set(
    Object.values(roots).filter((root) => root.enabled).map((root) => root.id)
  );
  const updatedAt = deterministicUpdatedAt(exactHousehold, reads, now);
  const document = parseControlPlaneDocument({
    schemaVersion: 2,
    householdId,
    revision: 1,
    updatedAt,
    household: {
      adminPassphraseHash: requiredString(exactHousehold.adminPassphraseHash),
      adminPassphraseVersion: positiveInteger(exactHousehold.adminPassphraseVersion),
      allowNewDeviceRequests: requiredBoolean(exactHousehold.allowNewDeviceRequests),
      defaultMediaOrder: requiredMediaOrder(exactHousehold.defaultMediaOrder),
      defaultSlideshowSeconds: requiredPositiveNumber(exactHousehold.defaultSlideshowSeconds)
    },
    devices: deviceRecords(reads.devices, householdId, enabledRootIds),
    pendingDeviceRequests: requestRecords(reads.deviceRequests, householdId, now),
    sources,
    roots
  });
  validateProviderSecrets(document, providerTokenKeys, now);
  return { document, checksum: logicalChecksum(document) };
}

export async function runControlPlaneMigration(
  options: MigrationOptions
): Promise<ControlPlaneOpsResult> {
  requireEnvironment(options.environment);
  const plan = await buildControlPlaneMigrationPlan(
    options.firestore,
    options.householdId,
    options.now,
    options.providerTokenKeys
  );
  if (!options.apply) return result(false, plan.document, plan.checksum);

  const preflight = await inspectDurable(options.durable);
  let alreadyActive = false;
  if (preflight.status === "present") {
    const current = await readDurable(options.durable);
    if (!current || current.etag !== preflight.etag) throw conflict();
    const currentDocument = openCurrent(current, options.keyring);
    refuseUnsafeReplacement(currentDocument, plan.document, plan.checksum);
    alreadyActive = logicalChecksum(currentDocument) === plan.checksum;
  }

  if (!alreadyActive) {
    const committed = await commitEnvelope(options.durable, preflight, plan.document, options.keyring);
    await cacheBestEffort(options.cache, committed);
  }
  await verifyActiveSnapshot(options, plan.document, plan.checksum);
  try {
    await writeAndVerifyRecovery(options.firestore, plan.document, plan.checksum);
  } catch {
    throw new ControlPlaneOperationError("CONTROL_PLANE_RECOVERY_INCOMPLETE");
  }
  return result(true, plan.document, plan.checksum);
}

export async function restoreControlPlane(
  options: RestoreOptions
): Promise<ControlPlaneOpsResult> {
  requireEnvironment(options.environment);
  requireIdentifier(options.householdId, "HOUSEHOLD_ID_INVALID");
  const recovery = parseControlPlaneDocument(await options.firestore.readRecovery(
    recoveryDocumentPath(options.householdId)
  ));
  if (recovery.householdId !== options.householdId) throw new Error("RECOVERY_HOUSEHOLD_MISMATCH");
  validateProviderSecrets(recovery, options.providerTokenKeys, new Date(recovery.updatedAt));
  const checksum = logicalChecksum(recovery);
  if (!options.apply) return result(false, recovery, checksum);

  const preflight = await inspectDurable(options.durable);
  if (preflight.status === "present") {
    let current: StoredControlEnvelope | null;
    try {
      current = await readDurable(options.durable);
    } catch {
      throw new ControlPlaneOperationError("CONTROL_PLANE_BLOB_UNAVAILABLE");
    }
    if (!current || current.etag !== preflight.etag) throw conflict();
    try {
      const currentDocument = decryptControlPlaneEnvelope(current.envelope, options.keyring.keys);
      if (currentDocument.revision > recovery.revision) {
        throw new ControlPlaneOperationError("CONTROL_PLANE_OVERWRITE_REFUSED");
      }
      if (currentDocument.revision === recovery.revision && logicalChecksum(currentDocument) === checksum) {
        await cacheBestEffort(options.cache, current);
        return result(true, recovery, checksum);
      }
    } catch (error) {
      if (error instanceof ControlPlaneOperationError) throw error;
      // Explicit restore is allowed to replace malformed/undecryptable content using the inspected ETag.
    }
  }
  const committed = await commitEnvelope(options.durable, preflight, recovery, options.keyring);
  await cacheBestEffort(options.cache, committed);
  await verifyActiveSnapshot(options, recovery, checksum);
  return result(true, recovery, checksum);
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

export async function loadOperatorCredentials(
  options: OperatorCredentialOptions
): Promise<OperatorCredentials> {
  const email = requiredCredentialValue(options.operatorEmail);
  const filename = requiredCredentialValue(options.credentialFile);
  if (email === options.runtimeWriterEmail || email === options.legacyReaderEmail) {
    throw new Error("OPERATOR_IDENTITY_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filename, "utf8"));
  } catch {
    throw new Error("OPERATOR_CREDENTIALS_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPERATOR_CREDENTIALS_INVALID");
  }
  const credential = parsed as Record<string, unknown>;
  const exactServiceAccount =
    credential.type === "service_account" && credential.client_email === email;
  const impersonation = credential.service_account_impersonation_url;
  const exactExternalAccount =
    credential.type === "external_account" &&
    typeof impersonation === "string" &&
    impersonation === `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(email)}:generateAccessToken`;
  if (!exactServiceAccount && !exactExternalAccount) {
    throw new Error("OPERATOR_CREDENTIALS_INVALID");
  }
  return { keyFilename: filename };
}

export function loadProviderTokenKeys(environment: NodeJS.ProcessEnv): Record<string, Uint8Array> {
  const keys: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [name, value] of Object.entries(environment)) {
    const match = /^PROVIDER_TOKEN_KEY_([A-Z0-9_-]+)$/.exec(name);
    if (!match || !value || name === "PROVIDER_TOKEN_KEY_VERSION") continue;
    const decoded = canonicalBase64Url(value);
    if (decoded.length !== 32) throw new Error("PROVIDER_TOKEN_KEYS_INVALID");
    keys[match[1]!.toLowerCase()] = decoded;
  }
  return keys;
}

export function createMigrationFirestoreReader(
  firestore: MigrationFirestore
): LegacyControlPlaneReader {
  return {
    async readHousehold(householdId) {
      const document = await firestore.collection("households").doc(householdId).get();
      return document.exists ? decodedDocument(document) : null;
    },
    async queryHouseholdCollection(name, householdId) {
      const snapshot = await firestore
        .collection(name)
        .where("householdId", "==", householdId)
        .get();
      return snapshot.docs.map(decodedDocument);
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
  householdId: string,
  now: Date,
  providerTokenKeys: Record<string, Uint8Array>
): Record<string, ControlPlaneSource> {
  const sources = cleanRecord<ControlPlaneSource>();
  const seen = new Set<string>();
  for (const value of sortedForHousehold(records, householdId)) {
    const id = requireUniqueId(value.id, seen);
    const providerAccountId = verifiedString(value.providerAccountId);
    const providerRootId = verifiedString(value.providerRootId);
    if (!providerAccountId || !providerRootId) continue;
    const refresh = requiredEncryptedSecret(value.encryptedRefreshToken, providerTokenKeys);
    const bootstrap = normalizedBootstrap(value, now, providerTokenKeys);
    sources[id] = {
      id,
      provider: requiredProvider(value.provider),
      providerAccountId,
      providerRootId,
      accountLabel: requiredVisibleName(value.accountLabel),
      encryptedRefreshToken: refresh,
      encryptedBootstrapAccessToken: bootstrap.token,
      bootstrapAccessTokenExpiresAt: bootstrap.expiresAt,
      credentialVersion: 1,
      status: value.status === "disabled"
        ? "disabled"
        : explicitlyNeedsReauthorization(value)
          ? "reauth-required"
          : "healthy",
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
  const roots = cleanRecord<ControlPlaneRoot>();
  const seen = new Set<string>();
  for (const value of sortedForHousehold(records, householdId)) {
    const id = requireUniqueId(value.id, seen);
    const sourceId = requireIdentifier(value.sourceId);
    if (!sources[sourceId] || value.enabled !== true) continue;
    roots[id] = {
      id,
      sourceId,
      providerNodeId: requiredString(value.providerNodeId),
      displayName: requiredVisibleName(value.displayName),
      ancestryProviderIds: requiredIdArray(value.ancestryProviderIds),
      enabled: true,
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
  const devices = cleanRecord<ControlPlaneDevice>();
  const seen = new Set<string>();
  for (const value of sortedForHousehold(records, householdId)) {
    const id = requireUniqueId(value.id, seen);
    devices[id] = {
      id,
      name: requiredVisibleName(value.name),
      enabled: requiredBoolean(value.enabled),
      assignedRootIds: requiredIdArray(value.assignedRootIds)
        .filter((rootId) => retainedRootIds.has(rootId)),
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
  const requests = cleanRecord<ControlPlaneRequest>();
  const seen = new Set<string>();
  for (const value of sortedForHousehold(records, householdId)) {
    const id = requireUniqueId(value.id, seen);
    if (value.status !== "pending") continue;
    const expiresAt = requiredIso(value.expiresAt);
    if (Date.parse(expiresAt) <= now.getTime()) continue;
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
  if (records.length !== 1) throw new Error("HOUSEHOLD_NOT_FOUND");
  const record = records[0]!;
  if (requireIdentifier(record.id) !== householdId) throw new Error("HOUSEHOLD_NOT_FOUND");
  return record;
}

function deterministicUpdatedAt(
  household: Readonly<Record<string, unknown>>,
  reads: Record<LegacyMigrationCollection, ReadonlyArray<Readonly<Record<string, unknown>>>>,
  fallback: Date
): string {
  const timestamps: string[] = [];
  for (const record of [household, ...reads.deviceRequests, ...reads.devices, ...reads.sources, ...reads.roots]) {
    for (const field of ["updatedAt", "resolvedAt", "approvedAt", "createdAt"]) {
      if (record[field] != null) {
        try { timestamps.push(requiredIso(record[field])); } catch { /* Field is not a valid timestamp candidate. */ }
      }
    }
  }
  return timestamps.sort(compareCodeUnits).at(-1) ?? fallback.toISOString();
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
  return value.lastSyncErrorCode === "PROVIDER_REAUTH_REQUIRED" ||
    value.lastSyncErrorCode === "INVALID_GRANT" ||
    value.lastSyncErrorCode === "invalid_grant" ||
    value.lastSyncErrorCode === "MIGRATION_RECONNECT_REQUIRED" ||
    value.lastSyncErrorCode === "MIGRATION_TOKEN_MISSING";
}

function normalizedBootstrap(
  value: Readonly<Record<string, unknown>>,
  now: Date,
  keys: Record<string, Uint8Array>
): { token: EncryptedSecret | null; expiresAt: string | null } {
  if (value.encryptedAccessToken == null || value.accessTokenExpiresAt == null) {
    return { token: null, expiresAt: null };
  }
  const expiresAt = requiredIso(value.accessTokenExpiresAt);
  if (Date.parse(expiresAt) <= now.getTime()) return { token: null, expiresAt: null };
  return {
    token: requiredEncryptedSecret(value.encryptedAccessToken, keys),
    expiresAt
  };
}

function requiredEncryptedSecret(
  value: unknown,
  keys: Record<string, Uint8Array>
): EncryptedSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PROVIDER_TOKEN_INVALID");
  }
  const record = value as Record<string, unknown>;
  const secret = {
    keyVersion: requireIdentifier(record.keyVersion),
    iv: requiredString(record.iv),
    ciphertext: requiredString(record.ciphertext),
    authTag: requiredString(record.authTag)
  };
  const iv = canonicalBase64Url(secret.iv);
  const ciphertext = canonicalBase64Url(secret.ciphertext);
  const authTag = canonicalBase64Url(secret.authTag);
  if (iv.length !== 12 || ciphertext.length === 0 || authTag.length !== 16 || !keys[secret.keyVersion]) {
    throw new Error("PROVIDER_TOKEN_INVALID");
  }
  let token: string;
  try { token = decryptProviderToken(secret, keys); } catch { throw new Error("PROVIDER_TOKEN_INVALID"); }
  if (token.length === 0) throw new Error("PROVIDER_TOKEN_INVALID");
  return secret;
}

function validateProviderSecrets(
  document: ControlPlaneDocumentV2,
  keys: Record<string, Uint8Array>,
  cutoff: Date
): void {
  for (const source of Object.values(document.sources)) {
    requiredEncryptedSecret(source.encryptedRefreshToken, keys);
    const hasToken = source.encryptedBootstrapAccessToken !== null;
    const hasExpiry = source.bootstrapAccessTokenExpiresAt !== null;
    if (hasToken !== hasExpiry) throw new Error("PROVIDER_TOKEN_INVALID");
    if (hasToken) {
      requiredEncryptedSecret(source.encryptedBootstrapAccessToken, keys);
      if (Date.parse(source.bootstrapAccessTokenExpiresAt!) <= cutoff.getTime()) {
        throw new Error("PROVIDER_TOKEN_INVALID");
      }
    }
  }
}

async function inspectDurable(durable: RecoveryDurableStore): Promise<RecoveryBlobState> {
  try { return await durable.inspect(); } catch { throw new ControlPlaneOperationError("CONTROL_PLANE_BLOB_UNAVAILABLE"); }
}

async function readDurable(durable: RecoveryDurableStore): Promise<StoredControlEnvelope | null> {
  try {
    const result = await durable.read();
    if (result && "notModified" in result) {
      throw new ControlPlaneOperationError("CONTROL_PLANE_BLOB_UNAVAILABLE");
    }
    return result;
  } catch (error) {
    if (error instanceof ControlPlaneOperationError) throw error;
    throw new ControlPlaneOperationError("CONTROL_PLANE_BLOB_UNAVAILABLE");
  }
}

async function commitEnvelope(
  durable: RecoveryDurableStore,
  preflight: RecoveryBlobState,
  document: ControlPlaneDocumentV2,
  keyring: VersionedAeadKeyring
): Promise<StoredControlEnvelope> {
  const envelope = encryptControlPlaneDocument(document, keyring);
  try {
    const committed = preflight.status === "missing"
      ? await durable.create(envelope)
      : await durable.replace(envelope, preflight.etag);
    return { envelope, etag: committed.etag };
  } catch (error) {
    if (isConflictError(error)) throw conflict();
    throw new ControlPlaneOperationError("CONTROL_PLANE_BLOB_UNAVAILABLE");
  }
}

async function cacheBestEffort(cache: ControlHotCache, value: StoredControlEnvelope): Promise<void> {
  try {
    await cache.set(value, CACHE_TTL_SECONDS);
  } catch {
    try { await cache.delete(); } catch { /* Cache is non-authoritative. */ }
  }
}

async function verifyActiveSnapshot(
  options: CommonOperationOptions,
  expected: ControlPlaneDocumentV2,
  checksum: string
): Promise<void> {
  const stored = await readDurable(options.durable);
  if (!stored) throw new ControlPlaneOperationError("CONTROL_PLANE_VERIFY_FAILED");
  let opened: ControlPlaneDocumentV2;
  try { opened = decryptControlPlaneEnvelope(stored.envelope, options.keyring.keys); }
  catch { throw new ControlPlaneOperationError("CONTROL_PLANE_VERIFY_FAILED"); }
  verifyLogicalCopy(opened, expected, checksum);
}

async function writeAndVerifyRecovery(
  firestore: LegacyControlPlaneReader,
  document: ControlPlaneDocumentV2,
  checksum: string
): Promise<void> {
  const path = recoveryDocumentPath(document.householdId);
  await firestore.writeRecovery(path, document);
  verifyLogicalCopy(await firestore.readRecovery(path), document, checksum);
}

function verifyLogicalCopy(value: unknown, expected: ControlPlaneDocumentV2, checksum: string): void {
  const parsed = parseControlPlaneDocument(value);
  validateSameLogicalDocument(parsed, expected, checksum);
}

function validateSameLogicalDocument(
  parsed: ControlPlaneDocumentV2,
  expected: ControlPlaneDocumentV2,
  checksum: string
): void {
  if (
    parsed.householdId !== expected.householdId ||
    parsed.revision !== expected.revision ||
    logicalChecksum(parsed) !== checksum
  ) throw new ControlPlaneOperationError("CONTROL_PLANE_VERIFY_FAILED");
}

function openCurrent(
  stored: StoredControlEnvelope,
  keyring: VersionedAeadKeyring
): ControlPlaneDocumentV2 {
  try { return decryptControlPlaneEnvelope(stored.envelope, keyring.keys); }
  catch { throw new ControlPlaneOperationError("CONTROL_PLANE_OVERWRITE_REFUSED"); }
}

function refuseUnsafeReplacement(
  current: ControlPlaneDocumentV2,
  proposed: ControlPlaneDocumentV2,
  proposedChecksum: string
): void {
  if (
    current.householdId !== proposed.householdId ||
    current.revision > proposed.revision ||
    (current.revision === proposed.revision && logicalChecksum(current) !== proposedChecksum)
  ) throw new ControlPlaneOperationError("CONTROL_PLANE_OVERWRITE_REFUSED");
}

function result(apply: boolean, document: ControlPlaneDocumentV2, checksum: string): ControlPlaneOpsResult {
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

function decodedDocument(document: FirestoreDocumentLike): Record<string, unknown> {
  return decodeFirestoreValue({ ...document.data(), id: document.id }) as Record<string, unknown>;
}

function decodeFirestoreValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate();
  }
  if (Array.isArray(value)) return value.map(decodeFirestoreValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, decodeFirestoreValue(child)]));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
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

function requireEnvironment(value: string): ControlPlaneEnvironment {
  if (value !== "production" && value !== "preview") throw new Error("CONTROL_PLANE_ENV_INVALID");
  return value;
}

function requireDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("MIGRATION_RECORD_INVALID");
}

function requireIdentifier(value: unknown, code = "MIGRATION_RECORD_INVALID"): string {
  const parsed = requiredString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(parsed) || RESERVED_IDS.has(parsed)) {
    throw new Error(code);
  }
  return parsed;
}

function requireUniqueId(value: unknown, seen: Set<string>): string {
  const id = requireIdentifier(value);
  if (seen.has(id)) throw new Error("MIGRATION_RECORD_INVALID");
  seen.add(id);
  return id;
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

function requiredIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("MIGRATION_RECORD_INVALID");
  const seen = new Set<string>();
  return value.map((id) => requireUniqueId(id, seen));
}

function optionalIso(value: unknown): string | null {
  return value == null ? null : requiredIso(value);
}

function requiredIso(value: unknown): string {
  let date: Date;
  if (value instanceof Date) date = value;
  else if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") date = value.toDate();
  else if (typeof value === "string") date = new Date(value);
  else throw new Error("MIGRATION_RECORD_INVALID");
  requireDate(date);
  return date.toISOString();
}

function cleanRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function canonicalBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("PROVIDER_TOKEN_INVALID");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new Error("PROVIDER_TOKEN_INVALID");
  }
  return decoded;
}

function requiredCredentialValue(value: string | undefined): string {
  if (!value || value !== value.trim()) throw new Error("OPERATOR_IDENTITY_INVALID");
  return value;
}

function isConflictError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "CONTROL_PLANE_CONFLICT";
}

function conflict(): ControlPlaneOperationError {
  return new ControlPlaneOperationError("CONTROL_PLANE_CONFLICT");
}
