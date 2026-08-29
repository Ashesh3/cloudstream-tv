import type { DatabaseSync } from "node:sqlite";
import type { ControlOAuthReplayCache } from "../services/control-oauth.ts";

export function createSqliteOAuthReplayCache(
  database: DatabaseSync,
  now: () => Date = () => new Date(),
): ControlOAuthReplayCache {
  const select = database.prepare(
    "SELECT owner FROM oauth_replay WHERE replay_key = ? AND expires_at > ?",
  );
  const upsert = database.prepare(`
    INSERT INTO oauth_replay(replay_key, owner, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(replay_key) DO UPDATE SET
      owner = excluded.owner,
      expires_at = excluded.expires_at
  `);
  const deleteExpired = database.prepare(
    "DELETE FROM oauth_replay WHERE expires_at <= ?",
  );

  return {
    async get(key) {
      const currentTime = validTime(now());
      deleteExpired.run(currentTime);
      const row = select.get(key, currentTime) as { owner?: unknown } | undefined;
      return typeof row?.owner === "string" ? row.owner : null;
    },
    async set(key, value, options) {
      if (typeof value !== "string" || value.length === 0) {
        throw new Error("OAUTH_REPLAY_VALUE_INVALID");
      }
      const ttl = options?.ttl;
      if (!Number.isSafeInteger(ttl) || (ttl as number) <= 0) {
        throw new Error("OAUTH_REPLAY_TTL_INVALID");
      }
      const currentTime = validTime(now());
      deleteExpired.run(currentTime);
      upsert.run(key, value, currentTime + (ttl as number) * 1_000);
    },
  };
}

function validTime(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("OAUTH_REPLAY_CLOCK_INVALID");
  return milliseconds;
}
