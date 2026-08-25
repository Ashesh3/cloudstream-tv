import { put, get, del, list } from "@vercel/blob";
import { v4 as uuidv4 } from "uuid";
import { KV_KEYS, PAIRING_CODE_EXPIRY_MS } from "../constants";
import { buildPairingSession } from "./pairing";
import {
  joinConnectionRecords,
  splitConnectionRecords,
  type ConnectionMetadataRecord,
  type ConnectionTokenRecord,
} from "./connection-records";
import type { CloudConnection, WatchHistory, PairingSession } from "@/types";

interface StoredSession {
  createdAt: number;
}

interface ConnectionTombstone {
  deletedAt: number;
}

/**
 * Storage layer backed by Vercel Blob.
 *
 * Auth resolves automatically:
 *   - On Vercel (prod/preview): secretless via VERCEL_OIDC_TOKEN + BLOB_STORE_ID.
 *   - Locally / migration: BLOB_READ_WRITE_TOKEN.
 *
 * All blobs are `private` (they hold OAuth tokens) and are read with
 * `useCache: false` so a read always reflects the most recent write
 * (read-after-write consistency, which token refresh relies on).
 *
 * There is no native TTL in Blob. The only TTL user (pairing sessions) is
 * handled at the application level via an `expiresAt` check in
 * getPairingSession(), so behaviour is unchanged.
 */

/**
 * Map a logical KV key (e.g. "watch-history:sid:fileId") to a Blob pathname.
 * Each colon-separated segment is encoded and joined with "/", producing a
 * stable, collision-free, human-readable path like
 * "kv/watch-history/<sid>/<fileId>.json".
 */
function keyToPath(key: string): string {
  return "kv/" + key.split(":").map(encodeURIComponent).join("/") + ".json";
}

function keyPrefixToPath(key: string): string {
  return "kv/" + key.split(":").map(encodeURIComponent).join("/") + "/";
}

async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const res = await get(keyToPath(key), { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) return null;
    const text = await new Response(res.stream).text();
    return JSON.parse(text) as T;
  } catch {
    // Not found (or unreadable) behaves like a missing key.
    return null;
  }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  await put(keyToPath(key), JSON.stringify(value), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    // Minimum allowed is 60s; irrelevant to correctness because every read
    // uses `useCache: false` and hits origin directly.
    cacheControlMaxAge: 60,
  });
}

async function kvDel(key: string): Promise<void> {
  // del() is idempotent — deleting a missing pathname is a no-op.
  await del(keyToPath(key));
}

/**
 * Get all cloud connections for a session.
 */
export async function getConnections(
  sessionId: string
): Promise<CloudConnection[]> {
  const legacyConnections =
    (await kvGet<CloudConnection[]>(KV_KEYS.connections(sessionId))) ?? [];
  const connectionIds = new Set(
    legacyConnections.map((connection) => connection.id)
  );

  for (const connectionId of await listConnectionIds(sessionId)) {
    connectionIds.add(connectionId);
  }

  const legacyById = new Map(
    legacyConnections.map((connection) => [connection.id, connection])
  );

  const resolved = await Promise.all(
    Array.from(connectionIds).map(async (connectionId) => {
      const [metadata, tokens, tombstone] = await Promise.all([
        kvGet<ConnectionMetadataRecord>(
          KV_KEYS.connectionMetadata(sessionId, connectionId)
        ),
        kvGet<ConnectionTokenRecord>(
          KV_KEYS.connectionTokens(sessionId, connectionId)
        ),
        kvGet<ConnectionTombstone>(
          KV_KEYS.connectionTombstone(sessionId, connectionId)
        ),
      ]);

      if (tombstone) return null;

      const legacy = legacyById.get(connectionId);
      const effectiveTokens =
        tokens ??
        (legacy
          ? {
              accessToken: legacy.accessToken,
              refreshToken: legacy.refreshToken,
              tokenExpiry: legacy.tokenExpiry,
            }
          : null);

      if (metadata && effectiveTokens) {
        return joinConnectionRecords(metadata, effectiveTokens);
      }
      if (legacy) {
        return tokens ? { ...legacy, ...tokens } : legacy;
      }
      return null;
    })
  );

  return resolved.filter(
    (connection): connection is CloudConnection => connection !== null
  );
}

/**
 * Save (upsert) a cloud connection for a session.
 */
export async function saveConnection(
  sessionId: string,
  connection: CloudConnection
): Promise<void> {
  const tombstone = await kvGet<ConnectionTombstone>(
    KV_KEYS.connectionTombstone(sessionId, connection.id)
  );
  if (tombstone) {
    throw new Error("Cannot save a removed cloud connection");
  }

  const [metadata, legacyConnections, tokens] = await Promise.all([
    kvGet<ConnectionMetadataRecord>(
      KV_KEYS.connectionMetadata(sessionId, connection.id)
    ),
    kvGet<CloudConnection[]>(KV_KEYS.connections(sessionId)),
    kvGet<ConnectionTokenRecord>(
      KV_KEYS.connectionTokens(sessionId, connection.id)
    ),
  ]);
  const legacy = legacyConnections?.find(
    (candidate) => candidate.id === connection.id
  );
  const records = splitConnectionRecords(
    connection,
    metadata?.createdAt ?? Date.now()
  );

  if (!tokens && !legacy) {
    await kvSet(
      KV_KEYS.connectionTokens(sessionId, connection.id),
      records.tokens
    );
  }
  await kvSet(
    KV_KEYS.connectionMetadata(sessionId, connection.id),
    records.metadata
  );
}

