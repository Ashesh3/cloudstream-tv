# Self-Hosted Cloudframe Transcoding Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active Vercel deployment with a portable single-container Cloudframe server that persists fresh local state, uses the real Video.js 10 beta interface, and demand-transcodes incompatible video to seekable HLS for one active television.

**Architecture:** A Node.js 24 process serves both SPAs and the Web API, stores its encrypted control document plus transcode metadata in SQLite under `/data`, and coordinates one FFprobe/FFmpeg process. Compatible media keeps direct provider delivery; incompatible media is read through a loopback-only authenticated gateway and encoded into demand-paged H.264/AAC HLS windows cached under `/data/transcodes`.

**Tech Stack:** TypeScript 5.9, Node.js 24 built-in SQLite, Preact 10, React 19, Video.js HTML `10.0.0-beta.32`, hls.js `1.7.1`, FFmpeg/FFprobe, Vitest, Playwright, esbuild, Docker.

**Spec:** `docs/superpowers/specs/2026-08-29-self-hosted-transcoding-server-design.md`

## Global Constraints

- Produce a portable image; do not add Horizon, Nginx, Cloudflare, certificate, DNS, registry, or host-specific configuration.
- Optimize for exactly one active transcoding television and exactly one FFmpeg process globally.
- Keep Google Drive and OneDrive OAuth read-only; never upload, replace, rename, or delete provider files.
- Keep compatible media on the direct provider path; send only incompatible or explicitly retried video through HLS.
- Pin `@videojs/html` to `10.0.0-beta.32` and add hls.js as a direct exact dependency at `1.7.1`.
- Preserve the underlying native `HTMLVideoElement`, existing remote keys, local watch history, resume, navigation, thumbnails, and Google bearer service-worker path.
- Retain Chromium 68 native fallback behavior even though Video.js 10 targets evergreen browsers.
- Persist all installation state, the master key, SQLite, transcode cache, staging, and backups under `/data` only.
- Run the container as an unprivileged user with one public port, default `8080`; TLS and reverse proxying remain external.
- Do not import the existing Vercel control plane. A new `/data` volume starts fresh.
- Do not delete or mutate any external Vercel, Firebase, DNS, or hosting resource.
- Never log or return OAuth tokens, provider-signed URLs, cookies, internal source capabilities, decrypted control documents, raw FFmpeg command URLs, or media bodies.
- Spawn FFmpeg and FFprobe with argument arrays and `shell: false`.
- Every implementation task follows red-green TDD and ends with a focused commit.

---

## File and Responsibility Map

### Portable runtime and storage

- `packages/server/src/runtime/self-hosted-config.ts` — parse and validate portable environment configuration and byte-size settings.
- `packages/server/src/runtime/local-keys.ts` — atomically create `/data/secrets/master.key` and derive domain-separated application keys.
- `packages/server/src/runtime/local-cache.ts` — bounded in-memory TTL caches for provider access tokens and process-local state.
- `packages/server/src/runtime/deferred-tasks.ts` — track background promises and drain them during shutdown.
- `packages/server/src/sqlite/database.ts` — open SQLite, apply pragmas, run migrations, checkpoint, back up, and close.
- `packages/server/src/sqlite/migrations.ts` — ordered schema migrations for installation, control state, OAuth replay, and transcode catalog tables.
- `packages/server/src/sqlite/control-store.ts` — encrypted revisioned `ControlPlaneStore` implementation plus one-time initialization.
- `packages/server/src/sqlite/installation-repository.ts` — setup-code digest, configured state, and atomic first claim.
- `packages/server/src/sqlite/oauth-replay-cache.ts` — persistent expiring OAuth callback replay markers.

### First run and self-hosted HTTP

- `packages/server/src/services/installation.ts` — generate, validate, and claim the one-time setup code.
- `packages/server/src/http/installation-app.ts` — `GET /api/setup/status` and `POST /api/setup/claim`.
- `packages/server/src/http/node-adapter.ts` — bridge Node `IncomingMessage`/`ServerResponse` with Web `Request`/`Response`.
- `packages/server/src/http/static-app.ts` — safe static file and SPA fallback serving.
- `packages/server/src/http/self-hosted-app.ts` — order health, setup, transcode, control API, static, and SPA routes.
- `packages/server/src/runtime/readiness.ts` — immutable startup checks and draining state.
- `deploy/server-entry.ts` — compose local storage, providers, APIs, transcode services, listeners, and shutdown.
- `scripts/build-server.mjs` — bundle the self-hosted entry and copy production static/native artifacts.

### Provider and transcode core

- `packages/server/src/services/provider-media-source.ts` — authorize one browse item and vend a validated provider request with one refresh.
- `packages/server/src/transcode/types.ts` — source binding, probe, asset, window, segment, session, and diagnostic contracts.
- `packages/server/src/transcode/profile.ts` — the single `h264-aac-1080p-v1` profile and deterministic cache identity.
- `packages/server/src/transcode/catalog.ts` — SQLite probe/window/segment metadata and LRU candidate queries.
- `packages/server/src/transcode/cache.ts` — hashed paths, staging reconciliation, segment validation/promotion, free-space reserve, and eviction.
- `packages/server/src/transcode/source-authorizer.ts` — reload control state and validate device/root/source/revision bindings.
- `packages/server/src/transcode/source-gateway.ts` — loopback-only capability server with safe range forwarding.
- `packages/server/src/transcode/process-runner.ts` — cancellable child process groups and bounded redacted stderr.
- `packages/server/src/transcode/probe.ts` — strict FFprobe invocation and JSON decoding.
- `packages/server/src/transcode/manifests.ts` — complete VOD master/media HLS playlist generation.
- `packages/server/src/transcode/window-encoder.ts` — encode and atomically publish one five-segment window.
- `packages/server/src/transcode/coordinator.ts` — one-TV lease, one-process scheduling, demanded-window priority, prefetch, cancellation, and diagnostics.
- `packages/server/src/http/transcode-app.ts` — authenticated HLS manifest, segment, heartbeat, release, and admin-diagnostic routes.

### Shared contracts and clients

- `packages/shared/src/api.ts` — first-run, local-storage status, HLS descriptor, and transcode-diagnostic DTOs.
- `packages/providers/src/types.ts` — carry a provider content revision separately from thumbnail presentation state.
- `packages/server/src/auth/browse-handles.ts` — seal content revision and size into item authorization claims.
- `packages/server/src/services/live-browse.ts` — preserve provider revision/size through browse handles and DTOs.
- `packages/server/src/services/direct-media.ts` — choose direct versus HLS and encode the new response union.
- `packages/server/src/http/control-app.ts` — accept an explicit one-time HLS fallback request.

### TV and admin interfaces

- `apps/tv/src/media/hls-playback.ts` — select native HLS or hls.js and own engine cleanup.
- `apps/tv/src/videojs.ts` — register the packaged Video.js video skin.
- `apps/tv/src/components/video-player.tsx` — render `video-player > video-skin > video`, native fallback controls, and HLS attachment.
- `packages/tv-core/src/viewer.ts` — represent direct/HLS source state and bounded fallback/error kinds.
- `apps/tv/src/components/viewer.tsx` — autoplay attempt, decoder-to-HLS retry, heartbeat/release, history, and user-facing failures.
- `apps/admin/src/components/first-run.tsx` — claim an empty installation.
- `apps/admin/src/components/transcode-diagnostics.tsx` — protected current-job/cache diagnostics.
- `apps/admin/src/api/client.ts` and `apps/tv/src/api/client.ts` — strict decoders and new endpoints.

### Delivery and acceptance

- `Dockerfile` — Node 24 build stage and unprivileged FFmpeg runtime stage under `tini`.
- `.dockerignore` — exclude local state, secrets, caches, outputs, and unrelated workspaces.
- `compose.example.yaml` — portable localhost-bound example with `/data` volume.
- `scripts/container-smoke.mjs` — fresh claim, persistence, health/readiness, MPEG HLS, restart, and shutdown checks.
- `tests/fixtures/media/legacy-mpeg.mpg` — deterministic short MPEG-2/MP2 integration fixture.
- `docs/operations/self-hosting.md` — configuration, reverse-proxy contract, backups, upgrades, cache, and recovery.
- `docs/operations/webos-acceptance.md` — direct MP4 and transcoded MPG real-TV checklist.

---

### Task 1: Parse Portable Configuration and Derive Local Keys

**Files:**
- Create: `packages/server/src/runtime/self-hosted-config.ts`
- Create: `packages/server/src/runtime/local-keys.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/self-hosted-config.test.ts`
- Test: `tests/local-keys.test.ts`

**Interfaces:**
- Consumes: `ProviderKind`, `VersionedAeadKeyring`, and `ProviderTokenKeyring` from existing packages.
- Produces:
  - `parseSelfHostedConfig(environment: NodeJS.ProcessEnv): SelfHostedConfig`
  - `loadOrCreateMasterKey(dataDir: string): Promise<Buffer>`
  - `deriveLocalKeyMaterial(masterKey: Uint8Array): LocalKeyMaterial`

- [ ] **Step 1: Write failing configuration tests**

Create `tests/self-hosted-config.test.ts` with exact success and rejection cases:

```ts
import { describe, expect, it } from "vitest";
import { parseSelfHostedConfig } from "../packages/server/src/runtime/self-hosted-config";

describe("self-hosted configuration", () => {
  it("accepts one exact HTTPS origin and optional provider pairs", () => {
    expect(parseSelfHostedConfig({
      APP_ORIGIN: "https://tv.example.com",
      PORT: "8080",
      DATA_DIR: "/data",
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      TRANSCODE_CACHE_MAX_BYTES: "50GiB",
      TRANSCODE_CACHE_MIN_FREE_BYTES: "5GiB",
      TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS: "30"
    })).toMatchObject({
      appOrigin: "https://tv.example.com",
      port: 8080,
      dataDir: "/data",
      providers: { google: { clientId: "google-id", clientSecret: "google-secret" } },
      transcode: {
        cacheMaxBytes: 50 * 1024 ** 3,
        cacheMinFreeBytes: 5 * 1024 ** 3,
        firstSegmentTimeoutMs: 30_000
      }
    });
  });

  it.each([
    [{ APP_ORIGIN: "http://tv.example.com" }, "APP_ORIGIN_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com/path" }, "APP_ORIGIN_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com", GOOGLE_CLIENT_ID: "id" }, "GOOGLE_OAUTH_CONFIG_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com", ONEDRIVE_CLIENT_SECRET: "secret" }, "ONEDRIVE_OAUTH_CONFIG_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com", TRANSCODE_CACHE_MAX_BYTES: "4GiB", TRANSCODE_CACHE_MIN_FREE_BYTES: "5GiB" }, "TRANSCODE_CACHE_LIMIT_INVALID"]
  ])("rejects invalid deployment input %#", (environment, code) => {
    expect(() => parseSelfHostedConfig(environment)).toThrow(code);
  });
});
```

- [ ] **Step 2: Write failing master-key and HKDF tests**

Create `tests/local-keys.test.ts` using a temporary directory. Assert:

```ts
const first = await loadOrCreateMasterKey(directory);
const second = await loadOrCreateMasterKey(directory);
expect(first).toEqual(second);
expect(first).toHaveLength(32);

const keys = deriveLocalKeyMaterial(first);
expect(new Set([
  Buffer.from(keys.controlPlane.keys.local_v1).toString("hex"),
  Buffer.from(keys.providerTokens.keys.local_v1).toString("hex"),
  Buffer.from(keys.sessions.keys.local_v1).toString("hex"),
  Buffer.from(keys.browseHandles.keys.local_v1).toString("hex")
]).size).toBe(4);
expect(Buffer.from(keys.controlPlane.keys.local_v1)).not.toEqual(first);
expect(Buffer.byteLength(keys.csrfSecret, "utf8")).toBeGreaterThanOrEqual(32);
```

Also assert that an existing file with a non-32-byte body throws `MASTER_KEY_INVALID`, and on non-Windows platforms the generated file mode is `0o600`.

- [ ] **Step 3: Run the focused tests to verify RED**

Run:

```powershell
npm test -- --run tests/self-hosted-config.test.ts tests/local-keys.test.ts
```

Expected: FAIL because both runtime modules are missing.

- [ ] **Step 4: Implement strict configuration parsing**

Implement these public types in `self-hosted-config.ts`:

```ts
export interface SelfHostedConfig {
  appOrigin: string;
  port: number;
  dataDir: string;
  providers: {
    google?: { clientId: string; clientSecret: string };
    onedrive?: { clientId: string; clientSecret: string; tenant: string };
  };
  transcode: {
    cacheMaxBytes: number;
    cacheMinFreeBytes: number;
    firstSegmentTimeoutMs: number;
    threads: number | "auto";
  };
  logLevel: "debug" | "info" | "warn" | "error";
}
```

Parse byte strings only with `KiB`, `MiB`, or `GiB`; require safe positive integers; require `cacheMaxBytes > cacheMinFreeBytes`; default to `/data`, port `8080`, `50GiB`, `5GiB`, 30 seconds, `auto`, and `info`. Validate `APP_ORIGIN` with the same exact-origin rules as the current production composition.

- [ ] **Step 5: Implement atomic master-key creation and domain separation**

Use an atomic `open(path, "wx", 0o600)` at `/data/secrets/master.key`. If the file already exists, read it; never overwrite it. Derive each 32-byte key with SHA-256 HKDF and a distinct info label:

```ts
const VERSION = "local_v1";

function derive(master: Uint8Array, label: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(master),
    Buffer.from("cloudframe/self-hosted/v1", "utf8"),
    Buffer.from(label, "utf8"),
    32
  ));
}
```

Return:

```ts
export interface LocalKeyMaterial {
  controlPlane: VersionedAeadKeyring;
  providerTokens: ProviderTokenKeyring;
  sessions: VersionedAeadKeyring;
  browseHandles: VersionedAeadKeyring;
  browseIdSecret: string;
  rootIdSecret: string;
  csrfSecret: string;
  rateLimitSecret: string;
  passphrasePepper: string;
  setupCodePepper: string;
}
```

Encode string secrets as base64url. Derive `browseIdSecret` and `rootIdSecret` with different HKDF labels. Export the new modules from `packages/server/src/index.ts`, raise the root engine floor to `"node": ">=24.5.0"`, and run `npm install --package-lock-only` so root package metadata remains synchronized.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```powershell
npm test -- --run tests/self-hosted-config.test.ts tests/local-keys.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json packages/server/src/index.ts packages/server/src/runtime/self-hosted-config.ts packages/server/src/runtime/local-keys.ts tests/self-hosted-config.test.ts tests/local-keys.test.ts
git commit -m "Add portable runtime configuration"
```

---

### Task 2: Add SQLite Migrations and the Encrypted Local Control Store

**Files:**
- Create: `packages/server/src/sqlite/database.ts`
- Create: `packages/server/src/sqlite/migrations.ts`
- Create: `packages/server/src/sqlite/control-store.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/sqlite-database.test.ts`
- Test: `tests/sqlite-control-store.test.ts`

**Interfaces:**
- Consumes: `LocalKeyMaterial.controlPlane`, `ControlPlaneDocumentV2`, existing envelope encryption, parser, reducer, and `ControlPlaneStore`.
- Produces:
  - `openLocalDatabase(options: OpenLocalDatabaseOptions): Promise<LocalDatabase>`
  - `createSqliteControlPlaneStore(options: SqliteControlPlaneStoreOptions): SqliteControlPlaneStore`
  - `SqliteControlPlaneStore.isConfigured(): Promise<boolean>`
  - `SqliteControlPlaneStore.initialize(document: ControlPlaneDocumentV2): Promise<void>`
  - `SqliteControlPlaneStore.initializeWithinTransaction(document: ControlPlaneDocumentV2): void`

- [ ] **Step 1: Write failing database initialization and migration tests**

Create `tests/sqlite-database.test.ts`. Use a fresh temporary `/data` and assert:

```ts
const local = await openLocalDatabase({ dataDir, now: () => now });
expect(local.connection.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
expect(local.connection.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
expect(local.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
  .toEqual([{ version: 1 }]);
expect(existsSync(join(dataDir, "transcodes"))).toBe(true);
expect(existsSync(join(dataDir, "staging"))).toBe(true);
expect(existsSync(join(dataDir, "backups"))).toBe(true);
```

Seed a version-1 fixture database, inject a version-2 migration through a test-only migration list, and prove that a SQLite backup is created before the change and that only the newest five automatic backups remain.

- [ ] **Step 2: Write failing encrypted control-store tests**

Create `tests/sqlite-control-store.test.ts` with these cases:

```ts
expect(await store.isConfigured()).toBe(false);
await expect(store.load()).rejects.toThrow("CONTROL_PLANE_UNAVAILABLE");

await store.initialize(document);
expect((await store.load()).document).toEqual(document);
await expect(store.initialize(document)).rejects.toThrow("CONTROL_PLANE_CONFLICT");

const result = await store.mutate("settings", current => ({
  changed: true,
  next: {
    ...current,
    revision: current.revision + 1,
    household: { ...current.household, defaultSlideshowSeconds: 12 }
  },
  result: "updated"
}));
expect(result).toBe("updated");
expect((await store.load()).document.revision).toBe(2);
```

