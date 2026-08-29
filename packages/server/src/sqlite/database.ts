import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import {
  SQLITE_MIGRATIONS,
  validateSqliteMigrations,
  type SqliteMigration,
} from "./migrations.ts";

const AUTOMATIC_BACKUP_LIMIT = 5;

export type { SqliteMigration } from "./migrations.ts";
export { SQLITE_MIGRATIONS } from "./migrations.ts";

export interface OpenLocalDatabaseOptions {
  dataDir: string;
  now?: () => Date;
  migrations?: readonly SqliteMigration[];
}

export interface LocalDatabase {
  connection: DatabaseSync;
  dataDir: string;
  databasePath: string;
  transcodeDir: string;
  stagingDir: string;
  backupDir: string;
  checkpoint(): void;
  close(): void;
}

export async function openLocalDatabase(
  options: OpenLocalDatabaseOptions,
): Promise<LocalDatabase> {
  const now = options.now ?? (() => new Date());
  const migrations = validateSqliteMigrations(options.migrations ?? SQLITE_MIGRATIONS);
  const dataDir = options.dataDir;
  const databasePath = join(dataDir, "cloudframe.sqlite");
  const transcodeDir = join(dataDir, "transcodes");
  const stagingDir = join(dataDir, "staging");
  const backupDir = join(dataDir, "backups");

  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(transcodeDir, { recursive: true }),
    mkdir(stagingDir, { recursive: true }),
    mkdir(backupDir, { recursive: true }),
  ]);

  const connection = new DatabaseSync(databasePath);
  try {
    configure(connection);
    await applyPendingMigrations({
      connection,
      databasePath,
      backupDir,
      migrations,
      now,
    });
  } catch (error) {
    connection.close();
    throw error;
  }

  let closed = false;
  return {
    connection,
    dataDir,
    databasePath,
    transcodeDir,
    stagingDir,
    backupDir,
    checkpoint() {
      if (!closed) checkpoint(connection);
    },
    close() {
      if (closed) return;
      checkpoint(connection);
      connection.close();
      closed = true;
    },
  };
}

function configure(connection: DatabaseSync): void {
  connection.exec("PRAGMA journal_mode = WAL");
  connection.exec("PRAGMA foreign_keys = ON");
  connection.exec("PRAGMA busy_timeout = 5000");
  connection.exec("PRAGMA synchronous = FULL");
}

function checkpoint(connection: DatabaseSync): void {
  connection.exec("PRAGMA wal_checkpoint(FULL)");
}

interface MigrationContext {
  connection: DatabaseSync;
  databasePath: string;
  backupDir: string;
  migrations: readonly SqliteMigration[];
  now: () => Date;
}

async function applyPendingMigrations(context: MigrationContext): Promise<void> {
  const currentVersion = readCurrentVersion(context.connection);
  const newestVersion = context.migrations.at(-1)!.version;
  if (currentVersion > newestVersion) throw new Error("SQLITE_SCHEMA_TOO_NEW");

  const pending = context.migrations.filter((migration) => migration.version > currentVersion);
  if (pending.length === 0) return;

  if (currentVersion > 0) {
    await createAutomaticBackup(context, currentVersion);
  }

  for (const migration of pending) {
    context.connection.exec("BEGIN IMMEDIATE");
    try {
      if (migration.sql.trim()) context.connection.exec(migration.sql);
      context.connection.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, context.now().toISOString());
      context.connection.exec("COMMIT");
    } catch (error) {
      rollback(context.connection);
      throw error;
    }
  }
}

function readCurrentVersion(connection: DatabaseSync): number {
  const table = connection.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
  ).get();
  if (!table) return 0;
  const row = connection.prepare(
    "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
  ).get() as { version?: number | bigint } | undefined;
  const version = Number(row?.version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("SQLITE_SCHEMA_INVALID");
  }
  return version;
}

async function createAutomaticBackup(
  context: MigrationContext,
  currentVersion: number,
): Promise<void> {
  checkpoint(context.connection);
  const stamp = context.now().toISOString().replaceAll("-", "").replaceAll(":", "");
  const backupPath = join(
    context.backupDir,
    `auto-${stamp}-v${currentVersion}.sqlite`,
  );
  await backup(context.connection, backupPath);
  verifyBackup(backupPath, currentVersion);
  await retainNewestAutomaticBackups(context.backupDir);
}

function verifyBackup(path: string, expectedVersion: number): void {
  const verification = new DatabaseSync(path, { readOnly: true });
  try {
    if (readCurrentVersion(verification) !== expectedVersion) {
      throw new Error("SQLITE_BACKUP_INVALID");
    }
  } finally {
    verification.close();
  }
}

async function retainNewestAutomaticBackups(backupDir: string): Promise<void> {
  const automatic = (await readdir(backupDir))
    .filter((name) => name.startsWith("auto-") && name.endsWith(".sqlite"))
    .sort();
  const remove = automatic.slice(0, Math.max(0, automatic.length - AUTOMATIC_BACKUP_LIMIT));
  await Promise.all(remove.map((name) => unlink(join(backupDir, name))));
}

function rollback(connection: DatabaseSync): void {
  try {
    connection.exec("ROLLBACK");
  } catch {
    // Preserve the original migration failure.
  }
}
