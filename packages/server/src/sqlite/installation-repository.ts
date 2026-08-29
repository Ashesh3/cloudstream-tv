import { createHmac, randomBytes as nodeRandomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import type { SqliteControlPlaneStore } from "./control-store.ts";

const SETUP_CODE_BYTES = 16;

export type InstallationRepositoryErrorCode =
  | "CONTROL_PLANE_UNAVAILABLE"
  | "INSTALLATION_ALREADY_CONFIGURED"
  | "SETUP_CODE_INVALID";

export class InstallationRepositoryError extends Error {
  constructor(readonly code: InstallationRepositoryErrorCode) {
    super(code);
    this.name = "InstallationRepositoryError";
  }
}

export interface InstallationRecord {
  householdId: string;
  configured: boolean;
  createdAt: string;
  claimedAt: string | null;
}

export interface InstallationRepository {
  status(): Promise<InstallationRecord | null>;
  initialize(input: {
    householdId: string;
    setupCode: string;
    createdAt: string;
  }): Promise<{ created: boolean; householdId: string }>;
  claim(input: {
    setupCode: string;
    adminPassphraseHash: string;
    claimedAt: string;
  }): Promise<void>;
}

export interface CreateInstallationRepositoryOptions {
  connection: DatabaseSync;
  controlStore: SqliteControlPlaneStore;
  setupCodePepper: string;
}

export function createInstallationRepository(
  options: CreateInstallationRepositoryOptions,
): InstallationRepository {
  const { connection, controlStore, setupCodePepper } = options;

  async function status(): Promise<InstallationRecord | null> {
    const row = readInstallation(connection);
    return row === null ? null : encodeRecord(row);
  }

  async function initialize(input: {
    householdId: string;
    setupCode: string;
    createdAt: string;
  }): Promise<{ created: boolean; householdId: string }> {
    const setupCodeHash = setupDigest(input.setupCode, setupCodePepper);
    try {
      const result = connection.prepare(`
        INSERT OR IGNORE INTO installation
          (singleton, household_id, setup_code_hash, configured, created_at, claimed_at)
        VALUES (1, ?, ?, 0, ?, NULL)
      `).run(input.householdId, setupCodeHash, input.createdAt);
      if (Number(result.changes) === 1) {
        return { created: true, householdId: input.householdId };
      }
      const existing = readInstallation(connection);
      if (!existing) throw unavailable();
      return { created: false, householdId: existing.household_id };
    } catch (error) {
      if (error instanceof InstallationRepositoryError) throw error;
      throw unavailable();
    }
  }

  async function claim(input: {
    setupCode: string;
    adminPassphraseHash: string;
    claimedAt: string;
  }): Promise<void> {
    connection.exec("BEGIN IMMEDIATE");
    try {
      const row = readInstallation(connection);
      if (!row) throw unavailable();
      if (row.configured === 1) throw alreadyConfigured();
      if (
        row.configured !== 0 ||
        typeof row.setup_code_hash !== "string" ||
        !sameDigest(
          row.setup_code_hash,
          setupDigest(input.setupCode, setupCodePepper),
        )
      ) {
        throw setupCodeInvalid();
      }

      controlStore.initializeWithinTransaction(initialControlDocument(
        row.household_id,
        input.adminPassphraseHash,
        input.claimedAt,
      ));
      const changed = connection.prepare(`
        UPDATE installation
           SET configured = 1,
               setup_code_hash = NULL,
               claimed_at = ?
         WHERE singleton = 1 AND configured = 0
      `).run(input.claimedAt).changes;
      if (Number(changed) !== 1) throw alreadyConfigured();
      connection.exec("COMMIT");
    } catch (error) {
      rollback(connection);
      if (error instanceof InstallationRepositoryError) throw error;
      if (isControlConflict(error)) throw unavailable();
      throw unavailable();
    }
  }

  return { status, initialize, claim };
}

export async function initializeInstallation(
  repository: InstallationRepository,
  now: () => Date = () => new Date(),
  randomBytes: (size: number) => Uint8Array = (size) => nodeRandomBytes(size),
): Promise<{ householdId: string; setupCode?: string }> {
  const existing = await repository.status();
  if (existing) return { householdId: existing.householdId };

  const entropy = Buffer.from(randomBytes(SETUP_CODE_BYTES));
  if (entropy.length !== SETUP_CODE_BYTES) {
    throw unavailable();
  }
  const setupCode = entropy.toString("base64url");
  const initialized = await repository.initialize({
    householdId: `household-${randomUUID()}`,
    setupCode,
    createdAt: now().toISOString(),
  });
  return initialized.created
    ? { householdId: initialized.householdId, setupCode }
    : { householdId: initialized.householdId };
}

interface InstallationRow {
  household_id: string;
  setup_code_hash: string | null;
  configured: number | bigint;
  created_at: string;
  claimed_at: string | null;
}

function readInstallation(connection: DatabaseSync): InstallationRow | null {
  const row = connection.prepare(`
    SELECT household_id, setup_code_hash, configured, created_at, claimed_at
      FROM installation
     WHERE singleton = 1
  `).get() as InstallationRow | undefined;
  return row ?? null;
}

function encodeRecord(row: InstallationRow): InstallationRecord {
  const configured = Number(row.configured);
  if (
    typeof row.household_id !== "string" ||
    !row.household_id ||
    (configured !== 0 && configured !== 1) ||
    typeof row.created_at !== "string" ||
    (row.claimed_at !== null && typeof row.claimed_at !== "string")
  ) throw unavailable();
  return {
    householdId: row.household_id,
    configured: configured === 1,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
  };
}

function initialControlDocument(
  householdId: string,
  adminPassphraseHash: string,
  claimedAt: string,
): ControlPlaneDocumentV2 {
  return {
    schemaVersion: 2,
    householdId,
    revision: 1,
    updatedAt: claimedAt,
    household: {
      adminPassphraseHash,
      adminPassphraseVersion: 1,
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8,
    },
    devices: {},
    pendingDeviceRequests: {},
    sources: {},
    roots: {},
  };
}

function setupDigest(setupCode: string, pepper: string): string {
  return createHmac("sha256", pepper)
    .update(setupCode, "utf8")
    .digest("base64url");
}

function sameDigest(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function alreadyConfigured(): InstallationRepositoryError {
  return new InstallationRepositoryError("INSTALLATION_ALREADY_CONFIGURED");
}

function setupCodeInvalid(): InstallationRepositoryError {
  return new InstallationRepositoryError("SETUP_CODE_INVALID");
}

function unavailable(): InstallationRepositoryError {
  return new InstallationRepositoryError("CONTROL_PLANE_UNAVAILABLE");
}

function isControlConflict(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error as { code?: unknown }).code === "CONTROL_PLANE_CONFLICT";
}

function rollback(connection: DatabaseSync): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