Inspect `control_state.envelope_json` directly and assert that it contains neither the passphrase hash nor provider token plaintext. Add rollback tests for an invalid revision increment and an invalid document.

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/sqlite-database.test.ts tests/sqlite-control-store.test.ts
```

Expected: FAIL because the SQLite modules are missing.

- [ ] **Step 4: Implement database opening, migrations, and backups**

`openLocalDatabase` must:

```ts
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
```

Open `/data/cloudframe.sqlite`, apply:

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = FULL;
```

Migration 1 creates:

```sql
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
```

Before any migration above the current version, checkpoint WAL, call `backup(connection, backupPath)`, verify that the backup opens and contains the current migration version, then apply the migration inside `BEGIN IMMEDIATE`. Sort automatic backup names and retain five.

- [ ] **Step 5: Implement the local `ControlPlaneStore`**

`createSqliteControlPlaneStore` reads and writes the existing encrypted `ControlPlaneEnvelopeV1` JSON. Its `mutate` method must use this transaction shape:

```ts
connection.exec("BEGIN IMMEDIATE");
try {
  const current = readAndDecrypt(connection, keyring);
  const mutation = reducer(cloneControlPlaneDocument(current));
  if (!mutation.changed) {
    connection.exec("COMMIT");
    return mutation.result;
  }
  if (mutation.next.revision !== current.revision + 1) throw invalid();
  const next = parseControlPlaneDocument({ ...mutation.next, updatedAt: now().toISOString() });
  const envelope = encryptControlPlaneDocument(next, keyring);
  const changed = connection.prepare(
    "UPDATE control_state SET revision = ?, envelope_json = ?, updated_at = ? WHERE singleton = 1 AND revision = ?"
  ).run(next.revision, JSON.stringify(envelope), next.updatedAt, current.revision).changes;
  if (changed !== 1) throw conflict();
  connection.exec("COMMIT");
  return mutation.result;
} catch (error) {
  connection.exec("ROLLBACK");
  throw normalizeControlStoreError(error);
}
```

`initializeWithinTransaction` validates revision `1`, encrypts the document, and inserts `control_state` exactly once without beginning or committing a transaction; it is used only by the installation repository while that repository owns `BEGIN IMMEDIATE`. Public `initialize` wraps the helper in its own transaction. Keep `withTelemetry` behavior by wrapping operations in `AsyncLocalStorage` and emitting local event names such as `control_plane_sqlite_read` and `control_plane_sqlite_write`.

- [ ] **Step 6: Run tests and typecheck**

```powershell
npm test -- --run tests/sqlite-database.test.ts tests/sqlite-control-store.test.ts tests/control-plane-schema.test.ts tests/control-mutations.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/server/src/index.ts packages/server/src/sqlite/database.ts packages/server/src/sqlite/migrations.ts packages/server/src/sqlite/control-store.ts tests/sqlite-database.test.ts tests/sqlite-control-store.test.ts
git commit -m "Store control state in SQLite"
```

---

### Task 3: Replace Vercel Runtime Caches with Local Implementations

**Files:**
- Create: `packages/server/src/runtime/local-cache.ts`
- Create: `packages/server/src/sqlite/oauth-replay-cache.ts`
- Modify: `packages/server/src/services/credential-broker.ts`
- Modify: `packages/server/src/services/control-oauth.ts`
- Modify: `packages/server/src/services/runtime-rate-limit.ts`
- Modify: `packages/server/src/services/control-admin.ts`
- Modify: `packages/server/src/http/control-app.ts`
- Modify: `deploy/api-entry.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `tests/credential-broker.test.ts`
- Modify: `tests/control-oauth.test.ts`
- Modify: `tests/runtime-rate-limit.test.ts`
- Modify: `tests/control-admin.test.ts`
- Modify: `tests/control-http-app.test.ts`
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/api/client.test.ts`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/app.test.tsx`

**Interfaces:**
- Consumes: `LocalDatabase`, `LocalKeyMaterial.rateLimitSecret`, existing cache interfaces and `ControlPlaneStore`.
- Produces:
  - `createExpiringMemoryCache(now?: () => Date): ExpiringMemoryCache`
  - `createSqliteOAuthReplayCache(database: DatabaseSync, now?: () => Date): ControlOAuthReplayCache`
  - `createRuntimeRateLimiter({ secret, now? }): RuntimeRateLimiter` with an atomic process-local counter
  - `AdminSnapshotResponse.storage: { mode: "local"; revision: number }`

- [ ] **Step 1: Write failing local-cache and persistent replay tests**

Add tests proving:

```ts
const cache = createExpiringMemoryCache(() => new Date(clock));
await cache.set("token", { value: 1 }, { ttl: 2 });
expect(await cache.get("token")).toEqual({ value: 1 });
clock += 2_001;
expect(await cache.get("token")).toBeNull();
```

For SQLite OAuth replay, set a marker, close and reopen the database, and assert the marker is still present until expiry. Assert expired rows are deleted on read.

- [ ] **Step 2: Write failing atomic rate-limit and local snapshot tests**

Update `tests/runtime-rate-limit.test.ts` so 20 concurrent consumes against a limit of 10 produce exactly 10 allowed results. Update admin tests to require:

```ts
expect(snapshot.storage).toEqual({ mode: "local", revision: snapshot.revision });
expect(snapshot).not.toHaveProperty("recoveryCopy");
```

Update the admin client strict decoder and app test so the UI displays `Local encrypted storage` and contains no Vercel recovery-copy warning.

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/credential-broker.test.ts tests/control-oauth.test.ts tests/runtime-rate-limit.test.ts tests/control-admin.test.ts tests/control-http-app.test.ts apps/admin/src/api/client.test.ts apps/admin/src/app.test.tsx
```

Expected: FAIL on the missing local cache APIs and changed admin snapshot contract.

- [ ] **Step 4: Implement local cache injection and remove service-level Vercel defaults**

Implement `ExpiringMemoryCache` with cloned values and monotonic expiry. Make `cache` mandatory in `CreateCredentialBrokerOptions`; make `runtimeCache` mandatory in `ControlOAuthServiceDependencies`. Delete `getCache` imports from both reusable services.

Until Task 18 deletes the Vercel composition, keep it compiling by explicitly constructing named `getCache(...)` adapters inside `deploy/api-entry.ts` and passing them to the now-mandatory service dependencies. This is temporary platform wiring only; do not reintroduce a Vercel default inside reusable service modules.

Implement `createSqliteOAuthReplayCache` with:

```sql
SELECT owner FROM oauth_replay WHERE replay_key = ? AND expires_at > ?;
INSERT INTO oauth_replay(replay_key, owner, expires_at)
VALUES (?, ?, ?)
ON CONFLICT(replay_key) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at;
DELETE FROM oauth_replay WHERE expires_at <= ?;
```

Keep the service's existing read-before-write and owner verification, now durable across process restarts.

- [ ] **Step 5: Make the rate limiter process-local and atomic**

Remove `@vercel/functions` from `runtime-rate-limit.ts`. Store each bucket window in a private `Map<string, CachedWindow>`. Because `consume` does no `await` between read and write, concurrent calls in one Node process observe an atomic update. Retain HMAC-subject hashing, fail-open only for invalid clock input, and the existing public interface.

- [ ] **Step 6: Replace recovery-copy API wording with local storage truth**

Change `AdminSnapshotResponse` to:

```ts
export interface AdminSnapshotResponse {
  revision: number;
  household: ControlHouseholdDto;
  pendingRequests: ControlRequestDto[];
  devices: ControlDeviceDto[];
  sources: ControlSourceDto[];
  roots: ControlRootDto[];
  storage: { mode: "local"; revision: number };
}
```

Remove `cache` and `recoveryStatus` from `ControlAdminService`. Encode `storage` from the loaded document revision. Change `control-app.ts::snapshotFromContext` to return `storage: { mode: "local", revision: context.revision }` and stop calling `admin.recoveryStatus()`. Update the admin strict decoder, fixtures, and UI copy in the same commit.

- [ ] **Step 7: Run focused tests and typecheck**

```powershell
npm test -- --run tests/credential-broker.test.ts tests/control-oauth.test.ts tests/runtime-rate-limit.test.ts tests/control-admin.test.ts tests/control-http-app.test.ts apps/admin/src/api/client.test.ts apps/admin/src/app.test.tsx
npm run typecheck
```

Expected: PASS, and `rg -n '@vercel/functions' packages/server/src/services` returns no matches.

- [ ] **Step 8: Commit**

```powershell
git add packages/server/src/runtime/local-cache.ts packages/server/src/sqlite/oauth-replay-cache.ts packages/server/src/services/credential-broker.ts packages/server/src/services/control-oauth.ts packages/server/src/services/runtime-rate-limit.ts packages/server/src/services/control-admin.ts packages/server/src/http/control-app.ts deploy/api-entry.ts packages/shared/src/api.ts packages/server/src/index.ts tests/credential-broker.test.ts tests/control-oauth.test.ts tests/runtime-rate-limit.test.ts tests/control-admin.test.ts tests/control-http-app.test.ts apps/admin/src/api/client.ts apps/admin/src/api/client.test.ts apps/admin/src/app.tsx apps/admin/src/app.test.tsx
git commit -m "Replace runtime caches with local state"
```

---

### Task 4: Implement Secure Fresh-Install Claiming

**Files:**
- Create: `packages/server/src/sqlite/installation-repository.ts`
- Create: `packages/server/src/services/installation.ts`
- Create: `packages/server/src/http/installation-app.ts`
- Create: `apps/admin/src/components/first-run.tsx`
- Create: `apps/admin/src/components/first-run.test.tsx`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/api/client.test.ts`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/app.test.tsx`
- Test: `tests/installation-repository.test.ts`
- Test: `tests/installation-service.test.ts`
- Test: `tests/installation-http.test.ts`

**Interfaces:**
- Consumes: `SqliteControlPlaneStore.initialize`, `LocalKeyMaterial.setupCodePepper`, `hashPassphrase`, and the local runtime rate limiter.
- Produces:
  - `initializeInstallation(repository, now, randomBytes): Promise<{ householdId: string; setupCode?: string }>`
  - `InstallationService.status(): Promise<InstallationStatusResponse>`
  - `InstallationService.claim(input: ClaimInstallationBody): Promise<{ configured: true }>`
  - `createInstallationApiApp(dependencies): (request: Request) => Promise<Response | null>`

- [ ] **Step 1: Write failing repository and service tests**

Cover one-time initialization, one-time plaintext emission, constant-time keyed digest validation, claim transaction, passphrase bounds, and replay rejection:

```ts
const initialized = await initializeInstallation(repository, () => now, bytes);
expect(initialized.setupCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
expect((await initializeInstallation(repository, () => now, bytes)).setupCode).toBeUndefined();

await expect(service.claim({ setupCode: initialized.setupCode!, passphrase: "short" }))
  .rejects.toThrow("INVALID_PASSPHRASE");
await expect(service.claim({ setupCode: "wrong-code", passphrase: VALID_PASSPHRASE }))
  .rejects.toThrow("SETUP_CODE_INVALID");
await expect(service.claim({ setupCode: initialized.setupCode!, passphrase: VALID_PASSPHRASE }))
  .resolves.toEqual({ configured: true });
await expect(service.claim({ setupCode: initialized.setupCode!, passphrase: VALID_PASSPHRASE }))
  .rejects.toThrow("INSTALLATION_ALREADY_CONFIGURED");
```

After claim, load the control store and assert an empty revision-1 document with the repository's household ID, hashed passphrase, default order `captured-desc`, slideshow `8`, and new device requests enabled.

- [ ] **Step 2: Write failing HTTP and admin UI tests**

Define strict shared contracts:

```ts
export type InstallationStatusResponse =
  | { state: "unconfigured" }
  | { state: "configured" };

export interface ClaimInstallationBody {
  setupCode: string;
  passphrase: string;
}
```

Test `GET /api/setup/status`, `POST /api/setup/claim`, method/query/body rejection, `Cache-Control: no-store`, stable error codes, and rate limiting. `POST` must reject missing or mismatched `Origin` and accept only the configured exact origin. In the admin UI test, return `unconfigured`, enter the code/passphrase/confirmation, claim, automatically call `login(passphrase)`, then load the empty local snapshot.

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/installation-repository.test.ts tests/installation-service.test.ts tests/installation-http.test.ts apps/admin/src/components/first-run.test.tsx apps/admin/src/api/client.test.ts apps/admin/src/app.test.tsx
```

Expected: FAIL because the installation service and UI do not exist.

- [ ] **Step 4: Implement installation persistence and code generation**

Generate a 16-byte random setup code encoded as canonical base64url. Store only:

```ts
createHmac("sha256", setupCodePepper).update(setupCode, "utf8").digest("base64url")
```

`initializeInstallation` inserts `installation(singleton=1, household_id='household-' + randomUUID(), setup_code_hash, configured=0, ...)` only when absent. Return the plaintext only from that successful insert so the entry point can log exactly:

```text
CLOUDFRAME_SETUP_CODE=<code>
```

The claim repository uses `BEGIN IMMEDIATE`, verifies `configured=0` and the keyed digest with `timingSafeEqual`, inserts the encrypted control document through a shared transaction helper, sets `configured=1`, nulls `setup_code_hash`, records `claimed_at`, and commits.

- [ ] **Step 5: Implement the installation service and API**

Validate setup code length/charset and passphrase length `16..1024` before hashing. Reuse `hashPassphrase(passphrase, passphrasePepper)`. Map errors to:

- `409 INSTALLATION_ALREADY_CONFIGURED`
- `401 SETUP_CODE_INVALID`
- `400 INVALID_PASSPHRASE`
- `429 RATE_LIMITED`
- `503 CONTROL_PLANE_UNAVAILABLE`

The installation app receives `allowedOrigin`, returns `null` for non-setup paths so the outer self-hosted router can continue, and requires an exact `Origin` match for claim before reading the body.

- [ ] **Step 6: Implement first-run admin flow**

Add to `AdminApi`:

```ts
installationStatus(): Promise<InstallationStatusResponse>;
claimInstallation(body: ClaimInstallationBody): Promise<{ configured: true }>;
```

`AdminApp` checks installation status before its existing snapshot check. Render `FirstRun` only for `unconfigured`. On submit:

```ts
await api.claimInstallation({ setupCode, passphrase });
await api.login(passphrase);
setAuthenticated(true);
await refresh();
```

Never retain the setup code or passphrase after completion. Use explicit copy explaining that `/data` is the installation boundary and no cloud configuration was imported.

- [ ] **Step 7: Run focused tests and typecheck**

```powershell
npm test -- --run tests/installation-repository.test.ts tests/installation-service.test.ts tests/installation-http.test.ts apps/admin/src/components/first-run.test.tsx apps/admin/src/api/client.test.ts apps/admin/src/app.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/server/src/sqlite/installation-repository.ts packages/server/src/services/installation.ts packages/server/src/http/installation-app.ts packages/shared/src/api.ts packages/server/src/index.ts apps/admin/src/components/first-run.tsx apps/admin/src/components/first-run.test.tsx apps/admin/src/api/client.ts apps/admin/src/api/client.test.ts apps/admin/src/app.tsx apps/admin/src/app.test.tsx tests/installation-repository.test.ts tests/installation-service.test.ts tests/installation-http.test.ts
git commit -m "Add secure first-run ownership"
```

---

### Task 5: Build the Self-Hosted HTTP Shell and Production Server Bundle

**Files:**
- Create: `packages/server/src/runtime/readiness.ts`
- Create: `packages/server/src/runtime/deferred-tasks.ts`
- Create: `packages/server/src/http/node-adapter.ts`
- Create: `packages/server/src/http/static-app.ts`
- Create: `packages/server/src/http/self-hosted-app.ts`
- Create: `packages/server/src/runtime/self-hosted-composition.ts`
- Modify: `packages/server/src/http/request.ts`
- Create: `deploy/server-entry.ts`
- Create: `scripts/build-server.mjs`
- Modify: `packages/providers/src/registry.ts`
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `package.json`
- Modify: `tsconfig.base.json`
- Test: `tests/readiness.test.ts`
- Test: `tests/node-adapter.test.ts`
- Test: `tests/static-app.test.ts`
- Test: `tests/self-hosted-app.test.ts`
- Test: `tests/self-hosted-composition.test.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: local configuration, key material, SQLite/control/installation repositories, local caches, existing service factories, built `dist/`, and `createControlApiApp`.
- Produces:
  - `createReadinessController(): ReadinessController`
  - `createDeferredTaskTracker(): DeferredTaskTracker`
  - `createNodeRequest(request, appOrigin, signal): Request`
  - `writeNodeResponse(response, target): Promise<void>`
  - `createStaticApp(options): (request: Request) => Promise<Response | null>`
  - `createSelfHostedApp(options): (request: Request) => Promise<Response>`
  - `createSelfHostedComposition(config, dependencies?): Promise<SelfHostedComposition>`

- [ ] **Step 1: Write failing Node adapter streaming tests**

Create a real ephemeral `node:http` server in `tests/node-adapter.test.ts`. Bridge each request through an echo Web handler and assert:

```ts
expect(await fetch(`${origin}/echo`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream" },
  body: Buffer.alloc(256 * 1024, 7)
}).then(response => response.arrayBuffer()).then(value => value.byteLength)).toBe(256 * 1024);
```

Add a response test whose Web `ReadableStream` yields three delayed chunks and assert the client receives the first chunk before the final chunk is produced. Abort a client request and assert the Web request signal becomes aborted. Send a forged `x-cloudframe-peer-address` and `x-vercel-forwarded-for`; assert the adapter strips both and sets `x-cloudframe-peer-address` from `request.socket.remoteAddress` only.

