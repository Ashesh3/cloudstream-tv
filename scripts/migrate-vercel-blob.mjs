import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fixturePath = valueAfter("--fixture");
const householdId = required("HOUSEHOLD_ID");
const keyVersion = process.env.PROVIDER_TOKEN_KEY_VERSION ?? "v1";
const key = Buffer.from(required(`PROVIDER_TOKEN_KEY_${keyVersion.toUpperCase()}`), "base64url");
if (key.length !== 32) throw new Error("Provider token key must decode to 32 bytes");

const legacy = fixturePath
  ? JSON.parse(await readFile(fixturePath, "utf8"))
  : await readLegacyBlobRecords();
const sources = buildMigrationPlan(legacy);

if (apply) {
  const firestore = createFirestore();
  for (const source of sources) {
    await firestore.collection("sources").doc(source.id).set(source, { merge: true });
    for (const root of source.roots) {
      await firestore.collection("roots").doc(root.id).set(root, { merge: true });
    }
  }
}

process.stdout.write(`${JSON.stringify({
  apply,
  sourceCount: sources.length,
  sources: sources.map(({ id, provider, accountLabel, status, roots }) => ({
    id, provider, accountLabel, status, rootCount: roots.length
  }))
})}\n`);

function buildMigrationPlan(input) {
  const results = [];
  const seen = new Set();
  for (const [sessionId, session] of Object.entries(input.sessions ?? {})) {
    const tombstones = session.tombstones ?? {};
    const aggregate = new Map((session.aggregate ?? []).map(connection => [connection.id, connection]));
    const ids = new Set([...aggregate.keys(), ...Object.keys(session.split ?? {})]);
    for (const connectionId of ids) {
      if (tombstones[connectionId]) continue;
      const legacyConnection = aggregate.get(connectionId);
      const split = session.split?.[connectionId];
      const metadata = split?.metadata ?? legacyConnection;
      const tokens = split?.tokens ?? legacyConnection;
      if (!metadata || !tokens) continue;
      const provider = normalizeProvider(metadata.provider);
      const identity = `${provider}:${String(metadata.email ?? "").toLowerCase()}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const id = `source_${digest(`${sessionId}\0${connectionId}\0${provider}`)}`;
      const refreshToken = String(tokens.refreshToken ?? "");
      const encryptedRefreshToken = encrypt(refreshToken || "reauth-required");
      const now = new Date();
      const roots = (metadata.folders ?? []).map(folder => ({
        id: `root_${digest(`${id}\0${folder.id}`)}`,
        householdId,
        sourceId: id,
        providerNodeId: String(folder.id),
        displayName: String(folder.name ?? "Imported folder"),
        ancestryProviderIds: [],
        enabled: false,
        createdAt: now
      }));
      results.push({
        id,
        householdId,
        provider,
        // Legacy records do not prove a stable provider account identity.
        providerAccountId: null,
        accountLabel: String(metadata.email ?? "Reconnect required"),
        encryptedRefreshToken,
        encryptedAccessToken: null,
        accessTokenExpiresAt: null,
        status: "reauth-required",
        deltaCursor: null,
        crawlCheckpoint: null,
        activeWorkflowRunId: null,
        syncGeneration: null,
        nextSyncAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastSyncStartedAt: null,
        lastSyncCompletedAt: null,
        lastSyncErrorCode: refreshToken ? "MIGRATION_RECONNECT_REQUIRED" : "MIGRATION_TOKEN_MISSING",
        createdAt: new Date(Number(metadata.createdAt ?? Date.now())),
        roots
      });
    }
  }
  return results;
}

function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    keyVersion,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
}

async function readLegacyBlobRecords() {
  let blob;
  try {
    blob = await import("@vercel/blob");
  } catch {
    throw new Error("Live legacy migration requires the optional @vercel/blob package");
  }
  const sessions = {};
  let cursor;
  do {
    const page = await blob.list({ prefix: "kv/", cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const parsed = parsePath(blob.pathname);
      if (!parsed) continue;
      const response = await blob.get(blob.pathname, { access: "private", useCache: false });
      if (!response || response.statusCode !== 200) continue;
      const value = JSON.parse(await new Response(response.stream).text());
      const session = sessions[parsed.sessionId] ??= { aggregate: [], split: {}, tombstones: {} };
      if (parsed.kind === "aggregate") session.aggregate = value;
      else if (parsed.kind === "metadata") (session.split[parsed.connectionId] ??= {}).metadata = value;
      else if (parsed.kind === "tokens") (session.split[parsed.connectionId] ??= {}).tokens = value;
      else session.tombstones[parsed.connectionId] = value;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { sessions };
}

function parsePath(pathname) {
  let match = /^kv\/connections\/([^/]+)\.json$/.exec(pathname);
  if (match) return { kind: "aggregate", sessionId: decodeURIComponent(match[1]) };
  match = /^kv\/(connection-metadata|connection-tokens|connection-tombstone)\/([^/]+)\/([^/]+)\.json$/.exec(pathname);
  if (!match) return null;
  return {
    kind: match[1] === "connection-metadata" ? "metadata" : match[1] === "connection-tokens" ? "tokens" : "tombstone",
    sessionId: decodeURIComponent(match[2]),
    connectionId: decodeURIComponent(match[3])
  };
}

function createFirestore() {
  return new Firestore({
    projectId: required("FIRESTORE_PROJECT_ID"),
    databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)"
  });
}

function normalizeProvider(value) {
  if (value === "google" || value === "google-drive") return "google";
  if (value === "onedrive" || value === "one-drive") return "onedrive";
  throw new Error("Unsupported legacy provider");
}

function digest(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