/**
 * Remove a cloud connection by id from a session.
 */
export async function removeConnection(
  sessionId: string,
  connectionId: string
): Promise<void> {
  await kvSet(KV_KEYS.connectionTombstone(sessionId, connectionId), {
    deletedAt: Date.now(),
  });
  await Promise.all([
    kvDel(KV_KEYS.connectionMetadata(sessionId, connectionId)),
    kvDel(KV_KEYS.connectionTokens(sessionId, connectionId)),
  ]);
}

/**
 * Update the access token and expiry for a specific connection.
 */
export async function updateTokens(
  sessionId: string,
  connectionId: string,
  accessToken: string,
  tokenExpiry: number
): Promise<void> {
  const tombstone = await kvGet<ConnectionTombstone>(
    KV_KEYS.connectionTombstone(sessionId, connectionId)
  );
  if (tombstone) return;

  const [tokens, legacyConnections] = await Promise.all([
    kvGet<ConnectionTokenRecord>(
      KV_KEYS.connectionTokens(sessionId, connectionId)
    ),
    kvGet<CloudConnection[]>(KV_KEYS.connections(sessionId)),
  ]);
  const legacy = legacyConnections?.find(
    (connection) => connection.id === connectionId
  );
  const refreshToken = tokens?.refreshToken ?? legacy?.refreshToken;
  if (!refreshToken) return;

  await kvSet(KV_KEYS.connectionTokens(sessionId, connectionId), {
    accessToken,
    refreshToken,
    tokenExpiry,
  } satisfies ConnectionTokenRecord);
}

/**
 * Get watch history for a specific file in a session.
 */
export async function getWatchHistory(
  sessionId: string,
  fileId: string
): Promise<WatchHistory | null> {
  return kvGet<WatchHistory>(KV_KEYS.watchHistory(sessionId, fileId));
}

/**
 * Save watch history for a file.
 */
export async function saveWatchHistory(
  sessionId: string,
  history: WatchHistory
): Promise<void> {
  await kvSet(KV_KEYS.watchHistory(sessionId, history.fileId), history);
}

/**
 * Generate a random pairing code in the format TV-XXXXXX (uppercase alphanumeric).
 */
function generatePairingCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "TV-";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Create a new pairing session with a generated code and session id.
 */
export async function createPairingSession(
  existingSessionId: string | null = null
): Promise<PairingSession> {
  const code = generatePairingCode();
  const now = Date.now();
  const session: PairingSession = {
    ...buildPairingSession({
      code,
      existingSessionId,
      generatedSessionId: uuidv4(),
      pollToken: uuidv4(),
      now,
      expiryMs: PAIRING_CODE_EXPIRY_MS,
    }),
    mode: existingSessionId ? "manage" : "setup",
  };

  await kvSet(KV_KEYS.pairing(code), session);
  if (existingSessionId) {
    await ensureSession(session.sessionId);
  }

  return session;
}

async function listConnectionIds(sessionId: string): Promise<string[]> {
  const prefix = keyPrefixToPath(KV_KEYS.connectionMetadataPrefix(sessionId));
  const ids: string[] = [];
  let cursor: string | undefined;

  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    for (const blob of result.blobs) {
      const filename = blob.pathname.slice(prefix.length);
      if (filename.endsWith(".json")) {
        ids.push(decodeURIComponent(filename.slice(0, -5)));
      }
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return ids;
}

export async function ensureSession(sessionId: string): Promise<void> {
  const existing = await kvGet<StoredSession>(KV_KEYS.session(sessionId));
  if (existing) return;

  await kvSet(KV_KEYS.session(sessionId), { createdAt: Date.now() });
}

export async function hasSession(sessionId: string): Promise<boolean> {
  return Boolean(await kvGet<StoredSession>(KV_KEYS.session(sessionId)));
}

export async function completePairingSession(code: string): Promise<boolean> {
  const session = await getPairingSession(code);
  if (!session) return false;

  session.completedAt = Date.now();
  await kvSet(KV_KEYS.pairing(code), session);
  await ensureSession(session.sessionId);
  return true;
}

/**
 * Get a pairing session by code. Returns null if not found or expired.
 * Expiry is enforced here (Blob has no native TTL): an expired session is
 * deleted and treated as absent.
 */
export async function getPairingSession(
  code: string
): Promise<PairingSession | null> {
  const session = await kvGet<PairingSession>(KV_KEYS.pairing(code));

  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    await kvDel(KV_KEYS.pairing(code));
    return null;
  }

  return session;
}

/**
 * Delete a pairing session by code.
 */
export async function deletePairingSession(code: string): Promise<void> {
  await kvDel(KV_KEYS.pairing(code));
}