- [ ] **Step 2: Write failing static and router tests**

In `tests/static-app.test.ts`, create a temporary public tree with `index.html`, `admin/index.html`, and a hashed asset. Assert:

- `/` and `/folder/deep-link` return the TV SPA;
- `/admin/` and `/admin/settings` return the admin SPA;
- `/assets/app-abc123.js` streams the exact asset with immutable caching;
- `/../secret`, encoded traversal, backslashes, and dot segments return `400` or `404` without leaving the public root; and
- unsupported methods return `405`.

In `tests/self-hosted-app.test.ts`, compose fake health, setup, transcode, control, and static handlers and assert the exact routing order. `GET /healthz` must succeed while draining; `GET /readyz` must return `503` after `readiness.beginDrain()`.

- [ ] **Step 3: Write failing composition and optional-provider tests**

Test that a config containing only Google produces a registry where `get("google")` works and `get("onedrive")` throws `PROVIDER_NOT_CONFIGURED`. Compose against a temporary `/data`, inject fixture adapters, call setup status through the returned app, and assert no Vercel/GCP environment variable is read.

Assert the production server build command exists:

```ts
const root = JSON.parse(await readFile("package.json", "utf8"));
expect(root.scripts["build:server"]).toBe("npm run build && node scripts/build-server.mjs");
expect(root.scripts.start).toBe("node build/self-hosted/server/index.js");
```

- [ ] **Step 4: Run focused tests to verify RED**

```powershell
npm test -- --run tests/readiness.test.ts tests/node-adapter.test.ts tests/static-app.test.ts tests/self-hosted-app.test.ts tests/self-hosted-composition.test.ts
```

Expected: FAIL because the self-hosted HTTP and composition modules are missing.

- [ ] **Step 5: Implement readiness and deferred-task tracking**

Use these contracts:

```ts
export interface ReadinessController {
  markReady(): void;
  fail(code: string): void;
  beginDrain(): void;
  snapshot(): { live: true; ready: boolean; draining: boolean; errorCode?: string };
}

export interface DeferredTaskTracker {
  run(promise: Promise<unknown>): void;
  drain(timeoutMs: number): Promise<void>;
  pending(): number;
}
```

`run` must attach a rejection handler so an abandoned background promise cannot become an unhandled rejection. `drain` waits for the current tracked set or the timeout, without accepting an unbounded recursive stream of newly added tasks after draining begins.

- [ ] **Step 6: Implement the Node/Web adapter**

Construct the Web request from the configured origin plus the incoming path; do not trust incoming `Host` for security decisions. Copy safe incoming headers. For non-GET/HEAD requests, use `Readable.toWeb(request)` and set Node's required `duplex: "half"`. Tie `request.aborted`, `response.close`, and socket closure to an `AbortController`.

Delete the Vercel-specific subject resolver. `requestSubject` reads only the adapter-injected `x-cloudframe-peer-address`, validates it as a bounded IPv4/IPv6 literal, and otherwise returns `unknown`. Behind a localhost reverse proxy this deliberately uses one shared conservative rate-limit bucket; do not trust `X-Forwarded-For` without a separately designed trusted-proxy boundary.

When writing the Web response:

- set status and headers before reading the body;
- preserve multiple `set-cookie` values via `headers.getSetCookie()`;
- stream with `Readable.fromWeb(response.body).pipe(target)`;
- respect backpressure;
- cancel the Web body if the Node response closes; and
- finish immediately for `HEAD` or a null body.

- [ ] **Step 7: Implement safe static and SPA serving**

Map URL pathnames to server-owned absolute paths under the configured public root. Use `decodeURIComponent` exactly once, reject malformed encoding, NUL, backslash, `.`/`..` segments, and paths escaping `resolve(publicRoot)`. Stream files with content types for HTML, JS, CSS, JSON, SVG, WebP, PNG, ICO, and media fixture types.

Use:

```text
hashed /assets/*: public, max-age=31536000, immutable
HTML: no-cache
other files: public, max-age=3600
```

Never serve files from `/data`, source directories, or the server bundle.

- [ ] **Step 8: Implement provider registry support for omitted providers**

Change the registry factory to:

```ts
export function createProviderRegistry(
  adapters: Partial<Record<ProviderKind, ProviderAdapter>>
): ProviderRegistry
```

Add `"PROVIDER_NOT_CONFIGURED"` to `ProviderErrorCode`. `get(provider)` returns the configured adapter or throws a non-retryable `ProviderError("PROVIDER_NOT_CONFIGURED", ...)`. Map it to safe admin/API copy without exposing configuration values.

- [ ] **Step 9: Implement the self-hosted router and composition**

`createSelfHostedApp` checks health first, then setup, then a currently null transcode handler, then the existing control app for `/api/**`, then static serving. Unknown `/api/**` remains JSON `404`; unknown non-API routes receive SPA fallback or `404`.

`createSelfHostedComposition`:

1. opens `/data` and local keys;
2. runs migrations and initializes the installation row;
3. logs a newly created setup code exactly once;
4. constructs local caches and the SQLite control store;
5. constructs only configured provider adapters;
6. injects local caches into credential/OAuth/rate-limit services;
7. constructs installation and control handlers;
8. verifies built static roots; and
9. marks readiness.

Return:

```ts
export interface SelfHostedComposition {
  app(request: Request): Promise<Response>;
  readiness: ReadinessController;
  close(signal?: AbortSignal): Promise<void>;
}
```

The initial `transcodeApp` dependency is a handler that always returns `null`; later tasks replace it without changing route order.

- [ ] **Step 10: Implement the production bundle and entry point**

`scripts/build-server.mjs` must:

- remove `build/self-hosted`;
- bundle `deploy/server-entry.ts` with esbuild for `node24` ESM;
- copy root `dist` to `build/self-hosted/public`;
- externalize `@node-rs/argon2`. When building the server bundle outside Docker, copy its package and fetch/extract `@node-rs/argon2-linux-x64-gnu@2.1.0` with the existing `npm pack` pattern when the Linux package is absent on a Windows host. During the Docker build, `npm ci` on `linux/amd64` must install that optional package directly. Copy/fetch `@node-rs/argon2-linux-arm64-gnu` only in a separately verified future arm64 build;
- write `build/self-hosted/package.json` with `{ "type": "module" }`; and
- produce no public sourcemaps for an ordinary production build.

`deploy/server-entry.ts` parses config, creates the composition, starts `node:http` on `0.0.0.0:${port}`, and handles `SIGTERM`/`SIGINT` exactly once:

```ts
readiness.beginDrain();
server.close();
await composition.close(AbortSignal.timeout(15_000));
```

Set non-zero exit status on startup/readiness failure. Do not add Docker or host deployment in this task.

- [ ] **Step 11: Run focused tests, typecheck, and production build**

```powershell
npm test -- --run tests/readiness.test.ts tests/node-adapter.test.ts tests/static-app.test.ts tests/self-hosted-app.test.ts tests/self-hosted-composition.test.ts tests/control-http-app.test.ts
npm run typecheck
npm run build:server
node --check build/self-hosted/server/index.js
```

Expected: PASS and `build/self-hosted/public/admin/index.html` exists.

- [ ] **Step 12: Commit**

```powershell
git add package.json tsconfig.base.json packages/providers/src/registry.ts packages/providers/src/types.ts packages/server/src/index.ts packages/server/src/runtime/readiness.ts packages/server/src/runtime/deferred-tasks.ts packages/server/src/runtime/self-hosted-composition.ts packages/server/src/http/request.ts packages/server/src/http/node-adapter.ts packages/server/src/http/static-app.ts packages/server/src/http/self-hosted-app.ts deploy/server-entry.ts scripts/build-server.mjs tests/auth.test.ts tests/readiness.test.ts tests/node-adapter.test.ts tests/static-app.test.ts tests/self-hosted-app.test.ts tests/self-hosted-composition.test.ts
git commit -m "Add the self-hosted server runtime"
```

---

### Task 6: Carry Provider Content Revisions Through Sealed Browse Authorization

**Files:**
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/google-drive.ts`
- Modify: `packages/providers/src/onedrive.ts`
- Modify: `packages/server/src/auth/browse-handles.ts`
- Modify: `packages/server/src/services/live-browse.ts`
- Modify: `packages/server/src/services/direct-media.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `apps/tv/src/api/client.ts`
- Modify: `apps/tv/src/components/viewer.tsx`
- Modify: `tests/provider-contract.test.ts`
- Modify: `tests/browse-handles.test.ts`
- Modify: `tests/live-browse.test.ts`
- Modify: `tests/direct-media.test.ts`
- Modify: `tests/helpers/api.ts`
- Modify: `apps/tv/src/app.test.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `e2e/fixtures.ts`

**Interfaces:**
- Consumes: Google Drive `version`, OneDrive `eTag`, existing sealed item handles, and `TvBrowseItemDto`.
- Produces:
  - `ProviderNode.contentRevision: string | null`
  - `BrowseItemClaims.contentRevision: string | null`
  - `BrowseItemClaims.size: number | null`
  - `TvBrowseItemDto.contentRevision: string | null`
  - direct media responses whose `revision` equals the authenticated content revision.

- [ ] **Step 1: Write failing provider revision tests**

Update Google and OneDrive fixture assertions:

```ts
expect(googleVideo).toMatchObject({
  thumbnailRevision: "7",
  contentRevision: "7"
});
expect(oneDriveVideo).toMatchObject({
  thumbnailRevision: '"etag-7"',
  contentRevision: '"etag-7"'
});
```

Add malformed provider values and assert empty/overlong revisions normalize to `null` rather than entering handles.

- [ ] **Step 2: Write failing browse-handle and media-response tests**

Seal an item with `size: 12_345` and `contentRevision: "provider-revision-7"`; open it and expect exact preservation. Open a legacy test handle without those properties and expect both to default to `null`.

Assert `TvBrowseItemDto` exposes both presentation thumbnail revision and content revision, and that `directMedia.media` returns:

```ts
expect(response).toMatchObject({ revision: "provider-revision-7" });
```

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/provider-contract.test.ts tests/browse-handles.test.ts tests/live-browse.test.ts tests/direct-media.test.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx
```

Expected: FAIL because content revisions and sealed sizes do not exist.

- [ ] **Step 4: Add content revision to provider normalization**

Extend `ProviderNode` with `contentRevision`. Google maps bounded Drive `version`; OneDrive maps bounded `eTag`. Keep `thumbnailRevision` separate even where both happen to share a provider value.

Use one bounded helper:

```ts
function providerRevision(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 256
    ? value
    : null;
}
```

- [ ] **Step 5: Seal size and revision into item claims**

Add nullable parsing with safe-integer and 256-character bounds. The parser treats omitted legacy properties as `null`:

```ts
size: nullableNonNegativeInteger(input.size),
contentRevision: nullableBoundedString(input.contentRevision, 256)
```

Root claims set both fields to `null`; child claims copy normalized provider values. The public DTO copies `contentRevision`, while `thumbnailRevision` remains presentation-only metadata.

- [ ] **Step 6: Use content revision for viewer and direct-media identity**

Change `toViewerItem` to use `item.contentRevision`. Return `item.claims.contentRevision` from direct media. Update strict TV decoders, fixtures, and test DTO builders to require the new exact field.

- [ ] **Step 7: Run focused tests and Chromium-safe build**

```powershell
npm test -- --run tests/provider-contract.test.ts tests/browse-handles.test.ts tests/live-browse.test.ts tests/direct-media.test.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx
npm run typecheck
npm run build -w @cloudframe/tv
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/providers/src/types.ts packages/providers/src/google-drive.ts packages/providers/src/onedrive.ts packages/server/src/auth/browse-handles.ts packages/server/src/services/live-browse.ts packages/server/src/services/direct-media.ts packages/shared/src/api.ts apps/tv/src/api/client.ts apps/tv/src/components/viewer.tsx tests/provider-contract.test.ts tests/browse-handles.test.ts tests/live-browse.test.ts tests/direct-media.test.ts tests/helpers/api.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx e2e/fixtures.ts
git commit -m "Authenticate provider content revisions"
```

---

### Task 7: Extract a Reusable Validated Provider Media Resolver

**Files:**
- Create: `packages/server/src/services/provider-media-source.ts`
- Modify: `packages/server/src/services/direct-media.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `tests/direct-media.test.ts`
- Test: `tests/provider-media-source.test.ts`

**Interfaces:**
- Consumes: `AuthorizedBrowseItem`, `CredentialBroker`, `ProviderRegistry`, current provider URL allowlists, and provider credential refresh.
- Produces:

```ts
export interface ValidatedProviderMediaSource {
  item: AuthorizedBrowseItem;
  provider: ProviderKind;
  request: {
    url: string;
    headers: Headers;
    expiresAt: Date;
  };
  credentialVersion: number;
}

export interface ProviderMediaSourceService {
  resolve(
    item: AuthorizedBrowseItem,
    options?: { refresh?: boolean }
  ): Promise<ValidatedProviderMediaSource>;
}

export type ProviderMediaSourceErrorCode =
  | "INVALID_PROVIDER_URL"
  | "ITEM_NOT_FOUND";

export class ProviderMediaSourceError extends Error {
  constructor(readonly code: ProviderMediaSourceErrorCode) {
    super(code);
    this.name = "ProviderMediaSourceError";
  }
}
```

- [ ] **Step 1: Write failing resolver tests**

Move the current URL-security matrix into `tests/provider-media-source.test.ts` and cover:

- exact Google Drive URL, query keys, bearer header, and credential version;
- allowed OneDrive SharePoint/1drv/storage/microsoftusercontent URLs;
- traversal, encoded traversal, userinfo, ports, fragments, missing capabilities, arbitrary hosts, extra Google headers, and query-token rejection;
- provider redirects whose final `response.url` leaves the same existing provider allowlist;
- one non-`invalid_grant` credential refresh;
- no second refresh; and
- navigation expiry when credentials no longer match the sealed version.

Assert the returned `Headers` is a clone and mutation does not affect cached service state.

- [ ] **Step 2: Write failing direct-media delegation tests**

Inject a fake `ProviderMediaSourceService` into `createDirectMediaService`, call `media`, and assert `resolve(item)` is called exactly once while output stays byte-for-byte compatible with the existing direct/Google response union.

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/provider-media-source.test.ts tests/direct-media.test.ts
```

Expected: FAIL because the resolver service does not exist and direct-media still owns URL validation.

- [ ] **Step 4: Move provider retrieval and validation into the new service**

Move, without broadening, the current Google/OneDrive URL validators and one-refresh logic from `direct-media.ts`. Own `INVALID_PROVIDER_URL` and resolver-local not-found normalization in `ProviderMediaSourceError`; do not import `DirectMediaError` and do not create a service cycle. Preserve `ProviderError` for provider availability/reauthorization. For direct OneDrive requests, return an empty `Headers`; for Google, return only the exact bearer header.

`options.refresh === true` must force one broker refresh before provider retrieval; it must not permit a further refresh after failure.

- [ ] **Step 5: Delegate direct media to the resolver**

Change `CreateDirectMediaServiceOptions` to consume `mediaSources: ProviderMediaSourceService`. Keep thumbnail logic on its current adapter path. `media` authorizes the handle, rejects folders, calls the resolver, maps `ProviderMediaSourceError("ITEM_NOT_FOUND")` to `DirectMediaError("ITEM_NOT_FOUND")` and `INVALID_PROVIDER_URL` to the existing direct-media code, then encodes Google bearer versus direct output from `source.provider`.

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
npm test -- --run tests/provider-media-source.test.ts tests/direct-media.test.ts tests/control-http-app.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/server/src/services/provider-media-source.ts packages/server/src/services/direct-media.ts packages/server/src/index.ts tests/provider-media-source.test.ts tests/direct-media.test.ts
git commit -m "Centralize provider media retrieval"
```

---

### Task 8: Add Transcode Types, Profile, SQLite Catalog, and Disk Cache

**Files:**
- Create: `packages/server/src/transcode/types.ts`
- Create: `packages/server/src/transcode/profile.ts`
- Create: `packages/server/src/transcode/catalog.ts`
- Create: `packages/server/src/transcode/cache.ts`
- Modify: `packages/server/src/sqlite/migrations.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/transcode-profile.test.ts`
- Test: `tests/transcode-catalog.test.ts`
- Test: `tests/transcode-cache.test.ts`

**Interfaces:**
- Consumes: `LocalDatabase`, authenticated browse claims, `SelfHostedConfig.transcode`, and Node filesystem/statfs APIs.
- Produces:
  - `TRANSCODE_PROFILE: TranscodeProfile`
  - `cacheIdentity(binding, profile): string`
  - `createTranscodeCatalog(database): TranscodeCatalog`
  - `createTranscodeCache(options): TranscodeCache`

- [ ] **Step 1: Write failing profile and cache-identity tests**

Define a complete `TranscodeSourceBinding` fixture and assert:

```ts
expect(cacheIdentity(binding, TRANSCODE_PROFILE)).toMatch(/^[a-f0-9]{64}$/);
expect(cacheIdentity(binding, TRANSCODE_PROFILE)).toBe(cacheIdentity({ ...binding }, TRANSCODE_PROFILE));
expect(cacheIdentity({ ...binding, contentRevision: "revision-2" }, TRANSCODE_PROFILE))
  .not.toBe(cacheIdentity(binding, TRANSCODE_PROFILE));
