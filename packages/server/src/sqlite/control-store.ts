import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import type { VersionedAeadKeyring } from "../crypto/aead.ts";
import {
  decryptControlPlaneEnvelope,
  encryptControlPlaneDocument,
  type ControlPlaneEnvelopeV1,
} from "../control-plane/envelope.ts";
import {
  cloneControlPlaneDocument,
  parseControlPlaneDocument,
} from "../control-plane/schema.ts";
import {
  ControlPlaneStoreError,
  type ControlMutationReducer,
  type ControlPlaneStore,
  type LoadedControlPlaneSnapshot,
} from "../control-plane/store.ts";
import {
  safeControlPlaneTelemetry,
  type ControlPlaneTelemetryObserver,
} from "../control-plane/telemetry.ts";

export interface SqliteControlPlaneStoreOptions {
  connection: DatabaseSync;
  keyring: VersionedAeadKeyring;
  now?: () => Date;
  requestId?: () => string;
  observer?: ControlPlaneTelemetryObserver;
}

export interface SqliteControlPlaneStore extends ControlPlaneStore {
  isConfigured(): Promise<boolean>;
  initialize(document: ControlPlaneDocumentV2): Promise<void>;
  initializeWithinTransaction(document: ControlPlaneDocumentV2): void;
}

interface StoredControlRow {
  revision: number | bigint;
  envelope_json: string;
}

export function createSqliteControlPlaneStore(
  options: SqliteControlPlaneStoreOptions,
): SqliteControlPlaneStore {
  const { connection, keyring } = options;
  const now = options.now ?? (() => new Date());
  const requestId = options.requestId ?? (() => "unknown");
  const telemetry = new AsyncLocalStorage<{
    observer: ControlPlaneTelemetryObserver | undefined;
    requestId: string;
  }>();

  function emit(
    event: "control_plane_sqlite_read" | "control_plane_sqlite_write",
    document: ControlPlaneDocumentV2,
  ): void {
    const active = telemetry.getStore();
    const observer = active?.observer ?? options.observer;
    const activeRequestId = active?.requestId ?? requestId();
    if (event === "control_plane_sqlite_write") {
      safeControlPlaneTelemetry(observer, {
        level: "info",
        event,
        requestId: activeRequestId,
        householdId: document.householdId,
        revision: document.revision,
        count: 1,
      });
      return;
    }
    safeControlPlaneTelemetry(observer, {
      level: "info",
      event,
      requestId: activeRequestId,
      householdId: document.householdId,
      count: 1,
    });
  }

  function readAndDecrypt(): ControlPlaneDocumentV2 {
    const row = connection.prepare(
      "SELECT revision, envelope_json FROM control_state WHERE singleton = 1",
    ).get() as StoredControlRow | undefined;
    if (!row || typeof row.envelope_json !== "string") throw unavailable();
    try {
      const envelope = JSON.parse(row.envelope_json) as ControlPlaneEnvelopeV1;
      const document = decryptControlPlaneEnvelope(envelope, keyring.keys);
      if (document.revision !== Number(row.revision)) throw unavailable();
      return cloneControlPlaneDocument(document);
    } catch (error) {
      if (isControlStoreError(error)) throw error;
      throw unavailable();
    }
  }

  function initializeWithinTransaction(document: ControlPlaneDocumentV2): void {
    try {
      if (connection.prepare(
        "SELECT 1 AS present FROM control_state WHERE singleton = 1",
      ).get()) throw conflict();
      if (document.revision !== 1) throw invalid();
      const initial = parseControlPlaneDocument(document);
      const envelope = encryptControlPlaneDocument(initial, keyring);
      const result = connection.prepare(
        `INSERT INTO control_state
          (singleton, revision, envelope_json, updated_at)
         VALUES (1, ?, ?, ?)`,
      ).run(initial.revision, JSON.stringify(envelope), initial.updatedAt);
      if (Number(result.changes) !== 1) throw conflict();
      emit("control_plane_sqlite_write", initial);
    } catch (error) {
      throw normalizeControlStoreError(error, "initialize");
    }
  }

  async function initialize(document: ControlPlaneDocumentV2): Promise<void> {
    connection.exec("BEGIN IMMEDIATE");
    try {
      initializeWithinTransaction(document);
      connection.exec("COMMIT");
    } catch (error) {
      rollback(connection);
      throw normalizeControlStoreError(error, "initialize");
    }
  }

  async function isConfigured(): Promise<boolean> {
    const row = connection.prepare(
      "SELECT 1 AS configured FROM control_state WHERE singleton = 1",
    ).get();
    return row !== undefined;
  }

  async function load(): Promise<LoadedControlPlaneSnapshot> {
    const document = readAndDecrypt();
    emit("control_plane_sqlite_read", document);
    return {
      document,
      etag: `sqlite:${document.revision}`,
    };
  }

  async function mutate<T>(
    name: string,
    reducer: ControlMutationReducer<T>,
  ): Promise<T> {
    void name;
    connection.exec("BEGIN IMMEDIATE");
    try {
      const current = readAndDecrypt();
      const mutation = reducer(cloneControlPlaneDocument(current));
      if (!mutation.changed) {
        connection.exec("COMMIT");
        return mutation.result;
      }
      if (mutation.next.revision !== current.revision + 1) throw invalid();
      const next = parseControlPlaneDocument({
        ...mutation.next,
        updatedAt: now().toISOString(),
      });
      const envelope = encryptControlPlaneDocument(next, keyring);
      const changed = connection.prepare(
        `UPDATE control_state
            SET revision = ?, envelope_json = ?, updated_at = ?
          WHERE singleton = 1 AND revision = ?`,
      ).run(
        next.revision,
        JSON.stringify(envelope),
        next.updatedAt,
        current.revision,
      ).changes;
      if (Number(changed) !== 1) throw conflict();
      connection.exec("COMMIT");
      emit("control_plane_sqlite_write", next);
      return mutation.result;
    } catch (error) {
      rollback(connection);
      throw normalizeControlStoreError(error);
    }
  }

  return {
    isConfigured,
    initialize,
    initializeWithinTransaction,
    load,
    mutate,
    withTelemetry: (observer, activeRequestId, operation) =>
      telemetry.run({ observer, requestId: activeRequestId }, operation),
  };
}

function unavailable(): ControlPlaneStoreError {
  return new ControlPlaneStoreError("CONTROL_PLANE_UNAVAILABLE");
}

function conflict(): ControlPlaneStoreError {
  return new ControlPlaneStoreError("CONTROL_PLANE_CONFLICT");
}

function invalid(): ControlPlaneStoreError {
  return new ControlPlaneStoreError("CONTROL_PLANE_INVALID");
}

function normalizeControlStoreError(
  error: unknown,
  operation: "initialize" | "mutate" = "mutate",
): Error {
  if (isControlStoreError(error)) return error;
  if (isSqliteConstraint(error) && operation === "initialize") return conflict();
  if (isValidationError(error)) return invalid();
  return unavailable();
}

function isControlStoreError(error: unknown): error is ControlPlaneStoreError {
  return error instanceof ControlPlaneStoreError;
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === "ControlPlaneDocumentError" ||
    error.name === "ControlPlaneEnvelopeError" ||
    error.message === "CONTROL_PLANE_INVALID" ||
    error.message === "CONTROL_PLANE_LIMIT_EXCEEDED"
  );
}

function isSqliteConstraint(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    typeof error.code === "string" && error.code.startsWith("ERR_SQLITE_CONSTRAINT");
}

function rollback(connection: DatabaseSync): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // Preserve the operation failure.
  }
}
