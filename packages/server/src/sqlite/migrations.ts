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
  {
    version: 2,
    sql: `
      CREATE TABLE transcode_assets (
        cache_key TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        segment_count INTEGER NOT NULL,
        probe_json TEXT NOT NULL,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL
      );
      CREATE TABLE transcode_windows (
        cache_key TEXT NOT NULL REFERENCES transcode_assets(cache_key) ON DELETE CASCADE,
        window_index INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('partial', 'complete')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (cache_key, window_index)
      );
      CREATE TABLE transcode_segments (
        cache_key TEXT NOT NULL REFERENCES transcode_assets(cache_key) ON DELETE CASCADE,
        segment_index INTEGER NOT NULL,
        window_index INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        PRIMARY KEY (cache_key, segment_index)
      );
      CREATE INDEX transcode_assets_lru ON transcode_assets(last_accessed_at);
      CREATE INDEX transcode_segments_lru ON transcode_segments(last_accessed_at);
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