expect(cacheIdentity({ ...binding, name: "renamed.mpg" }, TRANSCODE_PROFILE))
  .toBe(cacheIdentity(binding, TRANSCODE_PROFILE));
```

Assert the profile exactly contains four-second segments, five segments per window, `libx264`, `yuv420p`, CRF 22, `veryfast`, AAC 160 kbit/s, stereo maximum, and 1920×1080 without upscaling.

- [ ] **Step 2: Write failing catalog migration and CRUD tests**

Add migration 2 with these tables:

```sql
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
```

Test probe upsert/load, segment recording, window partial/complete state, byte-accounting updates, access touches, asset deletion, and LRU candidate ordering.

- [ ] **Step 3: Write failing filesystem cache tests**

Using a temporary directory and injected `statfs`, assert:

- cache paths contain only hashed server-owned segments;
- traversal-shaped cache keys/job IDs are rejected;
- staging files ending in `.tmp` are removed at startup;
- a validated completed segment is hashed and atomically promoted;
- a checksum/size mismatch is rejected and not entered in the catalog;
- active/served/generating assets are excluded from eviction;
- LRU assets are deleted until both max bytes and minimum free bytes are satisfied; and
- an unsatisfied reserve throws `TRANSCODER_CACHE_FULL`.

- [ ] **Step 4: Run focused tests to verify RED**

```powershell
npm test -- --run tests/transcode-profile.test.ts tests/transcode-catalog.test.ts tests/transcode-cache.test.ts
```

Expected: FAIL because the transcode foundation does not exist.

- [ ] **Step 5: Implement types and deterministic profile identity**

Define at least:

```ts
export interface TranscodeSourceBinding {
  householdId: string;
  deviceId: string;
  deviceSessionVersion: number;
  sourceId: string;
  rootId: string;
  rootProviderNodeId: string;
  providerNodeId: string;
  provider: ProviderKind;
  itemId: string;
  name: string;
  mimeType: string | null;
  size: number | null;
  contentRevision: string | null;
  credentialVersion: number;
}

export interface MediaProbe {
  durationMs: number;
  container: string;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  pixelFormat: string | null;
  frameRate: number | null;
}
```

`cacheIdentity` serializes only stable media identity fields with length prefixes and hashes them with SHA-256. Do not include item names, temporary URLs, access tokens, device ID, or device session version; include household, provider, source, provider node, revision, size, and profile ID. If `contentRevision` is `null`, include an explicit null marker plus the authenticated size; if both revision and size are null, the source authorizer rejects transcoding as `TRANSCODER_UNSUPPORTED` because no safe reusable identity exists.

Use one declared profile object containing both profile constants and the configured runtime thread setting; do not mutate the exported constant. Prefer:

```ts
export interface TranscodeProfile {
  id: "h264-aac-1080p-v1";
  segmentDurationMs: 4000;
  segmentsPerWindow: 5;
  windowDurationMs: 20000;
  maxWidth: 1920;
  maxHeight: 1080;
  maxFrameRate: 30;
  threads: number | "auto";
}

export function transcodeProfile(threads: number | "auto"): TranscodeProfile;
```

`cacheIdentity` includes the stable profile ID, not the host-specific thread count.

- [ ] **Step 6: Implement the catalog**

Use prepared statements and explicit transactions. Strictly decode `probe_json` back through a parser; corrupt persisted metadata is treated as missing and removed before reuse. Update `total_bytes` in the same transaction that inserts or deletes segment metadata.

- [ ] **Step 7: Implement cache paths, reconciliation, promotion, and eviction**

Use:

```text
/data/transcodes/<first-two-hex>/<cache-key>/<segment-index>.ts
/data/staging/<job-id>/<segment-index>.ts.tmp
```

Validate cache keys as 64 lowercase hex, job IDs as 32–128 URL-safe characters, and segment indices as safe non-negative integers. Promotion flow:

1. close the staging writer;
2. stat and SHA-256 the file;
3. verify non-zero bounded size;
4. rename within the same filesystem to the final `.ts` path;
5. open and fsync the containing directory on Linux, while the Windows test/dev path records the explicitly skipped directory-fsync branch; and
6. record catalog metadata.

Track active asset, served-segment, and generating-window pins in memory. Eviction consults catalog LRU, skips every pinned cache key, deletes the hashed asset directory, and deletes its catalog row transactionally.

- [ ] **Step 8: Run focused tests and typecheck**

```powershell
npm test -- --run tests/sqlite-database.test.ts tests/transcode-profile.test.ts tests/transcode-catalog.test.ts tests/transcode-cache.test.ts
npm run typecheck
```

Expected: PASS and a freshly opened test database reports schema version 2.

- [ ] **Step 9: Commit**

```powershell
git add packages/server/src/transcode/types.ts packages/server/src/transcode/profile.ts packages/server/src/transcode/catalog.ts packages/server/src/transcode/cache.ts packages/server/src/sqlite/migrations.ts packages/server/src/index.ts tests/transcode-profile.test.ts tests/transcode-catalog.test.ts tests/transcode-cache.test.ts
git commit -m "Add the transcode cache foundation"
```

---

### Task 9: Authorize Transcode Sources and Serve Them Through a Loopback Gateway

**Files:**
- Create: `packages/server/src/transcode/source-authorizer.ts`
- Create: `packages/server/src/transcode/source-gateway.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/transcode-source-authorizer.test.ts`
- Test: `tests/transcode-source-gateway.test.ts`

**Interfaces:**
- Consumes: `ControlPlaneStore`, `BrowseHandleCodec`, `ProviderMediaSourceService`, `TranscodeSourceBinding`, and the current device session codec.
- Produces:

```ts
export interface AuthorizedTranscodeSource {
  auth: AuthenticatedControlDevice;
  item: AuthorizedBrowseItem;
  binding: TranscodeSourceBinding;
}

export interface TranscodeSourceAuthorizer {
  bind(
    auth: AuthenticatedControlDevice,
    item: AuthorizedBrowseItem
  ): AuthorizedTranscodeSource;
  validateCurrent(
    auth: AuthenticatedControlDevice,
    binding: TranscodeSourceBinding
  ): AuthorizedBrowseItem;
  withReauthorizedItem<T>(
    binding: TranscodeSourceBinding,
    operation: (item: AuthorizedBrowseItem) => Promise<T>
  ): Promise<T>;
}

export interface SourceGatewayGrant {
  capability: string;
  inputUrl: string;
  expiresAt: number;
  revoke(): void;
}

export interface TranscodeSourceGateway {
  start(): Promise<{ origin: string }>;
  grant(binding: TranscodeSourceBinding, jobId: string): SourceGatewayGrant;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing authorization tests**

Use the existing test control document and an already authenticated/authorized browse item. Assert `bind` succeeds only when all fields agree with the current authenticated context:

```ts
expect(authorizer.bind(auth, item).binding).toEqual({
  householdId: "h1",
  deviceId: "device-1",
  deviceSessionVersion: 1,
  sourceId: "source-1",
  rootId: "root-1",
  rootProviderNodeId: "provider-trips",
  providerNodeId: "video-1",
  provider: "google",
  itemId: expect.stringMatching(/^item_/),
  name: "MOV00516.MPG",
  mimeType: "video/mpeg",
  size: 12_345,
  contentRevision: "revision-7",
  credentialVersion: 1
});
```

Disable/revoke the device, remove/disable the root, remove/disable/reauth the source, rotate `credentialVersion`, change the provider revision in a newly sealed handle, and use another device. Each must fail with `DEVICE_UNAUTHORIZED`, `ITEM_NOT_FOUND`, or `NAVIGATION_EXPIRED` without leaking the mismatched field.

`bind` must reject an item from another device or request context. `validateCurrent(auth, binding)` performs the same binding checks against the already loaded public request context. `withReauthorizedItem(binding, operation)` must load a fresh request context, reject any binding whose device/root/source/credential state no longer matches, and run `operation` inside that same `ControlRequestContextScope` so the credential broker sees the validated current state.

- [ ] **Step 2: Write failing loopback and capability tests**

Start the gateway on an ephemeral loopback port with a fake provider resolver and test:

- `HEAD` and `GET` without Range;
- one valid `Range: bytes=10-19` response preserving `206`, `Content-Range`, `Content-Length`, `Content-Type`, `Accept-Ranges`, `ETag`, and `Last-Modified`;
- a provider `416` response;
- one provider authorization refresh through `mediaSources.resolve(item, { refresh: true })` after `401` or `403`;
- no second refresh;
- streaming a 4 MiB body without calling `arrayBuffer`, `blob`, `text`, or `json`;
- expired, revoked, wrong-job, unknown, overused, and malformed capabilities;
- invalid methods and multiple ranges;
- a request sent to `0.0.0.0`, a non-loopback socket fixture, or an external public handler never reaches the grant; and
- logs never contain the capability, provider URL, bearer token, or signed query.

Assert the URL passed to FFmpeg is shaped only as:

```ts
expect(grant.inputUrl).toBe(`${gatewayOrigin}/source/${grant.capability}`);
```

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/transcode-source-authorizer.test.ts tests/transcode-source-gateway.test.ts
```

Expected: FAIL because neither authorizer nor gateway exists.

- [ ] **Step 4: Implement current-state source authorization**

`bind` verifies that the item's household/device/root/source values match `AuthenticatedControlDevice`, rejects folders/images, and builds the binding from server-owned claims. Require at least one authenticated change detector: non-null `contentRevision` or non-null source `size`. If both are absent, return `TRANSCODER_UNSUPPORTED`; otherwise the cache key includes the explicit revision/null marker and size/null marker.

Factor the invariant checks into `validateCurrent`. `withReauthorizedItem` calls `requestContext.runRequest`, uses `loadControlRequestContext`, constructs the current enabled device from the binding, then calls the same validator before invoking the operation. Verify:

- household ID;
- enabled, non-revoked device and `deviceSessionVersion`;
- assigned, enabled root and source association;
- healthy source and matching credential version;
- provider kind and root provider node ID; and
- the same provider node and content revision captured in the binding.

It then invokes the supplied operation before leaving the async-local request context. Do not reconstruct authorization from client-supplied fields.

Provider browse handles are short-lived, but an active HLS session may outlive the original 30-minute handle. Later segment requests therefore do not reopen the expired handle. Before every new FFprobe or FFmpeg child process, use current brokered credentials to call the provider adapter's `getNode` and require the live node to remain a video with the same `contentRevision` when non-null and the same `size` when non-null. A mismatch expires the transcode session and never writes into the old cache identity.

- [ ] **Step 5: Implement capability issuance and loopback binding**

Bind with `server.listen(0, "127.0.0.1")`. Generate 32 random bytes per capability, store only in an in-memory map, and bind each grant to one `jobId`, one source binding, a two-minute maximum expiry, and two concurrent input connections. `revoke()` removes the grant and aborts active requests.

The route accepts exactly `/source/<base64url-capability>`, with no query or fragment. Reject any non-loopback remote address after normalizing IPv4-mapped loopback.

- [ ] **Step 6: Implement provider retrieval and safe range streaming**

For each accepted request:

1. call `authorizer.withReauthorizedItem(binding, async item => { validate the current provider node identity; return mediaSources.resolve(item); })`;
2. use the resolved provider media source;
3. fetch it with only `GET`/`HEAD`, provider-owned authorization headers, `redirect: "follow"`, and at most one validated single-byte Range header;
4. if the provider returns `401`/`403`, resolve once with `{ refresh: true }` and retry once;
5. validate both the requested URL and the final `response.url` against the same provider-specific allowlist on both attempts, rejecting any redirect that leaves it;
6. stream the body through the Node/Web adapter without buffering; and
7. copy only `accept-ranges`, `content-length`, `content-range`, `content-type`, `etag`, and `last-modified`.

Do not forward cookies, referrer, `If-Range`, conditional headers, arbitrary user headers, or provider response cookies. Normalize all errors to a stable gateway status consumed by FFmpeg diagnostics.

- [ ] **Step 7: Run focused tests and typecheck**

```powershell
npm test -- --run tests/transcode-source-authorizer.test.ts tests/transcode-source-gateway.test.ts tests/provider-media-source.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/server/src/transcode/source-authorizer.ts packages/server/src/transcode/source-gateway.ts packages/server/src/index.ts tests/transcode-source-authorizer.test.ts tests/transcode-source-gateway.test.ts
git commit -m "Secure transcoder provider input"
```

---

### Task 10: Add Cancellable FFmpeg Processes, Strict FFprobe, and Complete HLS Manifests

**Files:**
- Create: `packages/server/src/transcode/process-runner.ts`
- Create: `packages/server/src/transcode/probe.ts`
- Create: `packages/server/src/transcode/manifests.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/transcode-process-runner.test.ts`
- Test: `tests/transcode-probe.test.ts`
- Test: `tests/transcode-manifests.test.ts`

**Interfaces:**
- Consumes: loopback `SourceGatewayGrant.inputUrl`, `TranscodeProfile`, and `TranscodeCatalog` probe storage.
- Produces:

```ts
export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderrTail: string;
}

export interface ProcessRunner {
  run(command: string, args: readonly string[], options: {
    signal: AbortSignal;
    timeoutMs: number;
    cwd?: string;
    stdoutLimitBytes?: number;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  }): Promise<ProcessResult>;
}

export interface MediaProbeService {
  probe(inputUrl: string, signal: AbortSignal): Promise<MediaProbe>;
}

export function renderMasterPlaylist(sessionId: string): string;
export function renderMediaPlaylist(probe: MediaProbe, profile: TranscodeProfile): string;
```

- [ ] **Step 1: Write failing process-runner tests**

Run `node -e` child fixtures rather than mocking spawn. Prove:

- stdout can be ignored without deadlock and is bounded by `stdoutLimitBytes` when capture is requested;
- stderr retains only the last 32 KiB and replaces URLs, bearer text, query strings, and 22+ character capability-shaped tokens with `[redacted]`;
- a normal exit reports code `0`;
- a non-zero exit reports the code without throwing away the diagnostic tail;
- an already-aborted signal prevents spawn;
- abort sends termination and escalates after the injected grace period; and
- the runner always calls `spawn(command, args, { shell: false, windowsHide: true, detached: process.platform !== "win32" })` through an injectable spawn dependency.

- [ ] **Step 2: Generate and commit a deterministic MPEG fixture**

Generate a two-second fixture in `tests/fixtures/media/legacy-mpeg.mpg`:

```powershell
New-Item -ItemType Directory -Force tests/fixtures/media | Out-Null
ffmpeg -hide_banner -loglevel error -y `
  -f lavfi -i "testsrc2=size=640x360:rate=25:duration=2" `
  -f lavfi -i "sine=frequency=880:sample_rate=48000:duration=2" `
  -c:v mpeg2video -pix_fmt yuv420p -g 25 -b:v 1800k `
  -c:a mp2 -b:a 192k -shortest tests/fixtures/media/legacy-mpeg.mpg
```

Verify the fixture before using it:

```powershell
ffprobe -v error -show_entries stream=codec_type,codec_name -of json tests/fixtures/media/legacy-mpeg.mpg
```

Expected: one `mpeg2video` video stream and one `mp2` audio stream.

- [ ] **Step 3: Write failing real FFprobe tests**

Serve the committed fixture from an ephemeral local HTTP server with byte-range support. Assert:

```ts
expect(await probe.probe(url, AbortSignal.timeout(10_000))).toMatchObject({
  durationMs: expect.any(Number),
  container: expect.stringContaining("mpeg"),
  videoCodec: "mpeg2video",
  audioCodec: "mp2",
  width: 640,
  height: 360,
  pixelFormat: "yuv420p"
});
```

Add invalid JSON, 1 MiB output, no-video, zero/NaN duration, excessive duration, encrypted/unsupported stream metadata, timeout, cancellation, and non-zero exit cases. All client-facing errors must be one of `TRANSCODER_SOURCE_UNAVAILABLE`, `TRANSCODER_UNSUPPORTED`, or `TRANSCODER_FAILED`.

- [ ] **Step 4: Write failing manifest tests**

For a `durationMs` of `43_250`, assert a 4-second target produces 11 segment URIs, an `EXT-X-DISCONTINUITY` before segments 5 and 10, a final `EXTINF:3.250`, and `#EXT-X-ENDLIST`. Verify every URI is relative and numeric:

```text
segments/0.ts
segments/1.ts
...
segments/10.ts
```

Assert the master playlist contains one relative `stream.m3u8`, bandwidth metadata, resolution bounded by the probe, and codec string `avc1.640029,mp4a.40.2` when audio exists or only `avc1.640029` when it does not. The AVC value declares High Profile, Level 4.1 and must match the encoder arguments below.

- [ ] **Step 5: Run focused tests to verify RED**

```powershell
npm test -- --run tests/transcode-process-runner.test.ts tests/transcode-probe.test.ts tests/transcode-manifests.test.ts
```

Expected: FAIL because the process, probe, and manifest modules are missing.

- [ ] **Step 6: Implement bounded process execution**

Use `spawn` with a direct argument array. Always drain stdout. If `onStdoutLine` is present, decode complete bounded UTF-8 lines and do not also retain them; otherwise retain at most `stdoutLimitBytes ?? 0` bytes and abort the child before accepting an oversized stream. Split stderr incrementally into lines, call the progress callback with already-redacted lines, and retain a 32 KiB redacted tail. On timeout or abort:

