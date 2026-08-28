import { createHash } from "node:crypto";

import type {
  AdminSession,
  ControlPlaneDocumentV2,
  Device,
  DeviceSession,
  Household
} from "@cloudframe/shared";
import type { SealedSessionCodec } from "../auth/sealed-sessions";

const MAX_LEGACY_TOKEN_BYTES = 4096;
const LEGACY_TOKEN_PATTERN = /^[A-Za-z0-9._~-]+$/;

export interface LegacySessionReader {
  findAdminSessionsByTokenHash(tokenHash: string): Promise<AdminSession[]>;
  findDeviceSessionsByTokenHash(tokenHash: string): Promise<DeviceSession[]>;
  readHousehold(householdId: string): Promise<Household | null>;
  readDevice(deviceId: string): Promise<Device | null>;
}

interface FirestoreDocumentLike {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

interface FirestoreQueryLike {
  where(field: string, operator: "==", value: unknown): FirestoreQueryLike;
  limit(value: number): FirestoreQueryLike;
  get(): Promise<{ docs: FirestoreDocumentLike[] }>;
}

export interface LegacySessionFirestore {
  collection(name: string): FirestoreQueryLike & {
    doc(id: string): { get(): Promise<FirestoreDocumentLike> };
  };
}

export interface LegacySessionExchangeResult {
  sealedCookie: string;
  expiresAt: Date;
}

export interface LegacySessionExchange {
  exchangeAdmin(rawToken: string, now: Date): Promise<LegacySessionExchangeResult | null>;
  exchangeDevice(rawToken: string, now: Date): Promise<LegacySessionExchangeResult | null>;
}

export interface LegacySessionExchangeOptions {
  reader: LegacySessionReader;
  codec: SealedSessionCodec;
  householdId: string;
  loadControlDocument(): Promise<ControlPlaneDocumentV2>;
  sessionLifetimeMs: number;
}

export function createLegacySessionExchange(
  options: LegacySessionExchangeOptions
): LegacySessionExchange {
  async function exchangeAdmin(
    rawToken: string,
    now: Date
  ): Promise<LegacySessionExchangeResult | null> {
    if (!isLegacyToken(rawToken) || invalidDate(now)) return null;
    const matches = await safeRead(() =>
      options.reader.findAdminSessionsByTokenHash(tokenHash(rawToken))
    );
    if (!matches) return null;
    if (matches.length !== 1) return null;
    const session = matches[0]!;
    if (!validBaseSession(session, options.householdId, now)) return null;
    const household = await safeRead(() => options.reader.readHousehold(session.householdId));
    if (
      !household ||
      household.id !== options.householdId ||
      session.passphraseVersion !== household.adminPassphraseVersion
    ) return null;
    const control = await safeRead(options.loadControlDocument);
    if (!control) return null;
    if (
      control.householdId !== options.householdId ||
      control.household.adminPassphraseVersion !== household.adminPassphraseVersion
    ) return null;
    const expiresAt = boundedExpiry(session.expiresAt, now, options.sessionLifetimeMs);
    if (!expiresAt) return null;
    return {
      sealedCookie: options.codec.issueAdmin({
        version: 2,
        householdId: options.householdId,
        sessionId: session.id,
        adminPassphraseVersion: control.household.adminPassphraseVersion,
        issuedAt: now.getTime(),
        expiresAt: expiresAt.getTime()
      }),
      expiresAt
    };
  }

  async function exchangeDevice(
    rawToken: string,
    now: Date
  ): Promise<LegacySessionExchangeResult | null> {
    if (!isLegacyToken(rawToken) || invalidDate(now)) return null;
    const matches = await safeRead(() =>
      options.reader.findDeviceSessionsByTokenHash(tokenHash(rawToken))
    );
    if (!matches) return null;
    if (matches.length !== 1) return null;
    const session = matches[0]!;
    if (!validBaseSession(session, options.householdId, now)) return null;
    const records = await safeRead(() => Promise.all([
      options.reader.readHousehold(session.householdId),
      options.reader.readDevice(session.deviceId)
    ]));
    if (!records) return null;
    const [household, device] = records;
    if (
      !household ||
      household.id !== options.householdId ||
      !device ||
      device.id !== session.deviceId ||
      device.householdId !== options.householdId ||
      !device.enabled ||
      device.revokedAt !== null
    ) return null;
    const control = await safeRead(options.loadControlDocument);
    if (!control) return null;
    const current = control.devices[device.id];
    if (
      control.householdId !== options.householdId ||
      !current ||
      !current.enabled ||
      current.revokedAt !== null ||
      current.sessionVersion !== 1 ||
      !sameIdentifiers(device.assignedRootIds, current.assignedRootIds) ||
      current.assignedRootIds.some((rootId) => !control.roots[rootId]?.enabled)
    ) return null;
    const expiresAt = boundedExpiry(session.expiresAt, now, options.sessionLifetimeMs);
    if (!expiresAt) return null;
    return {
      sealedCookie: options.codec.issueDevice({
        version: 2,
        householdId: options.householdId,
        deviceId: device.id,
        sessionVersion: current.sessionVersion,
        issuedAt: now.getTime(),
        expiresAt: expiresAt.getTime()
      }),
      expiresAt
    };
  }

  return { exchangeAdmin, exchangeDevice };
}

export function createFirestoreLegacySessionReader(
  firestore: LegacySessionFirestore
): LegacySessionReader {
  return {
    findAdminSessionsByTokenHash: (token) => queryByToken<AdminSession>(
      firestore,
      "adminSessions",
      token
    ),
    findDeviceSessionsByTokenHash: (token) => queryByToken<DeviceSession>(
      firestore,
      "deviceSessions",
      token
    ),
    readHousehold: (id) => readById<Household>(firestore, "households", id),
    readDevice: (id) => readById<Device>(firestore, "devices", id)
  };
}

async function queryByToken<T>(
  firestore: LegacySessionFirestore,
  collection: string,
  token: string
): Promise<T[]> {
  const snapshot = await firestore
    .collection(collection)
    .where("tokenHash", "==", token)
    .limit(2)
    .get();
  return snapshot.docs.map((document) => decodeDocument<T>(document));
}

async function readById<T>(
  firestore: LegacySessionFirestore,
  collection: string,
  id: string
): Promise<T | null> {
  const document = await firestore.collection(collection).doc(id).get();
  return document.exists ? decodeDocument<T>(document) : null;
}

function decodeDocument<T>(document: FirestoreDocumentLike): T {
  return decodeFirestoreValue({ ...document.data(), id: document.id }) as T;
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

function isLegacyToken(value: string): boolean {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > MAX_LEGACY_TOKEN_BYTES ||
    value.startsWith("a1.") ||
    !LEGACY_TOKEN_PATTERN.test(value)
  ) return false;
  return true;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validBaseSession(
  session: AdminSession | DeviceSession,
  householdId: string,
  now: Date
): boolean {
  return (
    session.householdId === householdId &&
    session.revokedAt === null &&
    session.expiresAt instanceof Date &&
    session.expiresAt.getTime() > now.getTime()
  );
}

function boundedExpiry(legacy: Date, now: Date, lifetimeMs: number): Date | null {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1) return null;
  const expiry = Math.min(legacy.getTime(), now.getTime() + lifetimeMs);
  return expiry > now.getTime() ? new Date(expiry) : null;
}

function invalidDate(value: Date): boolean {
  return !(value instanceof Date) || !Number.isFinite(value.getTime());
}

function sameIdentifiers(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return expected.size === right.length && left.every((value) => expected.has(value));
}

async function safeRead<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
