export interface SqliteMigration {
  version: number;
  sql: string;
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE installation (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        household_id TEXT NOT NULL UNIQUE,
        setup_code_hash TEXT,
        configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
        created_at TEXT NOT NULL,
        claimed_at TEXT
      );

      CREATE TABLE control_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE oauth_replay (
        replay_key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
];

export function validateSqliteMigrations(
  migrations: readonly SqliteMigration[],
): readonly SqliteMigration[] {
  if (migrations.length === 0) throw new Error("SQLITE_MIGRATIONS_INVALID");
  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  for (let index = 0; index < sorted.length; index += 1) {
    const migration = sorted[index]!;
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== index + 1 ||
      typeof migration.sql !== "string"
    ) {
      throw new Error("SQLITE_MIGRATIONS_INVALID");
    }
  }
  return sorted;
}