- terminate the process group on POSIX and the child on Windows;
- wait up to two seconds;
- escalate to `SIGKILL` on POSIX or `taskkill /T /F` only inside the Windows test/dev implementation; and
- resolve only after the child's `close` event.

Never interpolate a command string or include provider credentials in args.

- [ ] **Step 7: Implement strict FFprobe execution and decoding**

Invoke:

```ts
[
  "-v", "error",
  "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate",
  "-of", "json",
  inputUrl
]
```

Call the runner with `stdoutLimitBytes: 1024 * 1024`. Parse `result.stdout` as UTF-8 JSON only after a successful exit. Require an ordinary JSON object, exactly one usable video stream, optional first audio stream, finite duration from 1 ms through 24 hours, positive dimensions no larger than 16,384, bounded codec/container strings, and a finite frame rate no higher than 240. `MediaProbeService` only probes and decodes; Task 12 owns cache-key lookup and storing successful probes in `TranscodeCatalog`.

- [ ] **Step 8: Implement complete master and media playlists**

Compute segment count as `Math.ceil(durationMs / segmentDurationMs)`. Render every decimal duration with exactly three fractional digits. Insert a discontinuity before every non-zero segment whose index is divisible by `segmentsPerWindow`. Escape no user data because playlists contain only server-owned numeric paths and constants. End output with exactly one newline.

- [ ] **Step 9: Run focused tests, fixture probe, and typecheck**

```powershell
npm test -- --run tests/transcode-process-runner.test.ts tests/transcode-probe.test.ts tests/transcode-manifests.test.ts
ffprobe -v error -show_entries stream=codec_type,codec_name -of json tests/fixtures/media/legacy-mpeg.mpg
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add packages/server/src/transcode/process-runner.ts packages/server/src/transcode/probe.ts packages/server/src/transcode/manifests.ts packages/server/src/index.ts tests/transcode-process-runner.test.ts tests/transcode-probe.test.ts tests/transcode-manifests.test.ts tests/fixtures/media/legacy-mpeg.mpg
git commit -m "Probe media and render HLS manifests"
```

---

### Task 11: Encode and Atomically Publish One HLS Window

**Files:**
- Create: `packages/server/src/transcode/window-encoder.ts`
- Modify: `packages/server/src/transcode/types.ts`
- Modify: `packages/server/src/transcode/process-runner.ts`
- Modify: `packages/server/src/transcode/cache.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/transcode-window-encoder.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner`, `TranscodeSourceGateway`, `TranscodeCache`, `TranscodeCatalog`, `TranscodeProfile`, `MediaProbe`, and `TranscodeSourceBinding`.
- Produces:

```ts
export interface EncodeWindowInput {
  jobId: string;
  cacheKey: string;
  binding: TranscodeSourceBinding;
  probe: MediaProbe;
  windowIndex: number;
  signal: AbortSignal;
  onProgress?: (progress: TranscodeProgress) => void;
  onSegmentPromoted?: (segmentIndex: number) => void;
}

export interface EncodeWindowResult {
  cacheKey: string;
  windowIndex: number;
  completedSegmentIndices: number[];
  complete: boolean;
}

export interface WindowEncoder {
  encode(input: EncodeWindowInput): Promise<EncodeWindowResult>;
}
```

- [ ] **Step 1: Write failing FFmpeg argument tests**

Inject a capturing process runner and assert a middle window uses the exact safe shape:

```ts
expect(args).toEqual(expect.arrayContaining([
  "-hide_banner", "-nostdin", "-loglevel", "warning",
  "-ss", "20.000",
  "-i", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/source\/[A-Za-z0-9_-]+$/),
  "-t", "20.000",
  "-map", "0:v:0", "-map", "0:a:0?",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
  "-profile:v", "high", "-level:v", "4.1",
  "-pix_fmt", "yuv420p",
  "-vf", "fps=fps='min(source_fps,30)',scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
  "-c:a", "aac", "-b:a", "160k", "-ac", "2",
  "-force_key_frames", "expr:gte(t,n_forced*4)",
  "-f", "segment", "-segment_time", "4", "-reset_timestamps", "1"
]));
expect(args.join(" ")).not.toContain(binding.name);
expect(args.join(" ")).not.toMatch(/Bearer|access_token|tempauth/);
```

Assert the output pattern points only into the server-created staging job directory and begins numbering at the requested global segment offset.

- [ ] **Step 2: Write failing real encoding tests**

Serve `legacy-mpeg.mpg` through the real source gateway. Encode window 0 and assert:

- attach `onSegmentPromoted`, pause the injected process runner after it emits the first valid CSV list line, assert segment 0 is readable while the `encode()` promise is still pending, then allow the child to exit;
- the final result reports one completed short segment and `complete: true` for the two-second source;
- FFprobe on the promoted segment reports H.264 video, AAC audio, and `yuv420p`;
- the catalog marks window 0 complete and records the checksum/size; and
- the source grant is revoked after exit.

Generate a test-only 12-second MPEG source in a temporary directory and abort after the first segment promotion. Assert the first completed segment remains valid, the window remains `partial`, `.tmp` files are removed, and a second call reuses/replaces only deterministic missing segments before marking complete.

- [ ] **Step 3: Write failing failure/cancellation tests**

Cover provider disconnect, non-zero FFmpeg exit, first-segment timeout, explicit abort, a staging path collision, and cache reserve failure. Assert:

- no partial `.ts` file enters the final cache;
- promoted segments stay reusable;
- active generating pins are released in `finally`;
- the window never becomes complete after failure; and
- the surfaced error is one stable transcoder code with bounded redacted stderr only in diagnostics.

- [ ] **Step 4: Run focused tests to verify RED**

```powershell
npm test -- --run tests/transcode-window-encoder.test.ts
```

Expected: FAIL because the window encoder does not exist.

- [ ] **Step 5: Add streaming progress support to the process runner**

Allow `ProcessRunner.run` to expose redacted stderr lines during execution. Parse only FFmpeg progress tokens produced by adding:

```text
-progress pipe:2 -stats_period 0.5
```

Recognize bounded `out_time_ms`, `speed`, `frame`, and `progress` keys; ignore all unknown lines. Never store a raw line before redaction.

- [ ] **Step 6: Implement FFmpeg window arguments**

For `windowIndex`, calculate:

```ts
const firstSegment = windowIndex * profile.segmentsPerWindow;
const startMs = firstSegment * profile.segmentDurationMs;
const remainingMs = probe.durationMs - startMs;
const encodeMs = Math.min(profile.windowDurationMs, remainingMs);
```

Reject negative/out-of-range windows. Create a fresh random job directory. Issue one loopback grant. Invoke FFmpeg with accurate input seeking, bounded duration, optional audio mapping, the fixed profile, MPEG-TS segment output, and `-segment_start_number firstSegment`.

When the profile's configured thread count is numeric, add `-threads <count>`; omit it for `auto` so libx264 selects its CPU-appropriate value.

- [ ] **Step 7: Publish completed segments while FFmpeg is running**

Do not wait for FFmpeg exit to expose the first segment. Use the `onStdoutLine` interface added in Task 10 so FFmpeg's stdout is drained as bounded lines and not retained. Ask the segment muxer to write a CSV list to `pipe:1`:

```text
-segment_list pipe:1
-segment_list_type csv
-segment_list_size 0
```

FFmpeg writes each payload as `<index>.ts.part`. A complete CSV line is the authoritative signal that the corresponding segment file has been closed; parse only an expected numeric basename and bounded finite duration. Do not infer completion from size/mtime stability.

For each stable expected segment:

1. rename the closed `.part` to `<index>.ts.tmp` in staging;
2. call `cache.promoteSegment` with the expected global index and computed duration;
3. notify segment waiters; and
4. emit redacted progress.

After exit code 0, publish the last stable segment, verify every segment expected for the source/window exists, and mark the window complete. On all other exits, return/throw with the window left partial.

- [ ] **Step 8: Run real FFmpeg tests, typecheck, and targeted lint**

```powershell
npm test -- --run tests/transcode-process-runner.test.ts tests/transcode-window-encoder.test.ts tests/transcode-cache.test.ts tests/transcode-catalog.test.ts
npm run typecheck
npx eslint packages/server/src/transcode/process-runner.ts packages/server/src/transcode/window-encoder.ts tests/transcode-window-encoder.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add packages/server/src/transcode/window-encoder.ts packages/server/src/transcode/process-runner.ts packages/server/src/transcode/cache.ts packages/server/src/transcode/types.ts packages/server/src/index.ts tests/transcode-window-encoder.test.ts
git commit -m "Encode demand-paged HLS windows"
```

---

### Task 12: Coordinate One TV, One FFmpeg Process, Seeking, and Prefetch

**Files:**
- Create: `packages/server/src/transcode/coordinator.ts`
- Modify: `packages/server/src/transcode/types.ts`
- Modify: `packages/server/src/index.ts`
- Test: `tests/transcode-coordinator.test.ts`

**Interfaces:**
- Consumes: source authorizer, source gateway, probe service, catalog, cache, window encoder, manifest renderer, clock/timer injection, and configuration.
- Produces:

```ts
export interface TranscodePlaybackSession {
  id: string;
  binding: TranscodeSourceBinding;
  cacheKey: string;
  probe: MediaProbe;
  profile: TranscodeProfile;
  expiresAt: number;
}

export interface TranscodeCoordinator {
  createSession(source: AuthorizedTranscodeSource): Promise<TranscodePlaybackSession>;
  session(sessionId: string): TranscodePlaybackSession | null;
  heartbeat(sessionId: string, deviceId: string): void;
  segment(sessionId: string, segmentIndex: number, signal: AbortSignal): Promise<TranscodeSegmentFile>;
  release(sessionId: string, deviceId: string): Promise<void>;
  diagnostic(): TranscodeDiagnosticSnapshot;
  close(): Promise<void>;
}
```

- [ ] **Step 1: Write failing lease and busy tests**

Use fake timers and deterministic IDs. Assert:

- the first approved TV acquires a 45-second lease;
- another session for the same device and item reuses the active session;
- changing items on the same device replaces the session and cancels obsolete speculative work;
- another device receives `TRANSCODER_BUSY` while the lease is live;
- heartbeat, manifest access, and segment access renew the lease;
- no activity for 45 seconds expires the session and cancels active work; and
- direct-media callers not requesting HLS never consult the coordinator.

- [ ] **Step 2: Write failing scheduling and deduplication tests**

With a fake encoder exposing deferred window promises, assert:

- 20 callers for segment 6 start exactly one window-1 job;
- a segment request resolves as soon as that segment is promoted, not after the window promise completes;
- after demanded window 0 completes, window 1 starts as speculative prefetch;
- a demand for window 4 cancels speculative window 1 and starts window 4;
- an active demanded window is not cancelled merely because another waiter disconnects;
- a fully cached segment starts no process;
- window completion never creates a second FFmpeg process concurrently; and
- all waiter disconnects make an otherwise speculative/obsolete job cancellable.

- [ ] **Step 3: Write failing cache and shutdown tests**

Assert active-session assets are pinned, served segments remain pinned until their stream closes, cache eviction runs before a new encode, and `close()` rejects new sessions, aborts the process, resolves/rejects all waiters deterministically, releases pins, and drains to zero active processes.

- [ ] **Step 4: Run focused tests to verify RED**

```powershell
npm test -- --run tests/transcode-coordinator.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 5: Implement session creation and probe reuse**

`createSession` accepts only `AuthorizedTranscodeSource` produced from the current media request. Compute the cache key, acquire or replace the one-device lease, consult catalog probe metadata, and if missing:

1. reserve the global process slot;
2. issue a source grant;
3. run FFprobe;
4. persist the probe and segment count; and
5. release the grant and process slot.

If another device owns the live lease, fail before FFprobe. Return a random 32-byte base64url session ID and a 45-second expiry.

- [ ] **Step 6: Implement one global process scheduler and segment waiters**

Maintain one explicit `activeJob` union:

```ts
type ActiveJob =
  | { kind: "probe"; sessionId: string; controller: AbortController }
  | { kind: "window"; sessionId: string; cacheKey: string; windowIndex: number; priority: "demand" | "prefetch"; controller: AbortController };
```

Never call the probe or encoder while `activeJob` is non-null. Keep waiter sets keyed by `cacheKey:segmentIndex`. Recheck the cache after registering a waiter to close the promotion race. A promotion event resolves only the matching segment waiters.

- [ ] **Step 7: Implement demanded-window priority and one-window prefetch**

On a missing segment:

- mark its window demanded;
- if an identical job is active, join it;
- if a prefetch for another window is active and has no demanded waiter, abort it;
- otherwise queue the demanded window ahead of every prefetch; and
- start it as soon as the process slot is free.

After a demanded window completes, queue only the immediately following window if it exists, is incomplete, and no demanded work is queued. Never prefetch more than one window.

- [ ] **Step 8: Implement expiry, release, diagnostics, and shutdown**

Sweep leases on activity and a 5-second timer. `release` requires the matching device ID. Session replacement/release/expiry aborts speculative work immediately and demanded work once no HTTP waiter remains. Diagnostics expose only safe fields:

```ts
export interface TranscodeDiagnosticSnapshot {
  active: null | {
    sessionIdSuffix: string;
    itemName: string;
    provider: ProviderKind;
    stage: "probing" | "encoding";
    windowIndex: number | null;
    progressPercent: number | null;
    speed: string | null;
  };
  leaseDeviceName: string | null;
  queuedDemandedWindows: number;
  busyRejections: number;
  cacheBytes: number;
  lastErrorCode: TranscodeErrorCode | null;
}
```

Do not expose full session IDs, provider node IDs, cache keys, URLs, or stderr.

- [ ] **Step 9: Run focused tests and typecheck**

```powershell
npm test -- --run tests/transcode-coordinator.test.ts tests/transcode-window-encoder.test.ts tests/transcode-probe.test.ts
npm run typecheck
```

Expected: PASS and the concurrency assertion never observes more than one active child-process job.

- [ ] **Step 10: Commit**

```powershell
git add packages/server/src/transcode/coordinator.ts packages/server/src/transcode/types.ts packages/server/src/index.ts tests/transcode-coordinator.test.ts
git commit -m "Coordinate one active TV transcode"
```

---

### Task 13: Expose Authenticated HLS Routes and Select HLS at Media Vending

**Files:**
- Create: `packages/server/src/http/transcode-app.ts`
- Modify: `packages/server/src/services/direct-media.ts`
- Modify: `packages/server/src/http/control-app.ts`
- Modify: `packages/server/src/http/self-hosted-app.ts`
- Modify: `packages/server/src/runtime/self-hosted-composition.ts`
- Modify: `deploy/server-entry.ts`
- Modify: `deploy/api-entry.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `tests/direct-media.test.ts`
- Modify: `tests/control-http-app.test.ts`
- Modify: `tests/self-hosted-app.test.ts`
- Test: `tests/transcode-http.test.ts`

**Interfaces:**
- Consumes: `TranscodeCoordinator`, `TranscodeSourceAuthorizer`, existing `protectedDevice` semantics, browse authorization, and direct media resolver.
- Produces:
  - `HlsMediaSourceResponse`
  - `DirectMediaService.media(auth, handle, options?: { forceHls?: boolean }): Promise<DirectMediaResponse>`
  - `createTranscodeApiApp(dependencies): (request: Request) => Promise<Response | null>`

- [ ] **Step 1: Write failing shared-contract and direct-media selection tests**

Add:

```ts
export interface HlsMediaSourceResponse {
  itemId: string;
  kind: "video";
  transport: "hls";
  playlistUrl: string;
  playbackSessionId: string;
  durationSeconds: number;
  profile: "h264-aac-1080p-v1";
  expiresAt: string;
  revision: string | null;
}

export type DirectMediaUrlResponse =
  | DirectProviderMediaUrlResponse
  | GoogleBearerMediaUrlResponse
  | HlsMediaSourceResponse;
```

Test that images always stay direct, MP4 stays direct, `video/mpeg` and `.mpg`/`.mpeg`/`.dat` create HLS, and `forceHls: true` creates HLS for another video type. `forceHls` on an image or folder returns `INVALID_MEDIA_REQUEST`/`ITEM_NOT_FOUND` without creating a session.

Assert HLS session creation occurs only when `media()` is actually called for that item; no browse/list/thumbnail call can acquire a lease.

- [ ] **Step 2: Write failing control endpoint tests**

Change the request body contract to exact keys `handle` and optional `fallback`:

```json
{ "handle": "sealed-item", "fallback": "hls" }
```

Reject unknown fallback values and extra keys. Test known MPEG without fallback returns HLS. Test a normal MP4 with no fallback returns direct, and the same request with `fallback: "hls"` returns HLS. Preserve URL-vending rate limits and no-store headers.

- [ ] **Step 3: Write failing HLS route authorization tests**

Cover:

- authenticated master and media playlist responses;
- `Content-Type: application/vnd.apple.mpegurl`, `Cache-Control: private, no-store`, and credentialed same-origin policy;
- segment streaming with `video/mp2t`, exact length, private bounded cache headers, and cache pin release when the body closes;
- heartbeat `POST` and release `DELETE` with origin/CSRF-equivalent same-origin validation appropriate to a device cookie;
- wrong device, revoked device, removed root, rotated credential, stale revision, expired session, invalid numeric index, path traversal, unsupported method, and unknown route;
- `TRANSCODER_BUSY` -> `409` with retry information;
- cache full -> `507`;
- timeout -> `504`;
- source unavailable -> `503`; and
- all other stable transcoder codes mapped without stderr or path leakage.

- [ ] **Step 4: Run focused tests to verify RED**

```powershell
npm test -- --run tests/direct-media.test.ts tests/control-http-app.test.ts tests/transcode-http.test.ts tests/self-hosted-app.test.ts
```

Expected: FAIL because HLS descriptors and routes do not exist.

- [ ] **Step 5: Add HLS selection to direct media**

Add `transcodes` and `sourceAuthorizer` dependencies. After `browse.authorizeHandle`:

```ts
const useHls = item.claims.kind === "video" &&
  (options.forceHls === true || isLegacyMpeg({ name: item.claims.name, mimeType: item.claims.mimeType }));
```

Move `isLegacyMpeg` to `packages/shared/src/media.ts`, export it from `packages/shared/src/index.ts`, and use it from both server and TV.

For HLS, call `sourceAuthorizer.bind(auth, item)` then `coordinator.createSession`. Encode only same-origin relative playlist URLs:

```ts
return {
  itemId: item.id,
  kind: "video",
  transport: "hls",
  playlistUrl: `/api/tv/transcodes/${session.id}/master.m3u8`,
  playbackSessionId: session.id,
  durationSeconds: session.probe.durationMs / 1000,
  profile: session.profile.id,
  expiresAt: new Date(session.expiresAt).toISOString(),
  revision: item.claims.contentRevision,
  responseHeaders: RESPONSE_HEADERS
};
```

- [ ] **Step 6: Extend the media request body without weakening validation**

Accept exactly `fallback?: "hls"`. Pass `{ forceHls: body.fallback === "hls" }` to direct media. Add transcode errors to `normalizeHttpError` with the exact status mapping above. Keep the route template `/api/tv/media-url` and secret-safe logging.

- [ ] **Step 7: Implement authenticated manifest, segment, heartbeat, and release routes**

`createTranscodeApiApp` returns `null` for non-transcode paths. For every matched route:

1. load one control request context;
2. authenticate the current device;
3. fetch the in-memory playback session;
4. call `sourceAuthorizer.validateCurrent(device, session.binding)`;
5. require `device.deviceId === session.binding.deviceId`; and
6. only then touch the coordinator or cache.

For segments, call `coordinator.segment(sessionId, index, request.signal)`, open the validated file as a Web stream, pin before open, and release the pin in stream `cancel`/`close`/EOF cleanup. Do not implement HTTP range over individual `.ts` files; return the complete small segment.

For heartbeat and release, require `Origin` exactly equal to configured `APP_ORIGIN`; reject missing/mismatched origin. Return `204` with no body.

Until Task 18 deletes `deploy/api-entry.ts`, keep the old Vercel composition compiling with an injected `DisabledTranscodeCoordinator` whose session-creation method throws `TRANSCODER_UNSUPPORTED`. This temporary adapter exists only for compilation/tests and must never silently proxy or transcode media on Vercel.

- [ ] **Step 8: Wire the transcode application into the composition**

Construct the catalog, cache reconciliation, source authorizer, loopback gateway, process runner, probe, encoder, coordinator, and transcode app during startup. Start the internal gateway before readiness. On close, drain in this order:

1. coordinator;
2. source gateway;
3. tracked deferred tasks;
4. WAL checkpoint; and
5. SQLite close.

- [ ] **Step 9: Run focused tests, typecheck, and server build**

```powershell
npm test -- --run tests/direct-media.test.ts tests/control-http-app.test.ts tests/transcode-http.test.ts tests/self-hosted-app.test.ts tests/self-hosted-composition.test.ts
npm run typecheck
npm run build:server
```

Expected: PASS.

- [ ] **Step 10: Commit**

```powershell
git add packages/server/src/http/transcode-app.ts packages/server/src/services/direct-media.ts packages/server/src/http/control-app.ts packages/server/src/http/self-hosted-app.ts packages/server/src/runtime/self-hosted-composition.ts deploy/server-entry.ts deploy/api-entry.ts packages/shared/src/api.ts packages/shared/src/media.ts packages/shared/src/index.ts packages/server/src/index.ts tests/direct-media.test.ts tests/control-http-app.test.ts tests/self-hosted-app.test.ts tests/transcode-http.test.ts
git commit -m "Serve authenticated HLS playback"
```

---

### Task 14: Extend TV Media State for Active-Only HLS Sessions

**Files:**
- Modify: `apps/tv/src/api/media-response.ts`
- Modify: `apps/tv/src/api/media-response.test.ts`
- Modify: `apps/tv/src/api/client.ts`
- Modify: `packages/tv-core/src/viewer.ts`
- Modify: `tests/viewer-state.test.ts`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `e2e/fixtures.ts`

**Interfaces:**
- Consumes: `HlsMediaSourceResponse`, existing direct/Google response decoders, and viewer URL/retry state.
- Produces:
  - strict HLS descriptor decoding;
  - `TvApi.mediaUrl(..., options?: { fallback?: "hls" })`;
  - `TvApi.heartbeatTranscode(sessionId, signal?)`;
  - `TvApi.releaseTranscode(sessionId, signal?)`;
  - viewer source state for `sourceKind: "hls"` and `playbackSessionId`;
  - active video plus adjacent-image URL request selection.

- [ ] **Step 1: Write failing strict HLS decoder tests**

Accept only this exact shape:

```ts
const hls = {
  itemId: "item_video",
  kind: "video",
  transport: "hls",
  playlistUrl: "/api/tv/transcodes/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/master.m3u8",
  playbackSessionId: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  durationSeconds: 65.832,
  profile: "h264-aac-1080p-v1",
  expiresAt,
  revision: "revision-7"
};
expect(decodeDirectMediaUrlResponse(hls, { itemId: "item_video", kind: "video" })).toEqual(hls);
```

Reject absolute/cross-origin/protocol-relative playlist URLs, encoded slashes, query/fragment, mismatched session ID, image kind, unsupported profile, zero/NaN/>24-hour duration, expired timestamps, extra fields, access tokens, and invalid session characters.

- [ ] **Step 2: Write failing TV API endpoint tests**

Create `apps/tv/src/api/client.test.ts` and assert:

```ts
await api.mediaUrl("sealed", signal, expected, { fallback: "hls" });
expect(fetcher).toHaveBeenCalledWith("/api/tv/media-url", expect.objectContaining({
  body: JSON.stringify({ handle: "sealed", fallback: "hls" })
}));

await api.heartbeatTranscode(sessionId);
expect(lastRequest).toMatchObject({ method: "POST", url: `/api/tv/transcodes/${sessionId}/heartbeat` });

await api.releaseTranscode(sessionId);
expect(lastRequest).toMatchObject({ method: "DELETE", url: `/api/tv/transcodes/${sessionId}` });
```

Both mutation helpers send `credentials: "include"`, `Origin` is browser supplied rather than forged by application code, and `204` is accepted without JSON parsing.

- [ ] **Step 3: Write failing active-only URL-window tests**

Update `tests/viewer-state.test.ts` so an active video requests its URL, adjacent images may request URLs, and adjacent videos do not:

```ts
const state = createViewerState([
  video("before-video"),
  image("before-image"),
  video("active-video"),
  image("after-image"),
  video("after-video")
], "active-video");

expect(pendingViewerUrlRequests(state).map(request => request.nodeId).sort())
  .toEqual(["active-video", "after-image", "before-image"]);
```

Navigate to `after-video` and assert it receives a new active request then. Remove or rewrite the existing prefetched-video renewal test so it verifies sampling/renewal only after the video becomes active.

Add reducer tests for an HLS-ready action preserving session ID, excluding HLS from static URL expiry scheduling, and clearing the prior session when navigating or replacing a source.

- [ ] **Step 4: Run focused tests to verify RED**

```powershell
npm test -- --run apps/tv/src/api/media-response.test.ts tests/viewer-state.test.ts apps/tv/src/components/viewer.test.tsx
```

Expected: FAIL because the HLS decoder/state and active-only selection do not exist.

- [ ] **Step 5: Implement strict HLS response decoding and API helpers**

Extend `decodeDirectMediaUrlResponse` without weakening direct/Google validation. Validate the playlist with one regex assembled from the already validated session ID:

```ts
const SESSION = /^[A-Za-z0-9_-]{43}$/u;
const expectedPath = `/api/tv/transcodes/${sessionId}/master.m3u8`;
```

Require `playlistUrl === expectedPath`. Validate duration as finite `> 0` and `<= 86_400`. Add a `requestNoContent` helper for heartbeat/release that rejects non-204 success bodies and decodes normal JSON errors on failure.

- [ ] **Step 6: Extend viewer state without conflating session and URL expiry**

Change:

```ts
export type ViewerMediaSourceKind = "direct" | "google-raw" | "hls";
```

Add optional `playbackSessionId` to `ViewerUrlState` and `url-ready`. Require it only for `sourceKind: "hls"`; clear it for every other source. Keep HLS release as a viewer-owned side effect and do not add a reducer action for network cleanup.

Replace `withUrlWindow` with a selector that keeps:

- the active item regardless of kind; and
- adjacent items only when their kind is `image`.

Existing loaded adjacent video URL state may be dropped during navigation. This deliberately prevents a background MPEG item from acquiring the only transcoder lease.

- [ ] **Step 7: Update fixtures and focused viewer tests**

Teach the E2E fixture API to return a valid HLS descriptor when called with `{ fallback: "hls" }`, and record heartbeat/release calls. Keep its default MP4 response direct. Update viewer mocks to implement the two new API methods.

Run:

```powershell
npm test -- --run apps/tv/src/api/media-response.test.ts tests/viewer-state.test.ts apps/tv/src/components/viewer.test.tsx apps/tv/src/app.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add apps/tv/src/api/media-response.ts apps/tv/src/api/media-response.test.ts apps/tv/src/api/client.ts packages/tv-core/src/viewer.ts tests/viewer-state.test.ts apps/tv/src/components/viewer.test.tsx e2e/fixtures.ts
git commit -m "Add HLS media state to the TV"
```

---

### Task 15: Use the Real Video.js 10 Skin and Attach Native HLS or hls.js

**Files:**
- Create: `apps/tv/src/media/hls-playback.ts`
- Create: `apps/tv/src/media/hls-playback.test.ts`
- Modify: `apps/tv/package.json`
- Modify: `package-lock.json`
- Modify: `apps/tv/src/videojs.ts`
- Modify: `apps/tv/src/videojs.test.ts`
- Modify: `apps/tv/src/vite-env.d.ts`
- Modify: `apps/tv/src/components/video-player.tsx`
- Modify: `apps/tv/src/components/viewer.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `apps/tv/src/styles/app.css`
- Modify: `apps/tv/src/media/google-media-protocol.ts`
- Modify: `apps/tv/src/media/google-media-protocol.test.ts`
- Modify: `apps/tv/src/media/google-media-bridge.ts`
- Modify: `apps/tv/src/media/google-media-bridge.test.ts`
- Modify: `apps/tv/src/media/google-media-worker-runtime.ts`
- Modify: `apps/tv/src/media/google-media-worker-runtime.test.ts`
- Modify: `apps/tv/src/media/google-media-worker.ts`
- Modify: `scripts/check-chromium68.mjs`
- Modify: `e2e/browse-viewer.spec.ts`
- Modify: `e2e/fixtures.ts`

**Interfaces:**
- Consumes: HLS viewer state, underlying native video ref/callbacks, `@videojs/html@10.0.0-beta.32`, and hls.js `1.7.1`.
- Produces:

```ts
export type HlsPlaybackMode = "native-hls" | "hls.js";

export interface HlsPlaybackHandle {
  mode: HlsPlaybackMode;
  destroy(): void;
}

export interface AttachHlsSourceOptions {
  onFatal(error: { kind: "network" | "media" | "unsupported" }): void;
  importHls?: () => Promise<typeof import("hls.js")>;
}

export function attachHlsSource(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: AttachHlsSourceOptions
): Promise<HlsPlaybackHandle>;
```

- [ ] **Step 1: Add hls.js as an exact direct dependency**

Run:

```powershell
npm install --save-exact hls.js@1.7.1 -w @cloudframe/tv
```

Expected: `apps/tv/package.json` lists `"hls.js": "1.7.1"`; do not rely on the transitive dependency under `@videojs/media`.

- [ ] **Step 2: Write failing HLS attachment tests**

Use injected fake modules/constructors and assert:

- when `video.canPlayType("application/vnd.apple.mpegurl")` is non-empty, set `video.src`, do not import hls.js, and return `native-hls`;
- otherwise import hls.js, require `Hls.isSupported()`, construct one engine with credentials enabled, attach the existing video, and load the relative playlist only after `MEDIA_ATTACHED`;
- fatal hls.js network/media errors call `onFatal` once and destroy the engine;
- non-fatal errors do not restart/recover in a loop;
- `destroy()` is idempotent and clears `video.src`, calls `video.load()`, and removes listeners; and
- lack of native HLS and MSE reports `{ kind: "unsupported" }` without assigning a source.

The injected hls.js config must contain:

```ts
{
  enableWorker: false,
  xhrSetup(xhr: XMLHttpRequest) {
    xhr.withCredentials = true;
  }
}
```

Disable the hls.js worker for Chromium 68 determinism and because one TV/one stream is the only target.

- [ ] **Step 3: Write failing Video.js skin and fallback tests**

Update the loader test to require registration of `video-player` and `video-skin`. In viewer/component tests assert:

```ts
expect(video.closest("video-skin")?.parentElement?.tagName.toLowerCase()).toBe("video-player");
expect(container.querySelector("media-container")).toBeNull();
```

Mock a successful loader and require the Cloudframe `.video-controls` fallback to be absent and native `controls` to be false. Mock a failed loader and require the same native video to have `controls`, while `.video-controls` remains available for remote-status feedback.

Assert every existing native event callback and ref still observes the same `HTMLVideoElement` after custom-element upgrade. Delete tests for `googleMediaAlias`, `sanitizeMediaFilename`, filename-attempt evidence, and the retired `google-filename` source kind. Narrow `google-media-protocol.ts` to the exact Google URL, fingerprint, bearer grant/message, and Range helpers still consumed by the bridge and worker; move `isLegacyMpeg` to `packages/shared/src/media.ts` in Task 13. Remove alias generation/handling from the bridge, worker runtime, and classic worker so a Google grant exposes only the raw Google source and evidence attempt `google-raw`.

- [ ] **Step 4: Write failing viewer HLS lifecycle and autoplay tests**

Cover:

- known MPEG descriptor arrives as HLS and calls `attachHlsSource` once;
- direct MP4 still sets native `src` and never imports hls.js;
- a confirmed direct video decoder error requests `mediaUrl(handle, ..., { fallback: "hls" })` once and resumes from the saved timestamp;
- HLS failure never falls back to direct MPEG and never asks for HLS twice;
- heartbeat starts every 15 seconds only while the active HLS viewer is mounted and sends one immediate heartbeat after attach;
- navigation, Back, unmount, authorization failure, and replacement call `releaseTranscode` best effort and destroy the HLS handle;
- initial active video state attempts `play()` once after source readiness;
- `NotAllowedError` changes intent to paused, leaves a visible Video.js/native play affordance, and does not show a media error; and
- an actual `video.error` still follows the bounded direct/HLS error path.

- [ ] **Step 5: Run focused tests to verify RED**

```powershell
npm test -- --run apps/tv/src/media/hls-playback.test.ts apps/tv/src/videojs.test.ts apps/tv/src/components/viewer.test.tsx tests/viewer-state.test.ts
```

Expected: FAIL because the skin, HLS engine, heartbeat, and autoplay state do not exist.

- [ ] **Step 6: Register the packaged Video.js skin**

Change the loader importer to:

```ts
await Promise.all([
  import("@videojs/html/video/player"),
  import("@videojs/html/video/skin")
]);
```

Resolve `true` only when `customElements.get("video-player")` and `customElements.get("video-skin")` are both defined. Add `video-skin` to JSX intrinsic elements.

- [ ] **Step 7: Implement native HLS/hls.js attachment**

Validate playlist URLs again as exact same-origin relative transcode paths before use. Native path assigns the playlist to the existing video. hls.js path dynamically imports the exact dependency, verifies `isSupported`, attaches the element, and loads the source after `MEDIA_ATTACHED`.

Handle fatal events once:

```ts
engine.on(Hls.Events.ERROR, (_event, data) => {
  if (!data.fatal || failed) return;
  failed = true;
  options.onFatal({ kind: data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "media" });
  destroy();
});
```

Do not call `startLoad`, `recoverMediaError`, or recreate the engine automatically.

- [ ] **Step 8: Render the real Video.js interface with explicit fallback**

`VideoPlayer` tracks the loader result. Render:

```tsx
<video-player class="cloudframe-video-player">
  <video-skin class="cloudframe-video-skin">
    <video controls={!videoJsReady} ... />
  </video-skin>
</video-player>
```

Do not render a light-DOM `media-container`; the packaged skin owns its container and controls inside its shadow root. Render Cloudframe's status overlay only while `videoJsReady !== true`. Style unknown/upgraded `video-player` and `video-skin` as full-size block elements, but do not target undocumented elements/classes inside the packaged skin. Use only documented skin custom properties for cue color, typography, and scale.

- [ ] **Step 9: Integrate HLS lifecycle, bounded fallback, heartbeat, and autoplay**

In `Viewer`:

- prepare Google bearer only for `google-bearer`;
- pass direct sources as native URLs;
- pass HLS descriptor metadata separately to `VideoPlayer` rather than setting `src` directly;
- release an old Google bridge session and old HLS session independently;
- call `mediaUrl(..., { fallback: "hls" })` exactly once after a delivered direct decoder failure for any video not already HLS;
- remove the retired Google filename-alias retry and `google-filename` viewer state entirely because known MPEG now selects HLS initially;
- start a 15-second heartbeat only for the active HLS session;
- classify heartbeat `401` as device unauthorized and `TRANSCODER_SESSION_EXPIRED` as a stable viewer session error;
- destroy/release on navigation, Back, unmount, and source replacement; and
- set initial playback intent to `play` for an active video.

Add `autoplay-rejected` to the viewer reducer. It sets intent to `pause`, keeps controls visible, and does not create `mediaError`. The normal Enter action then toggles to `play` and retries under a current user gesture.

- [ ] **Step 10: Extend Chromium 68 and browser acceptance**

The Chromium probe must assert that a synthetic HLS descriptor either attaches through bundled hls.js or returns the stable unsupported state, and that forced Video.js skin registration failure still leaves a native `<video controls>` element.

Update the Playwright fixture with same-origin synthetic HLS playlists and segments. In `browse-viewer.spec.ts`, assert the supported browser has an upgraded `video-player` and `video-skin`, the MP4 can play, HLS requests occur only after opening the MPEG item, forward seek requests a later segment, and leaving the viewer records release.

- [ ] **Step 11: Run focused tests, bundle checks, and Playwright**

```powershell
npm test -- --run apps/tv/src/media/hls-playback.test.ts apps/tv/src/videojs.test.ts apps/tv/src/components/viewer.test.tsx tests/viewer-state.test.ts apps/tv/src/api/media-response.test.ts
npm run typecheck
npm run build -w @cloudframe/tv
node scripts/check-tv-bundle.mjs
npm run check:chromium68
npx playwright test e2e/browse-viewer.spec.ts --project=tv-1920
```

Expected: PASS. Do not raise bundle budgets merely because the skin adds chunks; inspect and justify any threshold change with compressed output evidence.

- [ ] **Step 12: Commit**

```powershell
git add apps/tv/package.json package-lock.json apps/tv/src/media/hls-playback.ts apps/tv/src/media/hls-playback.test.ts apps/tv/src/media/google-media-protocol.ts apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/media/google-media-bridge.ts apps/tv/src/media/google-media-bridge.test.ts apps/tv/src/media/google-media-worker-runtime.ts apps/tv/src/media/google-media-worker-runtime.test.ts apps/tv/src/media/google-media-worker.ts apps/tv/src/videojs.ts apps/tv/src/videojs.test.ts apps/tv/src/vite-env.d.ts apps/tv/src/components/video-player.tsx apps/tv/src/components/viewer.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/styles/app.css packages/tv-core/src/viewer.ts tests/viewer-state.test.ts scripts/check-chromium68.mjs e2e/browse-viewer.spec.ts e2e/fixtures.ts
git commit -m "Use Video.js for direct and HLS playback"
```

---

### Task 16: Add Protected Transcode Diagnostics to Admin

**Files:**
- Create: `apps/admin/src/components/transcode-diagnostics.tsx`
- Create: `apps/admin/src/components/transcode-diagnostics.test.tsx`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/server/src/http/transcode-app.ts`
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/api/client.test.ts`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/app.test.tsx`
- Modify: `apps/admin/src/components/settings.tsx`
- Modify: `apps/admin/src/styles/app.css`
- Modify: `e2e/fixtures.ts`
- Modify: `e2e/source-workbench.spec.ts`
- Modify: `tests/transcode-http.test.ts`

**Interfaces:**
- Consumes: `TranscodeCoordinator.diagnostic()`, current admin authentication/CSRF refresh headers, and the Settings surface.
- Produces:

```ts
export interface TranscodeDiagnosticResponse {
  active: null | {
    itemName: string;
    provider: ProviderKind;
    stage: "probing" | "encoding";
    windowIndex: number | null;
    progressPercent: number | null;
    speed: string | null;
  };
  leaseDeviceName: string | null;
  queuedDemandedWindows: number;
  busyRejections: number;
  cacheBytes: number;
  cacheMaxBytes: number;
  lastErrorCode: string | null;
}
```

- [ ] **Step 1: Write failing protected endpoint tests**

Add `GET /api/admin/transcodes/status`. Assert unauthenticated callers receive `401`; authenticated callers receive the exact strict DTO and refreshed CSRF header. Assert the JSON does not contain full session ID, provider node ID, source URL, cache key, capability, stderr, cookie, bearer, or signed query values.

- [ ] **Step 2: Write failing admin client and component tests**

Add `AdminApi.transcodeStatus()`. Strictly decode the response with bounded item names, enum provider/stage, finite percentage `0..100`, bounded speed string, non-negative safe integer counts/bytes, and bounded uppercase error code.

Render four states in `TranscodeDiagnostics`:

- idle: `Transcoder ready`;
- probing/encoding: item, provider, device, stage, progress/speed, and current window;
- busy/error: safe counts and error code mapped to human copy; and
- cache: used/max formatted in binary units.

Assert no session/capability/raw URL surface exists and the component contains no focusable controls.

- [ ] **Step 3: Run focused tests to verify RED**

```powershell
npm test -- --run tests/transcode-http.test.ts apps/admin/src/api/client.test.ts apps/admin/src/components/transcode-diagnostics.test.tsx apps/admin/src/app.test.tsx
```

Expected: FAIL because the protected diagnostics route/client/component do not exist.

- [ ] **Step 4: Implement the protected route and strict DTO encoder**

Route admin status before device HLS routes. Load one request context, authenticate the admin, map coordinator diagnostics to the public DTO, omit the internal session suffix, and set `Cache-Control: private, no-store` plus the existing CSRF response header.

- [ ] **Step 5: Implement bounded polling in Settings**

Only mount `TranscodeDiagnostics` when the authenticated admin's active section is `settings`. Poll immediately and every five seconds while visible; abort the prior request on unmount or section change. A failed diagnostic request shows a small local status and does not sign the admin out unless it is `401`.

Preserve the Screening Room Ledger design language: use existing panel, hairline, cue, and typography tokens; do not create a new dashboard visual system. The diagnostics panel is operational truth, not an animated entertainment surface.

- [ ] **Step 6: Update E2E fixtures and acceptance**

Teach the admin fixture API to return idle and active diagnostic snapshots. Add a Settings assertion in an existing admin-wide journey that the status is visible, readable, and not focusable ahead of manual controls.

- [ ] **Step 7: Run focused tests, admin build, and Playwright**

```powershell
npm test -- --run tests/transcode-http.test.ts apps/admin/src/api/client.test.ts apps/admin/src/components/transcode-diagnostics.test.tsx apps/admin/src/app.test.tsx
npm run typecheck
npm run build -w @cloudframe/admin
npx playwright test e2e/source-workbench.spec.ts --project=admin-wide
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/shared/src/api.ts packages/server/src/http/transcode-app.ts apps/admin/src/api/client.ts apps/admin/src/api/client.test.ts apps/admin/src/components/transcode-diagnostics.tsx apps/admin/src/components/transcode-diagnostics.test.tsx apps/admin/src/components/settings.tsx apps/admin/src/app.tsx apps/admin/src/app.test.tsx apps/admin/src/styles/app.css tests/transcode-http.test.ts e2e/fixtures.ts e2e/source-workbench.spec.ts
git commit -m "Show transcoder status in Admin"
```

---

### Task 17: Package the Portable Docker Image and Add a Real Container Smoke Test

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `compose.example.yaml`
- Create: `scripts/container-smoke.mjs`
- Modify: `package.json`
- Modify: `tests/config.test.ts`
- Modify: `tests/e2e-config.test.ts`
- Test: `tests/container-contract.test.ts`

**Interfaces:**
- Consumes: `npm run build:server`, self-hosted entry point, `/healthz`, `/readyz`, first-run API, committed MPEG fixture, and Docker CLI.
- Produces:
  - reproducible `linux/amd64` production image;
  - portable Compose contract; and
  - `npm run test:container` end-to-end smoke command.

- [ ] **Step 1: Write failing static container-contract tests**

Create `tests/container-contract.test.ts` and assert the Dockerfile contains:

- a pinned Node 24 build stage and Node 24 slim runtime stage;
- `npm ci` before copying full source;
- `npm run build:server`;
- installation of `ffmpeg`, `ca-certificates`, and `tini`;
- an unprivileged `USER`;
- `WORKDIR /app`;
- `VOLUME ["/data"]`;
- `EXPOSE 8080` only;
- `ENTRYPOINT ["/usr/bin/tini", "--"]`;
- `CMD ["node", "server/index.js"]`; and
- no `Horizon`, IP address, domain, Nginx, Certbot, Cloudflare, Vercel token, provider credential, or copied `.env`.

Assert `.dockerignore` excludes `.git`, `.vercel`, `.next`, `node_modules`, `build`, `dist`, `.env*`, `/data`, `.cache`, test results, worktrees, and local design artifacts while allowing `.env.example` only as documentation.

Assert the Compose example binds `127.0.0.1:8080:8080`, mounts `./cloudframe-data:/data`, uses `restart: unless-stopped`, drops all capabilities, and sets `no-new-privileges` without naming a real registry owner or host.

- [ ] **Step 2: Write the failing container smoke script contract**

Add a test that imports `scripts/container-smoke.mjs` through a testable exported `runContainerSmoke(dependencies)` and verifies the sequence:

```text
docker build --platform linux/amd64
docker run with random localhost port and temporary data volume
wait for /healthz
wait for /readyz
read CLOUDFRAME_SETUP_CODE from logs
claim installation
log in and read local snapshot
restart the same container/volume
prove configured status and login persist
run an injected MPEG/HLS smoke fixture in test mode
send SIGTERM and require clean exit
remove only the temporary container/image/volume created by the script
```

The test mode must be compile-time gated by Docker build argument `CLOUDFRAME_CONTAINER_TEST=1`, forwarded only to the build-stage `npm run build:server`, and supply a server-owned fixture provider plus an admin-protected fixture bootstrap route; ordinary images contain neither.

- [ ] **Step 3: Run contract tests to verify RED**

```powershell
npm test -- --run tests/container-contract.test.ts tests/config.test.ts tests/e2e-config.test.ts
```

Expected: FAIL because Docker delivery does not exist and tests still assert Vercel output.

- [ ] **Step 4: Implement the multi-stage Dockerfile**

Use a Debian slim Node 24 image compatible with `node:sqlite` and the available `@node-rs/argon2` binary. The build stage:

```dockerfile
FROM node:24.5.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/tv/package.json apps/tv/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/tv-core/package.json packages/tv-core/package.json
RUN npm ci
COPY . .
RUN npm run build:server
```

The runtime stage installs only runtime OS packages, creates `cloudframe` UID/GID, copies `build/self-hosted` to `/app`, creates `/data` owned by that user, switches user, and launches `server/index.js` under `tini`. Do not run package installation or a compiler in the runtime stage.

- [ ] **Step 5: Implement the portable Compose example**

Use a placeholder image such as `${CLOUDFRAME_IMAGE:-cloudframe:local}` so the file works with a locally built image and does not prescribe a registry. Include commented optional hardening:

```yaml
# read_only: true
# tmpfs:
#   - /tmp:rw,noexec,nosuid,size=256m
```

Do not include TLS, reverse-proxy, DNS, or host-specific networks.

- [ ] **Step 6: Implement the real smoke runner**

The script creates unique names from a random suffix and records every resource it creates. It always cleans those exact resources in `finally`; no broad Docker prune is allowed.

Add `ARG CLOUDFRAME_CONTAINER_TEST=0` to the Docker build stage and set `ENV CLOUDFRAME_CONTAINER_TEST=$CLOUDFRAME_CONTAINER_TEST` only for the `RUN npm run build:server` layer; do not copy that environment variable into the runtime stage. Add a test-only fixture provider and route behind compile-time build constant `__CLOUDFRAME_CONTAINER_TEST__`. Update `scripts/build-server.mjs` so esbuild defines that constant from `process.env.CLOUDFRAME_CONTAINER_TEST === "1"`.

The test-only route is `POST /api/admin/test-fixture`. It exists only in a smoke build, requires a valid current admin cookie and CSRF token, accepts exactly `{ "fixture": "legacy-mpeg" }`, and transactionally inserts one fixture Google source, root, approved `device-smoke` assigned to that root, plus the server-owned committed MPEG fixture metadata. It returns a device session cookie and the sealed item handle needed by the smoke client.

In a smoke build only, `scripts/build-server.mjs` copies `tests/fixtures/media/legacy-mpeg.mpg` to `build/self-hosted/test-fixtures/legacy-mpeg.mpg`. The composition installs:

- a `ProviderAdapter` for the fixture Google source whose `getNode` returns the exact revision/size and whose `getMediaUrl` returns the normal allowlisted `https://www.googleapis.com/drive/v3/files/fixture-legacy-mpeg?alt=media&supportsAllDrives=true` shape; and
- an injected fetch wrapper that intercepts only that exact URL plus the fixture bearer header and serves the local fixture with correct `HEAD`, single-Range `200`/`206`/`416`, content length/type/range, ETag, and final response URL behavior.

All other URLs use the real injected fetch. The ordinary production bundle must not contain the test route string, fixture adapter/fetch branch, fixture bytes, test-fixtures directory, or `__CLOUDFRAME_CONTAINER_TEST__` marker.

The smoke script runs `docker build --build-arg CLOUDFRAME_CONTAINER_TEST=1` into a unique temporary tag, while `npm run docker:build` builds an ordinary image without the argument. The smoke script then:

- completes claim/login through HTTP;
- calls the admin-protected test fixture route and installs the returned device cookie;
- requests the MPEG media descriptor;
- fetches master/media playlists and segment 0;
- writes the fetched segment bytes to one host temporary file, copies that exact file to `/tmp/cloudframe-smoke-segment.ts` in the temporary container, and invokes `docker exec <temporary-container> ffprobe /tmp/cloudframe-smoke-segment.ts` so the smoke test uses the image's actual FFprobe build;
- restarts the container using the same bind-mounted data directory;
- verifies the installation remains configured; and
- stops the container with a bounded timeout and requires exit code 0.

- [ ] **Step 7: Replace Vercel build assertions with self-hosted/Docker assertions**

Update `tests/config.test.ts` and `tests/e2e-config.test.ts` so they verify `build/self-hosted/public`, one bundled server entry, no public sourcemaps/test hooks, and the Docker contract. Remove assertions about Mumbai region, Build Output API v3, `.vc-config.json`, and `api.func`.

Add root scripts:

```json
{
  "docker:build": "docker build --platform linux/amd64 -t cloudframe:local .",
  "test:container": "node scripts/container-smoke.mjs"
}
```

- [ ] **Step 8: Run container contract, build, and smoke tests**

```powershell
npm test -- --run tests/container-contract.test.ts tests/config.test.ts tests/e2e-config.test.ts
npm run build:server
npm run docker:build
npm run test:container
```

Expected: PASS. Record image size, container user, exposed port, FFmpeg version, and smoke timings in the task notes; do not make them hard-coded product promises.

- [ ] **Step 9: Commit**

```powershell
git add Dockerfile .dockerignore compose.example.yaml scripts/container-smoke.mjs scripts/build-server.mjs package.json tests/container-contract.test.ts tests/config.test.ts tests/e2e-config.test.ts
git commit -m "Package Cloudframe as a Docker service"
```

---

### Task 18: Remove Active Vercel and Firestore Runtime Code

**Files:**
- Delete: `vercel.json`
- Delete: `.firebaserc`
- Delete: `firebase.json`
- Delete: `firestore.indexes.json`
- Delete: `firestore.rules`
- Delete: `deploy/api-entry.ts`
- Delete: `deploy/vercel-build-contract.json`
- Delete: `scripts/build-vercel.mjs`
- Delete: `scripts/seed-dev.mjs`
- Delete: `scripts/migrate-vercel-control-plane.ts`
- Delete: `scripts/restore-vercel-control-plane.ts`
- Delete: `scripts/lib/control-plane-ops.ts`
- Delete: `packages/server/src/control-plane/vercel-blob.ts`
- Delete: `packages/server/src/control-plane/runtime-cache.ts`
- Delete: `packages/server/src/control-plane/firestore-mirror.ts`
- Delete: `packages/server/src/firestore/client.ts`
- Delete: `tests/firestore-budget.test.ts`
- Delete: `tests/firestore-mirror.test.ts`
- Delete: `tests/control-plane-ops.test.ts`
- Delete: `tests/ops-scripts.test.ts`
- Delete: `tests/control-plane-store.test.ts`
- Create: `tests/tv-compatibility-scripts.test.ts`
- Modify: `packages/server/src/control-plane/store.ts`
- Modify: `packages/server/src/control-plane/memory.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.env.example`
- Modify: `tests/production-composition.test.ts`
- Modify: `tests/workspace.test.ts`
- Modify: `tests/post-cutover-cleanup.test.ts`
- Modify: `tests/helpers/api.ts`
- Modify: `tests/control-admin.test.ts`
- Modify: `tests/control-auth.test.ts`
- Modify: `tests/control-enrollment.test.ts`
- Modify: `tests/control-http-app.test.ts`
- Modify: `tests/control-oauth.test.ts`
- Modify: `tests/credential-broker.test.ts`
- Modify: `tests/live-browse.test.ts`
- Modify: `tests/live-provider-folders.test.ts`
- Modify: `tests/runtime-rate-limit.test.ts`

**Interfaces:**
- Consumes: completed SQLite store/runtime/cache/composition and container tests.
- Produces: no active dependency or source import for `@vercel/blob`, `@vercel/functions`, `@vercel/oidc`, or `@google-cloud/firestore`.

- [ ] **Step 1: Write failing post-cutover inventory tests**

Update `tests/post-cutover-cleanup.test.ts` to scan active source, package manifests, build scripts, Docker context, and environment documentation. Require no matches for:

```text
@vercel/blob
@vercel/functions
@vercel/oidc
@google-cloud/firestore
createVercelBlobControlStore
createVercelRuntimeControlCache
createFirestoreRecoveryMirror
requestOidcTokenSupplier
build:vercel
BLOB_STORE_ID
FIRESTORE_PROJECT_ID
GCP_WORKLOAD_IDENTITY_PROVIDER
```

Historical specs/plans under `docs/superpowers/**` are excluded from the active-runtime scan and remain in git as history.

Require `package-lock.json` to contain none of those packages after `npm install --package-lock-only`/`npm install` updates.

- [ ] **Step 2: Rewrite control-store tests for the surviving abstraction**

The old `control-plane/store.ts` CAS/cache/mirror implementation is retired. Move validated cloning, exact revision increment, invalid document rollback, and secret-safe telemetry assertions to `tests/sqlite-control-store.test.ts`. Delete `tests/control-plane-store.test.ts` after those named assertions pass in the SQLite suite.

Update `packages/server/src/control-plane/memory.ts` into a simple in-memory `ControlPlaneStore` test harness with no `ControlDurableStore`, `ControlHotCache`, `RecoveryMirror`, or remote ETag semantics. Preserve only APIs still used by unit tests:

```ts
export function controlStoreHarness(document: ControlPlaneDocumentV2): {
  store: ControlPlaneStore;
  current(): ControlPlaneDocumentV2;
  replace(document: ControlPlaneDocumentV2): void;
}
```

Update `tests/helpers/api.ts` to use that simple in-memory store plus `createExpiringMemoryCache`; remove `FirestoreSentinel`, durable/cache ETag counters, conditional-read assertions, mirror counters, and `firestoreReads`. Update the listed service/API tests to assert observable state and mutation counts instead of Blob/cache/Firestore implementation details. Preserve their authorization, replay, refresh, revocation, request-context, and no-secret-leak coverage.

Keep the generic TV bundle/Chromium harness tests currently located after the Vercel migration assertions in `tests/ops-scripts.test.ts`: move them to `tests/tv-compatibility-scripts.test.ts` before deleting `tests/ops-scripts.test.ts`.

- [ ] **Step 3: Run the inventory tests to verify RED**

```powershell
npm test -- --run tests/post-cutover-cleanup.test.ts tests/workspace.test.ts tests/production-composition.test.ts tests/sqlite-control-store.test.ts
```

Expected: FAIL because Vercel/Firestore source and packages still exist.

- [ ] **Step 4: Delete retired platform adapters and operator scripts**

Delete only the files listed in this task. Remove their exports. Remove root and server package dependencies on the four retired packages. Run:

```powershell
npm install --package-lock-only
npm install
```

Do not delete Firebase projects, Vercel projects, Blob data, Firestore data, DNS records, local `.firebase`, or historical docs as a side effect.

Replace `.env.example` in this same step with the exact self-hosted runtime variables: `APP_ORIGIN`, `PORT`, optional `DATA_DIR`, optional Google pair, optional OneDrive pair and tenant, `TRANSCODE_CACHE_MAX_BYTES`, `TRANSCODE_CACHE_MIN_FREE_BYTES`, `TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS`, `TRANSCODE_THREADS`, and `LOG_LEVEL`. It must contain no generated master/application key, passphrase, Vercel, Blob, Firestore, or GCP variable.

- [ ] **Step 5: Simplify surviving test harnesses and composition tests**

Rename `tests/production-composition.test.ts` describe block to `self-hosted production composition` and assert local keys, SQLite, configured provider injection, setup-code emission, one public/one loopback listener, and orderly close. Remove Vercel/GCP environment fixtures.

Update `tests/workspace.test.ts` to require:

- separate TV/admin applications;
- self-hosted server entry;
- no Vercel build/runtime files;
- no dormant indexing/workflow packages;
- direct Google playback for compatible media; and
- HLS transcoding for incompatible media.

- [ ] **Step 6: Run removal tests and dependency audit**

```powershell
npm test -- --run tests/post-cutover-cleanup.test.ts tests/workspace.test.ts tests/production-composition.test.ts tests/sqlite-control-store.test.ts
npm ls @vercel/blob @vercel/functions @vercel/oidc @google-cloud/firestore --all
rg -n '@vercel|@google-cloud/firestore|VERCEL_|BLOB_STORE_ID|FIRESTORE_|GCP_' packages deploy scripts package.json packages/server/package.json .env.example
```

Expected:

- tests PASS;
- `npm ls` reports no installed retired package;
- `rg` returns no active match.

- [ ] **Step 7: Run full unit tests and typecheck before commit**

```powershell
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add -u -- vercel.json .firebaserc firebase.json firestore.indexes.json firestore.rules deploy/api-entry.ts deploy/vercel-build-contract.json scripts/build-vercel.mjs scripts/seed-dev.mjs scripts/migrate-vercel-control-plane.ts scripts/restore-vercel-control-plane.ts scripts/lib/control-plane-ops.ts packages/server/src/control-plane/vercel-blob.ts packages/server/src/control-plane/runtime-cache.ts packages/server/src/control-plane/firestore-mirror.ts packages/server/src/firestore/client.ts tests/firestore-budget.test.ts tests/firestore-mirror.test.ts tests/control-plane-ops.test.ts tests/ops-scripts.test.ts tests/control-plane-store.test.ts
git add package.json package-lock.json packages/server/package.json .env.example packages/server/src/control-plane/store.ts packages/server/src/control-plane/memory.ts packages/server/src/index.ts tests/production-composition.test.ts tests/workspace.test.ts tests/post-cutover-cleanup.test.ts tests/tv-compatibility-scripts.test.ts tests/helpers/api.ts tests/control-admin.test.ts tests/control-auth.test.ts tests/control-enrollment.test.ts tests/control-http-app.test.ts tests/control-oauth.test.ts tests/credential-broker.test.ts tests/live-browse.test.ts tests/live-provider-folders.test.ts tests/runtime-rate-limit.test.ts
git commit -m "Remove the Vercel control plane runtime"
```

---

### Task 19: Update Product and Self-Hosting Documentation

**Files:**
- Create: `docs/operations/self-hosting.md`
- Modify: `README.md`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `docs/operations/webos-acceptance.md`
- Delete: `docs/operations/firebase-vercel-setup.md`
- Modify: `tests/design-materials.test.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: final runtime, container, API, storage, backup, and player behavior.
- Produces: active documentation that describes only the self-hosted runtime while retaining historical specs/plans separately.

- [ ] **Step 1: Write failing documentation-contract tests**

Update `tests/design-materials.test.ts` active-document paths and require these exact current concepts:

```text
portable Docker image
encrypted local SQLite
/data
one active TV transcode
FFmpeg
demand-paged HLS
browser-side authenticated direct delivery
read-only Google Drive and OneDrive
local TV watch history
explicit backup
```

Reject current-tense claims for:

```text
private Vercel Blob
Vercel Runtime Cache
Firestore recovery mirror
zero steady-state Firestore reads
Mumbai API function
build:vercel
Vercel streams
Cloudframe does not transcode
```

Historical `docs/superpowers/**` files are not part of this current-document aggregation.

- [ ] **Step 2: Run documentation tests to verify RED**

```powershell
npm test -- --run tests/design-materials.test.ts tests/config.test.ts
```

Expected: FAIL because active docs still describe Vercel.

- [ ] **Step 3: Write the self-hosting operations guide**

`docs/operations/self-hosting.md` must include exact sections for:

1. prerequisites: Docker/Compose, HTTPS reverse proxy, OAuth applications;
2. build or pull image without prescribing a registry;
3. environment variables and exact provider callback URLs;
4. `/data` ownership and permissions;
5. first boot and `CLOUDFRAME_SETUP_CODE` claim;
6. connecting providers and pairing a TV;
7. health/readiness endpoints;
8. one-TV/one-FFmpeg behavior and busy response;
9. cache size/free-space settings and eviction;
10. backup and restore of the complete stopped `/data` volume;
11. transactional schema upgrades and automatic local backups;
12. graceful upgrade/rollback procedure using immutable image tags;
13. reverse-proxy requirements for long HLS segment waits, streaming, and cookies;
14. JSON logs and safe diagnostics;
15. complete uninstall versus container replacement; and
16. explicit statement that external Vercel/Firebase cleanup is manual and outside this repository run.

Do not include Horizon, a real IP/domain, or a provider secret.

- [ ] **Step 4: Rewrite active product, design, README, and environment truth**

- `README.md`: Docker-first local setup, build/test commands, first-run, storage, direct/HLS media boundary, and no Vercel runtime.
- `PRODUCT.md`: self-hosted single-household product model, encrypted local control state, one active transcode, and factual privacy wording that cached compatible segments may be stored under `/data`.
- `DESIGN.md`: replace Vercel/recovery-copy visible truth with local-storage/transcoder truth while preserving the existing Screening Room Ledger visual system.
- `.env.example`: review the self-hosted contract committed in Task 18 for consistency; do not add master key, passphrase, application-secret, or retired platform variables.

- [ ] **Step 5: Extend the webOS acceptance checklist**

Add a fresh-install and player section requiring the operator to verify:

- admin claim and provider reconnect from an empty `/data`;
- TV pairing;
- direct H.264 MP4 playback with the real Video.js skin;
- `MOV00516.MPG` or another known MPEG source uses HLS and begins playback;
- seek at least 60 seconds beyond generated media for a long source;
- pause/resume and Back;
- one-TV busy behavior using a second browser/device session;
- resume history;
- source removal/revocation stops subsequent HLS requests;
- container restart between sessions preserves configuration and cache;
- no OAuth token/provider URL appears in TV/admin UI or logs; and
- direct media remains available when the transcoder is idle/busy as designed.

- [ ] **Step 6: Run documentation, config, and build checks**

```powershell
npm test -- --run tests/design-materials.test.ts tests/config.test.ts tests/workspace.test.ts
npm run build:server
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add README.md PRODUCT.md DESIGN.md docs/operations/self-hosting.md docs/operations/webos-acceptance.md tests/design-materials.test.ts tests/config.test.ts
git add -u docs/operations/firebase-vercel-setup.md
git commit -m "Document self-hosted Cloudframe operations"
```

---

### Task 20: Run the Complete Verification and Real-TV Acceptance Gate

**Files:**
- Modify only if verification reveals a defect in an earlier task.
- Record evidence in the implementation task notes or PR description; do not add generated logs, test output, secrets, or container data to git.

**Interfaces:**
- Consumes: the complete self-hosted implementation and all prior task verification.
- Produces: release-ready local evidence and an explicit real-device deployment hold.

- [ ] **Step 1: Start from a clean dependency and output state**

Preserve unrelated untracked user files. Remove only generated paths owned by this repository build:

```powershell
$generated = @(
  (Join-Path (Get-Location) 'build'),
  (Join-Path (Get-Location) 'dist'),
  (Join-Path (Get-Location) 'apps/tv/dist'),
  (Join-Path (Get-Location) 'apps/admin/dist'),
  (Join-Path (Get-Location) 'test-results'),
  (Join-Path (Get-Location) 'playwright-report')
)
foreach ($path in $generated) {
  $resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $path))
  if (-not $resolvedParent.StartsWith([System.IO.Path]::GetFullPath((Get-Location).Path), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove generated path outside the workspace: $path"
  }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
}
npm ci
```

Do not delete `.agents`, `.codex`, `.impeccable`, user media, or any `/data` installation directory.

- [ ] **Step 2: Run the complete unit and static suite**

```powershell
npm test
npm run typecheck
npm run lint
```

Expected: PASS with no ignored new failures. If the repository still has explicitly documented unrelated lint debt, report the exact pre-existing lines and run targeted lint over every changed source file; do not call the full gate passed.

- [ ] **Step 3: Build all production artifacts and run compatibility checks**

```powershell
npm run build:server
node scripts/check-tv-bundle.mjs
npm run check:chromium68
```

Expected: PASS. Inspect generated bundle contents and confirm ordinary production output contains no E2E fixture hook or public source map.

- [ ] **Step 4: Run browser acceptance**

```powershell
npx playwright test
```

Expected: all TV/admin projects PASS, including real Video.js skin, direct MP4, synthetic HLS, first-run, source management, enrollment, revocation, and responsive screenshots. Review screenshot diffs rather than blindly updating them.

- [ ] **Step 5: Run real FFmpeg and container acceptance**

```powershell
ffprobe -v error -show_entries stream=codec_type,codec_name -of json tests/fixtures/media/legacy-mpeg.mpg
npm run docker:build
npm run test:container
```

Expected: PASS. Verify container runs unprivileged, reports FFmpeg/FFprobe ready, persists state across restart, produces H.264/AAC/yuv420p HLS, and exits cleanly on stop.

- [ ] **Step 6: Audit active runtime and image for retired platform coupling and secrets**

```powershell
rg -n '@vercel|@google-cloud/firestore|VERCEL_|BLOB_STORE_ID|FIRESTORE_|GCP_' packages deploy scripts package.json packages/server/package.json .env.example README.md PRODUCT.md DESIGN.md docs/operations
npm ls @vercel/blob @vercel/functions @vercel/oidc @google-cloud/firestore --all
docker history --no-trunc cloudframe:local
docker inspect cloudframe:local
```

Expected: no active Vercel/GCP runtime match or dependency, no provider credential/master key in image history/config, one exposed port, and the unprivileged runtime user.

- [ ] **Step 7: Exercise manual local failure cases**

Against the temporary smoke container, verify:

- wrong setup code is rate-limited without timing-detail leakage;
- a second device receives the busy message while a transcode is active;
- cache-full configuration returns `TRANSCODER_CACHE_FULL` without crossing the reserve;
- killing FFmpeg leaves only reusable completed segments and partial window metadata;
- restarting removes abandoned staging files;
- revoking the active device stops later manifest/segment access; and
- logs contain stable IDs/counters but no cookie, token, capability, provider URL, or media body.

- [ ] **Step 8: Perform user-assisted LG webOS acceptance before deployment**

Do not deploy to an operator-selected production host in this task. Run the temporary smoke container on the local network when it is reachable by the television; otherwise stop with an explicit real-TV acceptance hold and provide the exact checklist from `docs/operations/webos-acceptance.md`. The user controls the television. Capture outcomes for:

1. direct MP4 playback;
2. visible Video.js skin and remote play/pause;
3. transcoded MPEG startup;
4. forward seek into an ungenerated window;
5. pause/resume and Back;
6. local history resume; and
7. clean behavior after container restart.

If real-TV HLS fails, collect the first browser/player/network error and FFmpeg/server job event before proposing a fix.

- [ ] **Step 9: Request final code review**

Invoke `superpowers:requesting-code-review`. Review the full range from the architecture commit through the implementation head. Resolve every correctness/security finding, rerun the affected focused tests, then rerun Steps 2–6 if code changes.

- [ ] **Step 10: Commit verification-only fixes when the review changed files**

If verification required code changes:

Inspect `git status --short`, construct an explicit list containing only files changed to resolve documented review/verification findings, stage that exact list with `git add -- <path1> <path2>`, verify `git diff --cached --name-status`, then run:

```powershell
git commit -m "Harden self-hosted playback verification"
```

If no files changed, do not create an empty commit.

- [ ] **Step 11: Stop at the deployment boundary**

Report:

- exact commit range;
- full test/build/container results;
- image tag and digest if locally built;
- real-TV acceptance result or outstanding hold;
- remaining operational steps: publish image, choose host, configure reverse proxy/TLS, set `APP_ORIGIN`, create provider callback URLs, mount/back up `/data`, and switch DNS; and
- explicit confirmation that no external Vercel/Firebase/DNS resource was deleted.

Do not publish an image, deploy a container, alter DNS, or delete external resources without a new explicit request.

---

## Final Commit Sequence

The intended reviewable commits are:

1. `Add portable runtime configuration`
2. `Store control state in SQLite`
3. `Replace runtime caches with local state`
4. `Add secure first-run ownership`
5. `Add the self-hosted server runtime`
6. `Authenticate provider content revisions`
7. `Centralize provider media retrieval`
8. `Add the transcode cache foundation`
9. `Secure transcoder provider input`
10. `Probe media and render HLS manifests`
11. `Encode demand-paged HLS windows`
12. `Coordinate one active TV transcode`
13. `Serve authenticated HLS playback`
14. `Add HLS media state to the TV`
15. `Use Video.js for direct and HLS playback`
16. `Show transcoder status in Admin`
17. `Package Cloudframe as a Docker service`
18. `Remove the Vercel control plane runtime`
19. `Document self-hosted Cloudframe operations`
20. Optional verification fix commit only when Step 20 finds a real defect.

Each commit must keep focused tests green and must not stage unrelated `.agents`, `.codex`, or `.impeccable` files.
