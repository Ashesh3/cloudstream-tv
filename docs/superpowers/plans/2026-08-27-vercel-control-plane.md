# Vercel Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Firestore-backed indexing and request-time authorization with a Vercel-hosted control plane that performs live provider metadata requests, streams media directly from providers, stores watch history locally on the TV, and causes zero steady-state Firestore reads.

**Architecture:** A versioned encrypted private Vercel Blob is the active durable control document and Vercel Runtime Cache is its five-minute hot copy. Every protected HTTP request conditionally revalidates the cached Blob ETag against Blob origin once and reuses that verified snapshot throughout the request. The public API receives no Firestore read interface; control mutations asynchronously overwrite one compact Firestore recovery document. Sealed cookies authorize the admin and TV, sealed provider handles authorize live browsing, and the provider adapters vend direct Google/OneDrive media URLs without proxying bytes.

**Tech Stack:** TypeScript 5.9, Node.js 24, Vercel Web Functions, `@vercel/blob` 2.8.0, `@vercel/functions` 3.9.5, Google Cloud Firestore server SDK, Preact/Vite TV app, React/Vite admin app, Vitest, Playwright, Chromium 68 compatibility lane.

**Spec:** `docs/superpowers/specs/2026-08-27-vercel-control-plane-design.md`

## Global Constraints

- The TV target remains LG webOS 5+ / Chromium 68; do not introduce unsupported syntax or browser APIs into the legacy bundle.
- Vercel Functions remain pinned to `bom1` and Node.js 24.
- The private Blob snapshot is authoritative; Runtime Cache misses read Blob and never Firestore.
- Runtime Cache control entries use a five-minute TTL. Every protected request conditionally revalidates the cached ETag against private Blob origin; security-changing mutations take effect on the next request even when cache replacement fails.
- Public request dependencies must not expose a Firestore read-capable repository.
- Firestore runtime access is one exact-path write to `controlPlaneBackups/{householdId}` after actual control mutations. One-time migration, explicit restore, and temporary legacy-cookie exchange are the only permitted reads.
- Provider refresh tokens never leave Vercel. Routine access-token refresh must not mutate Blob or Firestore unless the provider rotates the refresh token.
- Google playback returns a short-lived `alt=media` URL containing the access token; OneDrive playback returns `@microsoft.graph.downloadUrl`. Vercel must never proxy media or thumbnail bytes.
- TV watch history is local-only under `cloudframe.tv.watch-history.v1:{deviceId}` and is capped at 500 entries.
- TV DTOs and local history expose only HMAC-derived pseudonymous item IDs and sealed handles, never provider node IDs.
- Control-document ceilings are 8 devices, 8 pending requests, 4 sources, 32 roots, 64 ancestry entries per root, and 120 characters per visible name.
- Do not automatically delete legacy Firestore documents, Firebase projects, or Google Cloud projects.
- Never log cookies, passphrases, OAuth state/code/verifier, provider IDs, access/refresh tokens, direct media URLs, encrypted payloads, or provider response bodies.
- Every behavior change follows red-green-refactor: add a focused failing test, confirm the intended failure, implement the minimum behavior, and rerun the focused test before the task-level suite.

## Final File Structure

### Shared contracts

- `packages/shared/src/control-plane.ts` — compact v2 control-document types and hard-limit constants.
- `packages/shared/src/api.ts` — final admin, enrollment, live-browse, thumbnail, and media DTOs.
- `packages/shared/src/sorting.ts` — sorting for live provider DTOs, without index-only cover logic.
- `tests/helpers/control-plane.ts` — canonical valid v2 document and deterministic key fixtures shared by focused tests.

### Server control plane

- `packages/server/src/crypto/aead.ts` — purpose-bound AES-256-GCM primitives and versioned keyrings.
- `packages/server/src/auth/sealed-sessions.ts` — admin, device, request, and OAuth-state cookie codecs.
- `packages/server/src/auth/browse-handles.ts` — sealed item/cursor codecs and stable pseudonymous IDs.
- `packages/server/src/control-plane/schema.ts` — v2 document validation, normalization, cloning, and ceilings.
- `packages/server/src/control-plane/envelope.ts` — encrypted Blob envelope serialization.
- `packages/server/src/control-plane/store.ts` — cache/Blob CAS orchestration and recovery mirroring.
- `packages/server/src/control-plane/vercel-blob.ts` — private Blob adapter.
- `packages/server/src/control-plane/runtime-cache.ts` — Vercel Runtime Cache adapter and mirror status.
- `packages/server/src/control-plane/firestore-mirror.ts` — write-only production recovery mirror.
- `packages/server/src/control-plane/memory.ts` — deterministic test adapters.
- `packages/server/src/control-plane/mutations.ts` — pure domain reducers.
- `packages/server/src/control-plane/legacy-session-exchange.ts` — temporary cutover-only Firestore reader; deleted after exchange verification.

### Server services and HTTP

- `packages/server/src/services/control-auth.ts` — sealed admin/device authentication.
- `packages/server/src/services/control-admin.ts` — admin snapshot and control mutations.
- `packages/server/src/services/control-enrollment.ts` — request creation/polling/approval.
- `packages/server/src/services/control-oauth.ts` — sealed OAuth state and source connection.
- `packages/server/src/services/credential-broker.ts` — encrypted access-token cache and refresh rotation.
- `packages/server/src/services/live-provider-folders.ts` — admin live folder selection without indexing.
- `packages/server/src/services/live-browse.ts` — TV root and folder metadata browsing.
- `packages/server/src/services/direct-media.ts` — provider thumbnail/media URL vending.
- `packages/server/src/services/runtime-rate-limit.ts` — best-effort Runtime Cache rate limits.
- `packages/server/src/http/request-context.ts` — one conditionally revalidated control snapshot per protected HTTP request.
- `packages/server/src/http/control-app.ts` — final route table and response/error normalization.

### Browser applications and operations

- `apps/tv/src/state/local-watch-history.ts` — resilient local resume-history store.
- `apps/tv/src/api/client.ts`, `apps/tv/src/app.tsx`, `apps/tv/src/components/*` — sealed-handle live browsing and direct playback.
- `apps/admin/src/api/client.ts`, `apps/admin/src/app.tsx`, `apps/admin/src/components/*` — one control snapshot and indexing-free source management.
- `scripts/lib/control-plane-ops.ts` — shared migration/restore conversion and redacted reporting.
- `scripts/migrate-vercel-control-plane.ts` — dry-run-first Firestore-to-Blob migration.
- `scripts/restore-vercel-control-plane.ts` — one-document Firestore recovery.
- `deploy/api-entry.ts`, `scripts/build-vercel.mjs`, `deploy/vercel-build-contract.json` — one API function without Workflows.

---

### Task 1: Add the compact control model and final API DTOs

**Files:**
- Create: `packages/shared/src/control-plane.ts`
- Create: `tests/control-plane-contracts.test.ts`
- Create: `tests/helpers/control-plane.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `ControlPlaneDocumentV2`, `ControlPlaneDevice`, `ControlPlaneRequest`, `ControlPlaneSource`, `ControlPlaneRoot`, `CONTROL_PLANE_LIMITS`.
- Produces: `AdminSnapshotResponse`, `TvBootstrapResponse`, `TvRootDto`, `TvBrowseItemDto`, `TvFolderPageResponse`, `DirectThumbnailItem`, and `DirectMediaUrlResponse`.
- Leaves legacy index DTOs in place temporarily so the existing runtime continues compiling until Task 18.

- [ ] **Step 1: Write failing shape and secrecy tests**

```ts
// tests/control-plane-contracts.test.ts
import { describe, expect, it } from "vitest";
import {
  CONTROL_PLANE_LIMITS,
  type AdminSnapshotResponse,
  type ControlPlaneDocumentV2,
  type TvBrowseItemDto
} from "@cloudframe/shared";

describe("v2 control-plane contracts", () => {
  it("sets the approved single-household ceilings", () => {
    expect(CONTROL_PLANE_LIMITS).toEqual({
      devices: 8,
      pendingRequests: 8,
      sources: 4,
      roots: 32,
      ancestryEntries: 64,
      visibleNameLength: 120
    });
  });

  it("keeps provider ids and credentials out of TV DTOs", () => {
    const item: TvBrowseItemDto = {
      id: "item_public_id",
      handle: "sealed-item",
      name: "Lake.mp4",
      normalizedName: "lake.mp4",
      kind: "video",
      mimeType: "video/mp4",
      size: 123,
      width: 1920,
      height: 1080,
      capturedAt: null,
      createdAtProvider: null,
      modifiedAtProvider: null,
      thumbnailRevision: "7",
      hasPreview: true
    };
    expect(JSON.stringify(item)).not.toMatch(/providerNodeId|accessToken|refreshToken/);
  });

  it("does not expose indexing health in the admin snapshot", () => {
    const keys: Array<keyof AdminSnapshotResponse> = [
      "revision", "household", "pendingRequests", "devices", "sources", "roots", "recoveryCopy"
    ];
    expect(keys).not.toContain("indexHealth" as keyof AdminSnapshotResponse);
  });
});
```

- [ ] **Step 2: Run the contract test and confirm missing exports**

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-contracts.test.ts`

Expected: FAIL because `ControlPlaneDocumentV2`, `TvBrowseItemDto`, and `CONTROL_PLANE_LIMITS` do not exist.

- [ ] **Step 3: Add the compact durable types**

```ts
// packages/shared/src/control-plane.ts
import type { EncryptedSecret, MediaOrder, ProviderKind } from "./contracts";

export const CONTROL_PLANE_LIMITS = {
  devices: 8,
  pendingRequests: 8,
  sources: 4,
  roots: 32,
  ancestryEntries: 64,
  visibleNameLength: 120
} as const;

export interface ControlPlaneDocumentV2 {
  schemaVersion: 2;
  householdId: string;
  revision: number;
  updatedAt: string;
  household: {
    adminPassphraseHash: string;
    adminPassphraseVersion: number;
    allowNewDeviceRequests: boolean;
    defaultMediaOrder: MediaOrder;
    defaultSlideshowSeconds: number;
  };
  devices: Record<string, ControlPlaneDevice>;
  pendingDeviceRequests: Record<string, ControlPlaneRequest>;
  sources: Record<string, ControlPlaneSource>;
  roots: Record<string, ControlPlaneRoot>;
}

export interface ControlPlaneDevice {
  id: string;
  name: string;
  enabled: boolean;
  assignedRootIds: string[];
  mediaOrder: MediaOrder | null;
  slideshowSeconds: number | null;
  sessionVersion: number;
  createdAt: string;
  approvedAt: string;
  revokedAt: string | null;
}

export interface ControlPlaneRequest {
  id: string;
  requestedName: string;
  requestSecretHash: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  approvedDeviceId: string | null;
}

export interface ControlPlaneSource {
  id: string;
  provider: ProviderKind;
  providerAccountId: string;
  providerRootId: string;
  accountLabel: string;
  encryptedRefreshToken: EncryptedSecret;
  encryptedBootstrapAccessToken: EncryptedSecret | null;
  bootstrapAccessTokenExpiresAt: string | null;
  credentialVersion: number;
  status: "healthy" | "reauth-required" | "disabled";
  createdAt: string;
}

export interface ControlPlaneRoot {
  id: string;
  sourceId: string;
  providerNodeId: string;
  displayName: string;
  ancestryProviderIds: string[];
  enabled: boolean;
  createdAt: string;
}
```

- [ ] **Step 4: Add final browser-safe DTOs to `packages/shared/src/api.ts`**

```ts
export interface TvBrowseItemDto {
  id: string;
  handle: string;
  name: string;
  normalizedName: string;
  kind: "folder" | "image" | "video";
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  createdAtProvider: string | null;
  modifiedAtProvider: string | null;
  thumbnailRevision: string | null;
  hasPreview: boolean;
}

export interface TvRootDto {
  id: string;
  handle: string;
  displayName: string;
  provider: "google" | "onedrive";
  accountLabel: string;
}

export interface TvFolderPageResponse {
  parent: TvBrowseItemDto;
  children: TvBrowseItemDto[];
  nextCursor: string | null;
}

export interface DirectThumbnailItem {
  itemId: string;
  status: "ready" | "unavailable";
  url?: string;
  expiresAt?: string;
  revision?: string | null;
}

export interface DirectMediaUrlResponse {
  itemId: string;
  kind: "image" | "video";
  url: string;
  expiresAt: string;
  revision: string | null;
}
```

Also add final household/device/source/root/request DTOs and `AdminSnapshotResponse`; include `recoveryCopy: { status: "current" | "delayed"; revision: number | null }` and omit every index/sync field.

- [ ] **Step 5: Export the control model and rerun focused tests**

Add `export * from "./control-plane";` to `packages/shared/src/index.ts`.

Create the canonical test fixture used by later tasks:

```ts
// tests/helpers/control-plane.ts
import type {
  ControlPlaneDevice,
  ControlPlaneDocumentV2,
  EncryptedSecret
} from "@cloudframe/shared";

export const TEST_NOW = new Date("2026-08-27T08:00:00.000Z");

const encrypted = (byte: number): EncryptedSecret => ({
  keyVersion: "v1",
  iv: Buffer.alloc(12, byte).toString("base64url"),
  ciphertext: Buffer.from(`cipher-${byte}`).toString("base64url"),
  authTag: Buffer.alloc(16, byte).toString("base64url")
});

export function testAeadKeyring() {
  return { currentVersion: "v1", keys: { v1: Buffer.alloc(32, 7) } };
}

export function testControlDevice(id = "device-1"): ControlPlaneDevice {
  return {
    id,
    name: id === "device-1" ? "Living Room" : `TV ${id}`,
    enabled: true,
    assignedRootIds: id === "device-1" ? ["root-1"] : [],
    mediaOrder: null,
    slideshowSeconds: null,
    sessionVersion: 1,
    createdAt: TEST_NOW.toISOString(),
    approvedAt: TEST_NOW.toISOString(),
    revokedAt: null
  };
}

export function testControlDocument(): ControlPlaneDocumentV2 {
  return {
    schemaVersion: 2,
    householdId: "h1",
    revision: 1,
    updatedAt: TEST_NOW.toISOString(),
    household: {
      adminPassphraseHash: "argon2-test-hash",
      adminPassphraseVersion: 1,
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8
    },
    devices: { "device-1": testControlDevice() },
    pendingDeviceRequests: {
      "request-1": {
        id: "request-1",
        requestedName: "Bedroom",
        requestSecretHash: "request-secret-hash",
        status: "pending",
        createdAt: TEST_NOW.toISOString(),
        expiresAt: new Date(TEST_NOW.getTime() + 30 * 60_000).toISOString(),
        resolvedAt: null,
        approvedDeviceId: null
      }
    },
    sources: {
      "source-1": {
        id: "source-1",
        provider: "google",
        providerAccountId: "account-1",
        providerRootId: "provider-root",
        accountLabel: "family@example.test",
        encryptedRefreshToken: encrypted(1),
        encryptedBootstrapAccessToken: null,
        bootstrapAccessTokenExpiresAt: null,
        credentialVersion: 1,
        status: "healthy",
        createdAt: TEST_NOW.toISOString()
      }
    },
    roots: {
      "root-1": {
        id: "root-1",
        sourceId: "source-1",
        providerNodeId: "provider-trips",
        displayName: "Trips",
        ancestryProviderIds: ["provider-root"],
        enabled: true,
        createdAt: TEST_NOW.toISOString()
      }
    }
  };
}

export function testDocumentAtRevision(revision: number): ControlPlaneDocumentV2 {
  const document = testControlDocument();
  return { ...document, revision, updatedAt: new Date(TEST_NOW.getTime() + revision * 1_000).toISOString() };
}
```

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-contracts.test.ts tests/api-contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the contract foundation**

```powershell
git add packages/shared/src/control-plane.ts packages/shared/src/api.ts packages/shared/src/index.ts tests/control-plane-contracts.test.ts tests/helpers/control-plane.ts
git commit -m "Define compact control-plane contracts"
```

### Task 2: Add purpose-bound encryption, sealed sessions, and opaque browse handles

**Files:**
- Create: `packages/server/src/crypto/aead.ts`
- Create: `packages/server/src/auth/sealed-sessions.ts`
- Create: `packages/server/src/auth/browse-handles.ts`
- Create: `tests/sealed-sessions.test.ts`
- Create: `tests/browse-handles.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `VersionedAeadKeyring`, `sealJson()`, `openJson()`.
- Produces: `SealedSessionCodec` with admin, device, request, and OAuth-state issue/open methods.
- Produces: `BrowseHandleCodec` with item/cursor sealing and `stableItemId()`.

- [ ] **Step 1: Write failing tamper, expiry, binding, and secrecy tests**

```ts
// tests/sealed-sessions.test.ts
it("seals device claims and rejects tampering or expiry", () => {
  const codec = createSealedSessionCodec(testAeadKeyring(), () => now);
  const token = codec.issueDevice({
    version: 2,
    householdId: "h1",
    deviceId: "d1",
    sessionVersion: 3,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 60_000
  });
  expect(token).not.toContain("d1");
  expect(codec.openDevice(token)).toMatchObject({ deviceId: "d1", sessionVersion: 3 });
  expect(() => codec.openDevice(`${token.slice(0, -1)}A`)).toThrow(/invalid/i);
});
```

```ts
// tests/browse-handles.test.ts
it("binds a sealed media handle to one device, root, and credential version", () => {
  const codec = createBrowseHandleCodec(testAeadKeyring(), "id-secret", () => now);
  const handle = codec.sealItem({
    version: 2,
    householdId: "h1",
    deviceId: "d1",
    sourceId: "s1",
    rootId: "r1",
    providerNodeId: "provider-secret",
    parentProviderNodeId: "parent-secret",
    kind: "video",
    name: "Lake.mp4",
    mimeType: "video/mp4",
    credentialVersion: 4,
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 30 * 60_000
  });
  expect(handle).not.toMatch(/provider-secret|parent-secret|Lake/);
  expect(codec.openItem(handle)).toMatchObject({ deviceId: "d1", rootId: "r1" });
  expect(codec.stableItemId("h1", "s1", "provider-secret")).toMatch(/^item_/);
});
```

- [ ] **Step 2: Run the crypto tests and confirm missing codecs**

Run: `npx vitest run --config vitest.core.config.ts tests/sealed-sessions.test.ts tests/browse-handles.test.ts`

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement one generic purpose-bound AEAD primitive**

```ts
// packages/server/src/crypto/aead.ts
export interface VersionedAeadKeyring {
  currentVersion: string;
  keys: Record<string, Uint8Array>;
}

export function sealJson(
  purpose: string,
  value: unknown,
  keyring: VersionedAeadKeyring
): string;

export function openJson<T>(
  purpose: string,
  token: string,
  keys: Record<string, Uint8Array>,
  parse: (value: unknown) => T
): T;
```

Encode tokens as `a1.<keyVersion>.<iv>.<ciphertext>.<authTag>`. Use a 12-byte random IV, AES-256-GCM, and `purpose` as additional authenticated data. Reject unknown versions, non-32-byte keys, malformed segments, invalid JSON, parser failure, and authentication failure with the same secret-safe `SealedValueError("SEALED_VALUE_INVALID")`.

- [ ] **Step 4: Implement sealed session claim codecs**

Define exact claims from the spec and validate integer timestamps, household/device IDs, `version === 2`, and `expiresAt > now`. Use distinct purposes:

```ts
"cloudframe/admin-session/v2"
"cloudframe/device-session/v2"
"cloudframe/device-request/v2"
"cloudframe/oauth-state/v2"
```

The OAuth claim includes `adminSessionId`, provider, redirect URI, optional reconnect source ID, PKCE verifier, state hash, issued time, and expiry. It never enters the control document.

- [ ] **Step 5: Implement item and provider-cursor codecs**

Use purposes `cloudframe/browse-item/v2` and `cloudframe/browse-cursor/v2`. Implement:

```ts
stableItemId(householdId: string, sourceId: string, providerNodeId: string): string {
  return `item_${createHmac("sha256", browseIdSecret)
    .update(`${householdId.length}:${householdId}${sourceId.length}:${sourceId}${providerNodeId.length}:${providerNodeId}`)
    .digest("base64url")}`;
}
```

The cursor claim contains household, device, source, root, folder provider ID, opaque provider cursor, credential version, and 30-minute expiry.

- [ ] **Step 6: Rerun focused tests and existing token tests**

Run: `npx vitest run --config vitest.core.config.ts tests/sealed-sessions.test.ts tests/browse-handles.test.ts tests/auth.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit sealed security primitives**

```powershell
git add packages/server/src/crypto/aead.ts packages/server/src/auth/sealed-sessions.ts packages/server/src/auth/browse-handles.ts packages/server/src/index.ts tests/sealed-sessions.test.ts tests/browse-handles.test.ts
git commit -m "Add sealed control-plane credentials"
```

### Task 3: Validate and encrypt the compact control document

**Files:**
- Create: `packages/server/src/control-plane/schema.ts`
- Create: `packages/server/src/control-plane/envelope.ts`
- Create: `tests/control-plane-schema.test.ts`
- Create: `tests/control-plane-envelope.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: `parseControlPlaneDocument()`, `cloneControlPlaneDocument()`, `pruneExpiredRequests()`.
- Produces: `encryptControlPlaneDocument()` and `decryptControlPlaneEnvelope()`.

- [ ] **Step 1: Write failing validation and envelope tests**

```ts
it("rejects an oversized control document before storage", () => {
  const document = testControlDocument();
  document.devices = Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [`d${index}`, testControlDevice(`d${index}`)])
  );
  expect(() => parseControlPlaneDocument(document)).toThrowError(
    expect.objectContaining({ code: "CONTROL_PLANE_LIMIT_EXCEEDED" })
  );
});

it("round-trips a document and rejects ciphertext tampering", () => {
  const envelope = encryptControlPlaneDocument(testControlDocument(), testAeadKeyring());
  expect(decryptControlPlaneEnvelope(envelope, testAeadKeyring().keys)).toEqual(testControlDocument());
  expect(() => decryptControlPlaneEnvelope({ ...envelope, ciphertext: `${envelope.ciphertext}A` }, testAeadKeyring().keys))
    .toThrowError(expect.objectContaining({ code: "CONTROL_PLANE_INVALID" }));
});
```

- [ ] **Step 2: Run focused tests and confirm missing implementation**

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-schema.test.ts tests/control-plane-envelope.test.ts`

Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Implement a strict Zod schema and cross-record checks**

Validate all ISO timestamps and hard limits. Also enforce:

- record key equals embedded `id`;
- every device root exists and is enabled;
- every root source exists;
- root ancestry contains no duplicate provider IDs;
- source/root/device names are trimmed and 1-120 characters;
- `revision` and every version are safe positive integers;
- source provider/account/root IDs are non-empty;
- expired requests may be present but `pruneExpiredRequests(document, now)` marks pending requests expired before mutation.

Return a deep clone so callers cannot mutate cached state by reference.

- [ ] **Step 4: Implement the outer control envelope**

```ts
export interface ControlPlaneEnvelopeV1 {
  envelopeVersion: 1;
  keyVersion: string;
  revision: number;
  iv: string;
  ciphertext: string;
  authTag: string;
}
```

Serialize the validated document with stable JSON key ordering, encrypt with purpose `cloudframe/control-plane/v2`, and verify that the clear envelope revision equals the decrypted document revision. Normalize every failure to `ControlPlaneEnvelopeError("CONTROL_PLANE_INVALID")` without embedding input values.

- [ ] **Step 5: Run focused tests and static checks**

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-schema.test.ts tests/control-plane-envelope.test.ts tests/control-plane-contracts.test.ts`

Run: `npm run typecheck`

Expected: all commands PASS.

- [ ] **Step 6: Commit validation and envelope support**

```powershell
git add packages/server/src/control-plane/schema.ts packages/server/src/control-plane/envelope.ts packages/server/src/index.ts tests/control-plane-schema.test.ts tests/control-plane-envelope.test.ts
git commit -m "Validate encrypted control snapshots"
```

### Task 4: Build the Blob, Runtime Cache, CAS, and write-only recovery store

**Files:**
- Create: `packages/server/src/control-plane/store.ts`
- Create: `packages/server/src/control-plane/vercel-blob.ts`
- Create: `packages/server/src/control-plane/runtime-cache.ts`
- Create: `packages/server/src/control-plane/firestore-mirror.ts`
- Create: `packages/server/src/control-plane/memory.ts`
- Create: `tests/control-plane-store.test.ts`
- Create: `tests/firestore-mirror.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `ControlPlaneStore.load()` and `ControlPlaneStore.mutate()`.
- Produces narrow adapters `ControlDurableStore`, `ControlHotCache`, `RecoveryMirror`, and `DeferredTasks`.
- `RecoveryMirror` intentionally has only `write(document)`; no public runtime type can read Firestore.

- [ ] **Step 1: Write failing cache-miss, CAS, and mirror tests**

```ts
it("loads Blob on a Runtime Cache miss and never asks the mirror to read", async () => {
  const harness = controlStoreHarness(testControlDocument());
  await harness.cache.delete(harness.cacheKey);
  const loaded = await harness.store.load();
  expect(loaded.document.revision).toBe(1);
  expect(harness.durable.readCount).toBe(1);
  expect(harness.mirror.writeCount).toBe(0);
  expect("read" in harness.mirror).toBe(false);
});

it("conditionally revalidates a cached snapshot and replaces stale state", async () => {
  const harness = controlStoreHarness(testControlDocument());
  await harness.store.load();
  const cachedEtag = harness.cache.currentEtag;
  harness.durable.replaceOutOfBand(testDocumentAtRevision(2));
  const loaded = await harness.store.load();
  expect(harness.durable.lastIfNoneMatch).toBe(cachedEtag);
  expect(loaded.document.revision).toBe(2);
});

it("retries a stale ETag three times without overwriting concurrent work", async () => {
  const harness = controlStoreHarness(testControlDocument(), { conflicts: 3 });
  await expect(harness.store.mutate("settings", current => ({
    changed: true,
    next: { ...current, revision: current.revision + 1 },
    result: true
  }))).rejects.toMatchObject({ code: "CONTROL_PLANE_CONFLICT" });
  expect(harness.durable.writeAttempts).toBe(3);
});

it("commits Blob, verifies the cache revision, and defers one full mirror write", async () => {
  const harness = controlStoreHarness(testControlDocument());
  await harness.store.mutate("settings", current => ({
    changed: true,
    next: { ...current, revision: current.revision + 1, updatedAt: "2026-08-27T08:00:00.000Z" },
    result: "saved"
  }));
  await harness.deferred.flush();
  expect(harness.cache.currentRevision).toBe(2);
  expect(harness.mirror.writeCount).toBe(1);
  expect(harness.mirror.lastDocument?.revision).toBe(2);
});
```

- [ ] **Step 2: Run the store tests and confirm missing adapters**

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-store.test.ts tests/firestore-mirror.test.ts`

Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Define the narrow storage boundaries**

```ts
export interface StoredControlEnvelope {
  envelope: ControlPlaneEnvelopeV1;
  etag: string;
}

export interface ControlDurableStore {
  read(ifNoneMatch?: string): Promise<StoredControlEnvelope | { notModified: true } | null>;
  create(envelope: ControlPlaneEnvelopeV1): Promise<{ etag: string }>;
  replace(envelope: ControlPlaneEnvelopeV1, expectedEtag: string): Promise<{ etag: string }>;
}

export interface ControlHotCache {
  get(): Promise<StoredControlEnvelope | null>;
  set(value: StoredControlEnvelope, ttlSeconds: number): Promise<void>;
  delete(): Promise<void>;
  getMirrorStatus(): Promise<{ status: "current" | "delayed"; revision: number | null }>;
  setMirrorStatus(value: { status: "current" | "delayed"; revision: number | null }): Promise<void>;
}

export interface RecoveryMirror {
  write(document: ControlPlaneDocumentV2): Promise<void>;
}

export interface DeferredTasks {
  run(promise: Promise<unknown>): void;
}
```

- [ ] **Step 4: Implement `createControlPlaneStore()`**

`load()` must:

1. read the encrypted cache entry and ETag;
2. call durable `read(cachedEtag)` on every invocation;
3. use the cached envelope only when the durable result is `{ notModified: true }`;
4. replace cache and use the returned envelope when durable returns a new ETag/body;
5. on cache miss, perform a complete durable read;
6. delete a corrupt cache entry and retry one complete private Blob read with `useCache: false`;
7. fail `CONTROL_PLANE_UNAVAILABLE` if Blob is absent/corrupt;
8. cache the exact envelope/ETag for 300 seconds;
9. return a validated clone.

`mutate(name, reducer)` must:

1. load current snapshot;
2. call the pure reducer;
3. skip durable/cache/mirror writes when `changed === false`;
4. require `next.revision === current.revision + 1` and set `updatedAt` once;
5. `replace()` with the current ETag;
6. cache the new envelope/ETag; if cache set fails, delete/expire the cache best-effort but return the committed mutation result because the next request revalidates against Blob;
7. defer a three-attempt idempotent full-document mirror write;
8. set mirror status `current` on success or `delayed` after the third failure;
9. retry ETag conflicts from a fresh Blob read, at most three total attempts.

- [ ] **Step 5: Implement production Vercel adapters**

`createVercelBlobControlStore()` uses deterministic pathname `cloudframe/control-plane/{environment}/{householdId}.json.enc`, `get(..., { access: "private", useCache: false, ifNoneMatch })`, maps SDK status 304 to `{ notModified: true }`, and writes with `put(..., { access: "private", contentType: "application/json", addRandomSuffix: false, allowOverwrite: true, ifMatch })`.

`createVercelRuntimeControlCache()` uses `getCache({ namespace: "cloudframe-control" })`, control key `v2:{environment}:{householdId}`, tag `cloudframe-control:{environment}:{householdId}`, TTL 300, and a separate mirror-status key. It stores only encrypted envelopes and ETags.

- [ ] **Step 6: Implement the write-only Firestore mirror**

```ts
export function createFirestoreRecoveryMirror(
  firestore: Pick<Firestore, "collection">,
  householdId: string
): RecoveryMirror {
  return {
    async write(document) {
      if (document.householdId !== householdId) throw new Error("Household mismatch");
      await firestore.collection("controlPlaneBackups").doc(householdId).set(document);
    }
  };
}
```

Do not add `read`, `get`, query, transaction, or merge behavior to this adapter.

- [ ] **Step 7: Add memory adapters for deterministic tests**

The memory durable store tracks ETag, read count, write attempts, and injectable conflict count. The memory cache deep-clones entries. The memory mirror tracks only writes. The deferred collector exposes `flush()`.

- [ ] **Step 8: Add direct runtime dependencies and run focused tests**

Add exact `@vercel/functions: "3.9.5"` and ensure `@vercel/blob: "2.8.0"` is a direct server/runtime dependency wherever imported.

Run: `npm install`

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-store.test.ts tests/firestore-mirror.test.ts tests/control-plane-envelope.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the active control store**

```powershell
git add packages/server/src/control-plane packages/server/src/index.ts packages/server/package.json package.json package-lock.json tests/control-plane-store.test.ts tests/firestore-mirror.test.ts
git commit -m "Add Vercel control snapshot storage"
```

### Task 5: Implement pure control mutations and the consolidated admin snapshot

**Files:**
- Create: `packages/server/src/control-plane/mutations.ts`
- Create: `packages/server/src/services/control-admin.ts`
- Create: `tests/control-mutations.test.ts`
- Create: `tests/control-admin.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `ControlPlaneStore`, `ControlPlaneDocumentV2`, passphrase hashing/verification.
- Produces: pure reducers for settings, passphrase, devices, requests, sources, roots, and credential rotation.
- Produces: `ControlAdminService.snapshot()` and mutation methods used by the final HTTP app.

- [ ] **Step 1: Write failing pure-mutation tests**

```ts
it("revokes a device by incrementing its session version and removing no history", () => {
  const current = testControlDocument();
  const result = revokeDeviceMutation(current, "device-1", now);
  expect(result.changed).toBe(true);
  expect(result.next.devices["device-1"]).toMatchObject({
    enabled: false,
    sessionVersion: 2,
    revokedAt: now.toISOString()
  });
  expect(JSON.stringify(result.next)).not.toContain("watchHistory");
});

it("removing a root atomically removes it from every device assignment", () => {
  const result = removeRootMutation(testControlDocument(), "root-1");
  expect(result.next.roots["root-1"]).toBeUndefined();
  expect(result.next.devices["device-1"].assignedRootIds).not.toContain("root-1");
});

it("does not write a new revision for an idempotent settings update", () => {
  const current = testControlDocument();
  expect(updateSettingsMutation(current, current.household).changed).toBe(false);
});
```

- [ ] **Step 2: Run mutation tests and confirm missing reducers**

Run: `npx vitest run --config vitest.core.config.ts tests/control-mutations.test.ts`

Expected: FAIL because `mutations.ts` does not exist.

- [ ] **Step 3: Implement pure reducers with shared validation**

Every reducer returns:

```ts
interface ControlMutationResult<T> {
  changed: boolean;
  next: ControlPlaneDocumentV2;
  result: T;
}
```

Implement exact reducers:

```ts
updateSettingsMutation(document, input)
rotatePassphraseMutation(document, newHash)
createDeviceRequestMutation(document, request)
resolveDeviceRequestMutation(document, requestId, status)
approveDeviceRequestMutation(document, requestId, device, rootIds)
updateDeviceMutation(document, deviceId, patch)
revokeDeviceMutation(document, deviceId, now)
connectSourceMutation(document, source)
reconnectSourceMutation(document, sourceId, verifiedAccount)
markSourceReauthRequiredMutation(document, sourceId)
removeSourceMutation(document, sourceId)
createOrEnableRootMutation(document, root)
removeRootMutation(document, rootId)
rotateSourceCredentialsMutation(document, sourceId, expectedCredentialVersion, refreshToken)
```

Reducers enforce all document ceilings, root/source/device relationships, reconnect account/root matching, request expiry, and idempotency. They must not encrypt, persist, log, or call providers.

- [ ] **Step 4: Write failing service tests for the one admin snapshot**

```ts
it("returns one browser-safe admin snapshot from Vercel state", async () => {
  const service = createControlAdminService(harness.dependencies);
  const snapshot = await service.snapshot("h1");
  expect(snapshot).toMatchObject({ revision: 1, recoveryCopy: { status: "current" } });
  expect(JSON.stringify(snapshot)).not.toMatch(/adminPassphraseHash|providerNodeId|encrypted|accessToken|refreshToken/);
});

it("performs one Blob mutation and one deferred recovery write for settings", async () => {
  const result = await service.updateSettings("h1", {
    allowNewDeviceRequests: false,
    defaultMediaOrder: "name-asc",
    defaultSlideshowSeconds: 10
  });
  await harness.deferred.flush();
  expect(result.revision).toBe(2);
  expect(harness.mirror.writeCount).toBe(1);
});
```

- [ ] **Step 5: Implement `ControlAdminService`**

```ts
export interface ControlAdminService {
  snapshot(householdId: string): Promise<AdminSnapshotResponse>;
  updateSettings(householdId: string, input: UpdateAdminSettingsBody): Promise<{ revision: number }>;
  rotatePassphrase(householdId: string, current: string, next: string): Promise<{ revision: number }>;
  approveRequest(householdId: string, requestId: string, input: ApproveDeviceRequestBody): Promise<{ device: DeviceDto }>;
  denyRequest(householdId: string, requestId: string): Promise<{ request: DeviceRequestDto }>;
  updateDevice(householdId: string, deviceId: string, input: UpdateDeviceBody): Promise<{ device: DeviceDto }>;
  revokeDevice(householdId: string, deviceId: string): Promise<{ revoked: true }>;
  sourceImpact(householdId: string, sourceId: string): Promise<SourceImpactResponse>;
  removeSource(householdId: string, sourceId: string): Promise<{ removed: true } & SourceImpactResponse>;
  rootImpact(householdId: string, rootId: string): Promise<SourceImpactResponse>;
  removeRoot(householdId: string, rootId: string): Promise<{ removed: true } & SourceImpactResponse>;
}
```

Snapshot encoding filters expired requests, sorts requests/devices/sources/roots deterministically, and exposes `recoveryCopy` from `ControlHotCache.getMirrorStatus()`.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run --config vitest.core.config.ts tests/control-mutations.test.ts tests/control-admin.test.ts tests/control-plane-store.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit control mutations and admin service**

```powershell
git add packages/server/src/control-plane/mutations.ts packages/server/src/services/control-admin.ts packages/server/src/index.ts tests/control-mutations.test.ts tests/control-admin.test.ts
git commit -m "Add compact control-plane mutations"
```

### Task 6: Replace database sessions and enrollment with sealed cookies

**Files:**
- Create: `packages/server/src/services/control-auth.ts`
- Create: `packages/server/src/services/control-enrollment.ts`
- Create: `tests/control-auth.test.ts`
- Create: `tests/control-enrollment.test.ts`
- Modify: `packages/server/src/auth/cookies.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `ControlPlaneStore`, `SealedSessionCodec`, `ControlAdminService`.
- Produces: `authenticateControlAdmin()`, `authenticateControlDevice()`, and `ControlEnrollmentService`.

- [ ] **Step 1: Write failing sealed-auth tests**

```ts
it("authenticates a TV from the sealed cookie and the request-scoped control document only", async () => {
  const auth = createControlAuth(harness.dependencies);
  const result = await auth.device(requestWithDeviceCookie(harness.codec.issueDevice(validClaims())), harness.context, now);
  expect(result.device.id).toBe("device-1");
  expect(harness.store.loadCount).toBe(0);
  expect(harness.firestoreReads).toBe(0);
});

it("rejects a revoked device or stale session version on the next request", async () => {
  harness.document.devices["device-1"].sessionVersion = 2;
  await expect(auth.device(requestWithDeviceCookie(harness.codec.issueDevice({ ...validClaims(), sessionVersion: 1 })), harness.context, now))
    .rejects.toMatchObject({ code: "DEVICE_UNAUTHORIZED" });
});
```

- [ ] **Step 2: Write failing enrollment tests**

```ts
it("polls pending request state without Firestore reads", async () => {
  const created = await enrollment.createRequest("Living Room", requestSubject, now);
  const status = await enrollment.status(created.cookie, now);
  expect(status.enrollment.state).toBe("pending");
  expect(harness.firestoreReads).toBe(0);
});

it("approval lets the existing secret-bound request cookie claim the device once", async () => {
  await enrollment.approve("request-1", { name: "Living Room", rootIds: ["root-1"] }, now);
  const status = await enrollment.status(existingRequestCookie, now);
  expect(status.enrollment.state).toBe("ready");
  expect(status.setDeviceCookie).toBeTruthy();
});
```

- [ ] **Step 3: Run focused tests and confirm the new services are absent**

Run: `npx vitest run --config vitest.core.config.ts tests/control-auth.test.ts tests/control-enrollment.test.ts`

Expected: FAIL.

- [ ] **Step 4: Generalize cookie formatting for sealed values**

Keep names `admin_session`, `device_session`, and `device_request`. Change device/request cookies to `SameSite=Lax` to match the approved cross-navigation/OAuth-safe contract, while preserving `Secure`, `HttpOnly`, `Path=/`, explicit expiry, and exact clear-cookie attributes. Cookie helpers do not parse or verify sealed values.

- [ ] **Step 5: Implement sealed admin/device authentication**

`authenticateControlAdmin()` opens the admin cookie, consumes the `ControlRequestContext` created by the HTTP layer, verifies household and `adminPassphraseVersion`, and derives CSRF from sealed `sessionId`. `authenticateControlDevice()` opens the device cookie, consumes the same request context, verifies enabled/not-revoked/current `sessionVersion`, and never updates `lastSeenAt`. Neither auth function calls `ControlPlaneStore.load()`.

Admin login reads the active control document, verifies Argon2, waits at least the configured failed-login delay, and issues a one-year sealed cookie. Logout only clears the cookie; there is no session mutation.

- [ ] **Step 6: Implement control-document enrollment**

Creating a request hashes a fresh request secret, writes one pending request mutation, and issues a 30-minute sealed request cookie containing request ID and raw secret. Polling opens the cookie, hashes the embedded secret, compares it with `requestSecretHash`, and reads only active Vercel state. Approval creates the device with `sessionVersion: 1`, sets the request status to approved, and records `approvedDeviceId`. The next TV poll using the original secret-bound request cookie issues the device cookie and clears the request cookie. Denial/expiry clears the request cookie.

- [ ] **Step 7: Run focused and existing HTTP auth tests**

Run: `npx vitest run --config vitest.core.config.ts tests/control-auth.test.ts tests/control-enrollment.test.ts tests/http-auth.test.ts tests/device-enrollment.test.ts`

Expected: the new tests PASS. Existing tests may require compatibility wrappers but must continue passing until Task 18 removes the legacy app.

- [ ] **Step 8: Commit sealed authentication and enrollment**

```powershell
git add packages/server/src/auth/cookies.ts packages/server/src/services/control-auth.ts packages/server/src/services/control-enrollment.ts packages/server/src/index.ts tests/control-auth.test.ts tests/control-enrollment.test.ts
git commit -m "Replace stored sessions with sealed cookies"
```

### Task 7: Replace stored OAuth state and source records with sealed OAuth control flow

**Files:**
- Create: `packages/server/src/services/control-oauth.ts`
- Create: `tests/control-oauth.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `SealedSessionCodec`, `ControlPlaneStore`, `ProviderRegistry`, provider-token keyring.
- Produces: `ControlOAuthService.beginAuthorization()` and `.completeAuthorization()`.

- [ ] **Step 1: Write failing OAuth-state tests**

```ts
it("stores PKCE state only in a sealed ten-minute cookie", async () => {
  const started = await oauth.beginAuthorization({
    householdId: "h1",
    adminSessionId: "admin-1",
    provider: "google",
    redirectUri: "https://app.test/api/admin/sources/google/callback"
  });
  expect(started.stateCookie).not.toMatch(/verifier|admin-1|google/);
  expect(harness.controlDocument.pendingDeviceRequests).toEqual({});
  expect(harness.mirror.writeCount).toBe(0);
});

it("rejects replay through the Runtime Cache replay marker", async () => {
  const started = await beginGoogle();
  await oauth.completeAuthorization(callback(started));
  await expect(oauth.completeAuthorization(callback(started))).rejects.toMatchObject({ code: "OAUTH_STATE_INVALID" });
});
```

- [ ] **Step 2: Run the OAuth test and confirm missing service**

Run: `npx vitest run --config vitest.core.config.ts tests/control-oauth.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement sealed PKCE state**

`beginAuthorization()` verifies an optional reconnect source from active control state, generates raw state and PKCE verifier, seals them into the OAuth cookie bound to admin session/provider/redirect/reconnect ID, and passes only raw state + challenge to the provider adapter.

`completeAuthorization()` opens the cookie, constant-time compares the state hash, validates binding/expiry, checks `oauth-used:{stateHash}` in Runtime Cache, performs the provider exchange, gets provider root, and atomically connects/reconnects the source through `ControlPlaneStore.mutate()`. Set the replay marker for ten minutes only after the provider response has passed account/root validation and immediately before the committed mutation.

- [ ] **Step 4: Preserve reconnect and credential safety rules**

Require the same provider account and provider root on reconnect. Retain the current refresh token only when the provider omits a new one. Increment `credentialVersion` when reconnecting. Store encrypted refresh token and optional encrypted bootstrap access token. A new source starts `healthy` with no sync fields and no automatic root.

- [ ] **Step 5: Run focused OAuth and provider tests**

Run: `npx vitest run --config vitest.core.config.ts tests/control-oauth.test.ts tests/provider-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the sealed OAuth flow**

```powershell
git add packages/server/src/services/control-oauth.ts packages/server/src/index.ts tests/control-oauth.test.ts
git commit -m "Move OAuth state into sealed cookies"
```

### Task 8: Add an access-token credential broker with zero routine Firestore traffic

**Files:**
- Create: `packages/server/src/services/credential-broker.ts`
- Create: `tests/credential-broker.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: active control state, provider-token keyring, provider registry, Runtime Cache, `rotateSourceCredentialsMutation()`.
- Produces: `CredentialBroker.get(sourceId, householdId)` returning current provider credentials.

- [ ] **Step 1: Write failing cache, refresh, rotation, and reauth tests**

```ts
it("refreshes an expired access token without reading or writing Firestore", async () => {
  const credentials = await broker.get("source-1", "h1");
  expect(credentials.accessToken).toBe("fresh-access");
  expect(harness.provider.refreshCalls).toBe(1);
  expect(harness.mirror.writeCount).toBe(0);
});

it("persists exactly one control mutation when the provider rotates the refresh token", async () => {
  harness.provider.refreshToken = "rotated-refresh";
  await broker.get("source-1", "h1");
  await harness.deferred.flush();
  expect(harness.store.current.sources["source-1"].credentialVersion).toBe(2);
  expect(harness.mirror.writeCount).toBe(1);
});

it("marks a source reauthorization-required after a definitive invalid grant", async () => {
  harness.provider.error = new ProviderError("PROVIDER_REAUTH_REQUIRED", "safe", { retryable: false });
  await expect(broker.get("source-1", "h1")).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
  expect(harness.store.current.sources["source-1"].status).toBe("reauth-required");
});
```

- [ ] **Step 2: Run focused tests and confirm missing broker**

Run: `npx vitest run --config vitest.core.config.ts tests/credential-broker.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement encrypted Runtime Cache credential records**

Cache key: `source:{sourceId}:credentials:{credentialVersion}`. Cache payload contains only an encrypted access token and ISO expiry. The durable encrypted refresh token remains in the active control document and is decrypted only inside the credential broker when a refresh call is required. TTL is `max(1, floor((expiry-now)/1000)-60)`.

On cache miss, use a still-valid bootstrap access token if present; otherwise decrypt the refresh token and call `refreshCredentials()`. Deduplicate concurrent refreshes per process with a promise map. Retry one provider request after refresh, not the refresh call itself.

- [ ] **Step 4: Implement conditional refresh-token rotation**

When a response includes a different refresh token, call `ControlPlaneStore.mutate()` with expected source `credentialVersion` and expected encrypted refresh-token identity. Increment `credentialVersion`, cache under the new key, and let the full control mutation mirror once. If a concurrent refresh already advanced the version, reload and use the winning credentials rather than overwriting them.

- [ ] **Step 5: Run focused tests and prior token tests**

Run: `npx vitest run --config vitest.core.config.ts tests/credential-broker.test.ts tests/oauth.test.ts tests/auth.test.ts`

Expected: PASS or only obsolete legacy assertions identified for replacement/removal in Task 18; no security regression.

- [ ] **Step 6: Commit credential brokering**

```powershell
git add packages/server/src/services/credential-broker.ts packages/server/src/index.ts tests/credential-broker.test.ts
git commit -m "Cache provider access credentials on Vercel"
```

### Task 9: Extend provider adapters for live browse DTOs and safe direct URL vending

**Files:**
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/google-drive.ts`
- Modify: `packages/providers/src/onedrive.ts`
- Modify: `packages/providers/src/http.ts`
- Modify: `tests/provider-contract.test.ts`

**Interfaces:**
- Consumes: `ProviderCredentials` from the credential broker.
- Produces: provider pages suitable for live TV browsing, temporary thumbnail URLs, and direct media URLs.

- [ ] **Step 1: Add failing provider-contract tests for page filtering and direct Google playback**

```ts
it("returns provider folder children with only browser-relevant metadata", async () => {
  const page = await google.listFolder({
    credentials,
    folderId: "root",
    cursor: null,
    pageSize: 50
  });
  expect(page.items[0]).toEqual(expect.objectContaining({
    providerNodeId: "g-image-a",
    kind: "image",
    name: expect.any(String)
  }));
  expect(JSON.stringify(page)).not.toContain("access-token");
});

it("vends a Google alt=media URL and never fetches the file body", async () => {
  const result = await google.getMediaUrl({ credentials, providerNodeId: "g-video-a" });
  expect(result.url).toContain("/drive/v3/files/g-video-a?alt=media");
  expect(result.url).toContain("access_token=");
  expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("alt=media"), expect.anything());
});
```

- [ ] **Step 2: Run provider tests and capture the exact contract differences**

Run: `npx vitest run --config vitest.core.config.ts tests/provider-contract.test.ts`

Expected: new tests fail until adapter fields and URL assertions match the live-browse contract.

- [ ] **Step 3: Narrow `ProviderAdapter` to used live operations**

Keep:

```ts
beginAuthorization(input)
completeAuthorization(input)
refreshCredentials(source)
getRoot(credentials)
getNode(input)
listFolder(input)
getThumbnailUrl(input)
getMediaUrl(input)
```

Remove `getChanges()` and `ProviderChange`/`ChangesPage`, because no delta/index workflow consumes them. Keep `ProviderNode` metadata required by TV DTOs.

- [ ] **Step 4: Harden provider response boundaries**

Google `listFolder()` uses parent query, `trashed=false`, page size, `supportsAllDrives=true`, and the existing bounded field list. OneDrive uses a validated same-origin Graph next-link, `$top`, `$select`, and thumbnail expansion. Both adapters normalize only folders, images, and videos; unsupported documents may be returned internally as `null` and filtered.

Provider error messages remain normalized; never include upstream response bodies, request URLs containing tokens, or bearer headers.

- [ ] **Step 5: Preserve direct URL behavior**

Google builds the URL without fetching bytes. OneDrive performs only the metadata request for `@microsoft.graph.downloadUrl`. Both return expiry. Add explicit tests that `Range` and media bytes never enter Vercel code.

- [ ] **Step 6: Run provider and structured-log tests**

Run: `npx vitest run --config vitest.core.config.ts tests/provider-contract.test.ts tests/structured-logging.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit provider live-browse changes**

```powershell
git add packages/providers/src/types.ts packages/providers/src/google-drive.ts packages/providers/src/onedrive.ts packages/providers/src/http.ts tests/provider-contract.test.ts
git commit -m "Narrow providers to live media browsing"
```

### Task 10: Implement live admin folder selection without indexing

**Files:**
- Create: `packages/server/src/services/live-provider-folders.ts`
- Create: `tests/live-provider-folders.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: `ControlPlaneStore`, `CredentialBroker`, `ProviderRegistry`, root mutation reducers.
- Produces: `LiveProviderFolderService.browse()`, `.resolveAncestry()`, and `.createRoot()`.

- [ ] **Step 1: Write failing live-folder tests**

```ts
it("lists provider folders from the API without reading indexed nodes", async () => {
  const page = await service.browse({
    householdId: "h1",
    sourceId: "source-1",
    providerFolderId: undefined,
    cursor: null,
    pageSize: 50
  });
  expect(page.folders.map(folder => folder.name)).toEqual(["Photos", "Movies"]);
  expect(harness.provider.listFolderCalls).toBe(1);
  expect(harness.firestoreReads).toBe(0);
});

it("saves a selected root immediately without starting a workflow", async () => {
  const result = await service.createRoot({ householdId: "h1", sourceId: "source-1", providerNodeId: "trips" });
  expect(result.root.displayName).toBe("Trips");
  expect(harness.store.current.roots[result.root.id]).toBeDefined();
  expect(JSON.stringify(result)).not.toMatch(/runId|started|index/);
});
```

- [ ] **Step 2: Run focused tests and confirm missing service**

Run: `npx vitest run --config vitest.core.config.ts tests/live-provider-folders.test.ts`

Expected: FAIL.

- [ ] **Step 3: Port live folder resolution without repository/indexer dependencies**

Reuse the current ancestry proof algorithm with these differences:

- read source/root configuration from one active control snapshot;
- get credentials from `CredentialBroker`;
- resolve at most 64 ancestors, rejecting cycles and non-folders;
- validate that ancestry reaches the connected provider root;
- look up assigned roots from the same snapshot;
- return browser-safe provider-folder DTOs;
- never call indexing, workflow, node, or sync APIs.

- [ ] **Step 4: Save roots through one control mutation**

Construct deterministic root ID with HMAC/SHA-256 over household/source/provider ID, save ancestry, set enabled true, and do not auto-assign it to devices. Return `{ root }` only.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run --config vitest.core.config.ts tests/live-provider-folders.test.ts tests/control-mutations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit indexing-free root selection**

```powershell
git add packages/server/src/services/live-provider-folders.ts packages/server/src/index.ts tests/live-provider-folders.test.ts
git commit -m "Save live provider folders without indexing"
```

### Task 11: Implement TV live browsing with sealed handles and provider cursors

**Files:**
- Create: `packages/server/src/services/live-browse.ts`
- Create: `tests/live-browse.test.ts`
- Modify: `packages/shared/src/sorting.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: authenticated device, request-scoped active control document, `BrowseHandleCodec`, `CredentialBroker`, providers.
- Produces: `LiveBrowseService.home()` and `.folder()`.

- [ ] **Step 1: Write failing home, folder, and authorization tests**

```ts
it("returns assigned roots without provider or Firestore calls", async () => {
  const home = await browse.home(deviceAuth);
  expect(home.roots).toEqual([
    expect.objectContaining({ id: expect.stringMatching(/^item_/), handle: expect.any(String), displayName: "Trips" })
  ]);
  expect(harness.provider.calls).toBe(0);
  expect(harness.firestoreReads).toBe(0);
});

it("lists one provider folder page and signs every returned item", async () => {
  const page = await browse.folder(deviceAuth, rootHandle, null, 50);
  expect(harness.provider.listFolderCalls).toBe(1);
  expect(page.children.every(item => item.id.startsWith("item_") && item.handle.length > 20)).toBe(true);
  expect(JSON.stringify(page)).not.toMatch(/providerNodeId|accessToken/);
});

it.each(["wrong-device", "unassigned-root", "disabled-source", "stale-credential", "expired-handle"])(
  "fails closed for %s",
  async scenario => expect(runScenario(scenario)).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|NAVIGATION_EXPIRED|DEVICE_UNAUTHORIZED/) })
);
```

- [ ] **Step 2: Run focused tests and confirm missing service**

Run: `npx vitest run --config vitest.core.config.ts tests/live-browse.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement current-state handle authorization**

`authorizeHandle(auth, context, sealedHandle)` opens the handle and validates against `context.document`:

- claims household/device equal authenticated claims;
- device still exists, enabled, not revoked, current session version;
- root exists, enabled, and assigned to device;
- root source matches claim;
- source exists, healthy, and current `credentialVersion` equals claim.

Return `NAVIGATION_EXPIRED` for expiry/version changes and indistinguishable `ITEM_NOT_FOUND` for unauthorized root/source/node relationships.

- [ ] **Step 4: Implement home and root handles**

Home consumes the request-scoped active document, filters assigned enabled roots with healthy sources, generates stable root IDs and sealed folder handles, and returns neutral root cards without counts, readiness, or mosaics. It performs no provider call and does not load control state again.

- [ ] **Step 5: Implement one-page live folder browse**

Folder browse validates page size 1-100, opens and validates an optional sealed cursor, obtains credentials, calls `listFolder()` once, filters supported records, maps them to final TV DTOs, and seals renewed item/cursor claims for 30 minutes. Set `parent` from the requested handle. Breadcrumbs are owned by the TV navigation stack and are not returned from the server.

- [ ] **Step 6: Adapt sorting to `TvBrowseItemDto`**

Replace `sortFolderListing(MediaNode[])` with a generic comparator usable for provider DTOs:

```ts
export function sortBrowseItems<T extends Pick<TvBrowseItemDto,
  "kind" | "name" | "capturedAt" | "createdAtProvider" | "modifiedAtProvider"
>>(items: readonly T[], order: MediaOrder): T[];
```

Remove index-only `selectFolderCoverNodeIds()` after all indexer consumers are removed in Task 18.

- [ ] **Step 7: Run browse and sorting tests**

Run: `npx vitest run --config vitest.core.config.ts tests/live-browse.test.ts tests/sorting.test.ts tests/browse-handles.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit sealed live browsing**

```powershell
git add packages/server/src/services/live-browse.ts packages/shared/src/sorting.ts packages/server/src/index.ts tests/live-browse.test.ts tests/sorting.test.ts
git commit -m "Browse provider folders live on TV"
```

### Task 12: Implement direct thumbnail and media URL vending plus Runtime Cache rate limits

**Files:**
- Create: `packages/server/src/services/direct-media.ts`
- Create: `packages/server/src/services/runtime-rate-limit.ts`
- Create: `tests/direct-media.test.ts`
- Create: `tests/runtime-rate-limit.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: live-browse handle authorization, credential broker, providers, Runtime Cache.
- Produces: `DirectMediaService.thumbnails()` and `.media()` plus `RuntimeRateLimiter.consume()`.

- [ ] **Step 1: Write failing direct-streaming tests**

```ts
it("returns a Google URL while Vercel handles no media body", async () => {
  const result = await media.media(deviceAuth, googleVideoHandle);
  expect(new URL(result.url).hostname).toBe("www.googleapis.com");
  expect(result.url).toContain("alt=media");
  expect(result.url).toContain("access_token=");
  expect(result.responseHeaders).toMatchObject({
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer"
  });
  expect(harness.vercelBodyBytes).toBe(0);
});

it("returns the OneDrive pre-authorized URL", async () => {
  const result = await media.media(deviceAuth, oneDriveVideoHandle);
  expect(new URL(result.url).hostname).toMatch(/sharepoint|onedrive|microsoft/);
});

it("does not expose raw handles or provider ids to thumbnail providers", async () => {
  const result = await media.thumbnails(deviceAuth, [imageHandle], 720);
  expect(result.items[0].itemId).toMatch(/^item_/);
  expect(JSON.stringify(result)).not.toMatch(/providerNodeId|sealed-item/);
});
```

- [ ] **Step 2: Write failing ephemeral rate-limit tests**

```ts
it("stores only an HMAC request subject in Runtime Cache", async () => {
  await limiter.consume("admin-login", "203.0.113.7", now, { limit: 2, windowSeconds: 60 });
  expect(harness.cache.keys.join(" ")).not.toContain("203.0.113.7");
});

it("fails open only for the limiter when cache is unavailable", async () => {
  harness.cache.fail = true;
  await expect(limiter.consume("url-vending", "device-1", now, policy)).resolves.toMatchObject({ allowed: true });
});
```

- [ ] **Step 3: Run focused tests and confirm missing services**

Run: `npx vitest run --config vitest.core.config.ts tests/direct-media.test.ts tests/runtime-rate-limit.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement direct URL vending**

Thumbnails accept at most 100 unique sealed handles and dimension 64-4096. Authorize each handle against one loaded control snapshot, group by source, reuse credentials, and return ready/unavailable entries. Media accepts one sealed image/video handle, calls provider `getMediaUrl()`, and returns URL/expiry/revision with no-store/no-referrer headers. No server route accepts raw item/provider IDs.

- [ ] **Step 5: Implement best-effort Runtime Cache fixed windows**

Use key `rate:{bucket}:{hmacSubject}:{windowStart}`, a TTL of two windows, and JSON `{ count, expiresAt }`. Because Runtime Cache has no atomic increment, this is intentionally best-effort and must never be described as a strict quota. Clamp all policies and return allowed when cache operations fail; application authentication and body/page/batch validation remain independent.

- [ ] **Step 6: Run focused media, provider, and log tests**

Run: `npx vitest run --config vitest.core.config.ts tests/direct-media.test.ts tests/runtime-rate-limit.test.ts tests/provider-contract.test.ts tests/structured-logging.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit direct media vending and ephemeral limiting**

```powershell
git add packages/server/src/services/direct-media.ts packages/server/src/services/runtime-rate-limit.ts packages/server/src/index.ts tests/direct-media.test.ts tests/runtime-rate-limit.test.ts
git commit -m "Vend provider media without proxying bytes"
```

### Task 13: Compose the final Vercel HTTP API without Firestore reads

**Files:**
- Create: `packages/server/src/http/request-context.ts`
- Create: `packages/server/src/http/control-app.ts`
- Create: `tests/control-http-app.test.ts`
- Create: `tests/firestore-budget.test.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `tests/helpers/api.ts`

**Interfaces:**
- Consumes: control auth/admin/enrollment/OAuth/live folders/live browse/direct media/rate limiter.
- Produces: `createControlApiApp(dependencies): (request: Request) => Promise<Response>`.
- Produces: `ControlRequestContext` containing exactly one verified document/revision for the request.
- The dependency type contains `ControlPlaneStore` and services only; it cannot name `Firestore`, `AppRepository`, or a read-capable mirror.

- [ ] **Step 1: Write failing route and composition tests**

```ts
it("serves the final route table with no sync or server-history endpoints", async () => {
  expect((await app(jsonRequest("/api/admin/snapshot", "GET", undefined, adminHeaders))).status).toBe(200);
  expect((await app(jsonRequest("/api/internal/sync-due-sources", "GET"))).status).toBe(404);
  expect((await app(jsonRequest("/api/tv/watch-history", "GET", undefined, deviceHeaders))).status).toBe(404);
});

it("accepts sealed handles, not raw node ids", async () => {
  const response = await app(jsonRequest("/api/tv/media-url", "POST", { handle: "sealed-media" }, deviceHeaders));
  expect(response.status).toBe(200);
  const rejected = await app(jsonRequest("/api/tv/media-url", "POST", { nodeId: "node-1" }, deviceHeaders));
  expect(rejected.status).toBe(400);
});

it("does not expose a Firestore repository in API dependencies", () => {
  const source = readFileSync("packages/server/src/http/control-app.ts", "utf8");
  expect(source).not.toMatch(/AppRepository|FirestoreRepository|createFirestoreClient/);
});

it("loads and revalidates the active control snapshot once per protected request", async () => {
  await harness.app(harness.folderRequest());
  expect(harness.controlStore.loadCount).toBe(1);
  expect(harness.durable.conditionalReadCount).toBe(1);
});
```

- [ ] **Step 2: Write the 10,000-request zero-read budget test**

```ts
it("performs zero Firestore reads across 10,000 browse and media requests", async () => {
  const harness = createControlApiHarness();
  for (let index = 0; index < 5_000; index += 1) {
    await harness.app(harness.folderRequest());
    await harness.app(harness.mediaRequest());
  }
  expect(harness.firestore.readCount).toBe(0);
  expect(harness.firestore.writeCount).toBe(0);
});
```

Use fully in-memory provider/cache/Blob fakes so the loop is deterministic and completes quickly.

- [ ] **Step 3: Run the new HTTP tests and confirm missing app**

Run: `npx vitest run --config vitest.core.config.ts tests/control-http-app.test.ts tests/firestore-budget.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement the final route table**

Create a `ControlRequestContext` at the start of each protected route by calling `controlStore.load()` once. Pass its document/revision to auth and downstream services; they must not call `load()` again. Public bootstrap without any session/request cookie may load once to read `allowNewDeviceRequests`. Login loads once for passphrase verification. Mutations use `mutate()` as the single authoritative reload/CAS boundary.

Then implement the final route table.

Required routes:

```text
GET    /api/bootstrap
POST   /api/admin/login
POST   /api/admin/logout
GET    /api/admin/snapshot
PATCH  /api/admin/settings
POST   /api/admin/passphrase
GET    /api/admin/requests
POST   /api/admin/requests/{id}/approve
POST   /api/admin/requests/{id}/deny
GET    /api/admin/devices
GET|PATCH|DELETE /api/admin/devices/{id}
GET    /api/admin/sources
POST   /api/admin/sources/{provider}/authorize
GET    /api/admin/sources/{provider}/callback
GET    /api/admin/sources/{id}/impact
DELETE /api/admin/sources/{id}
GET    /api/admin/sources/{id}/provider-folders
POST   /api/admin/sources/{id}/roots
GET    /api/admin/roots/{id}/impact
DELETE /api/admin/roots/{id}
POST   /api/device-requests
GET    /api/device-requests/status
GET    /api/tv/home
GET    /api/tv/folders/{handle}
POST   /api/tv/thumbnail-urls
POST   /api/tv/media-url
```

Keep structured request IDs, bounded JSON parsing, safe error mapping, CSRF/origin checks, cookie clearing, no-store JSON, and response security headers. Remove heartbeat; no `lastSeenAt` write exists.

- [ ] **Step 5: Consolidate the test harness around the control store**

Replace `MemoryRepository` in `tests/helpers/api.ts` with `createMemoryControlPlane()`, sealed codecs, fake providers, and `createControlApiApp()`. Expose counts for durable reads/writes, cache reads, mirror writes, and provider calls. Preserve `jsonRequest()`, cookie helpers, deterministic IDs/tokens, and origin helpers.

- [ ] **Step 6: Run final HTTP and budget tests**

Run: `npx vitest run --config vitest.core.config.ts tests/control-http-app.test.ts tests/firestore-budget.test.ts tests/control-auth.test.ts tests/control-enrollment.test.ts tests/control-admin.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the final HTTP composition**

```powershell
git add packages/server/src/http/control-app.ts packages/server/src/index.ts tests/helpers/api.ts tests/control-http-app.test.ts tests/firestore-budget.test.ts
git commit -m "Compose zero-read Vercel API"
```

### Task 14: Store watch history locally on the TV

**Files:**
- Create: `apps/tv/src/state/local-watch-history.ts`
- Create: `apps/tv/src/state/local-watch-history.test.ts`
- Modify: `apps/tv/src/api/client.ts`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/components/viewer.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `apps/tv/src/app.test.tsx`

**Interfaces:**
- Produces: `createLocalWatchHistory(storage, deviceId, now)` with `list()`, `get(itemId)`, `save(itemId, value)`, and `clear()`.
- Removes: `TvApi.history()` and `TvApi.saveHistory()`.

- [ ] **Step 1: Write failing local-history tests**

```ts
it("persists history by pseudonymous item id and caps it at 500 newest entries", () => {
  const history = createLocalWatchHistory(memoryStorage(), "device-1", () => now);
  for (let index = 0; index < 501; index += 1) {
    history.save(`item_${index}`, { positionSeconds: index, durationSeconds: 1000, completed: false });
  }
  expect(history.list()).toHaveLength(500);
  expect(history.get("item_0")).toBeNull();
});

it("recovers from corrupt or unavailable localStorage without blocking playback", () => {
  const history = createLocalWatchHistory(throwingStorage(), "device-1", () => now);
  expect(history.list()).toEqual([]);
  expect(() => history.save("item_1", validHistory())).not.toThrow();
  expect(history.available).toBe(false);
});
```

- [ ] **Step 2: Run the local-history test and confirm missing store**

Run: `npx vitest run --config vitest.core.config.ts apps/tv/src/state/local-watch-history.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the local store**

Use key `cloudframe.tv.watch-history.v1:${deviceId}`. Store schema:

```ts
interface StoredWatchHistoryV1 {
  version: 1;
  entries: Record<string, {
    positionSeconds: number;
    durationSeconds: number;
    completed: boolean;
    updatedAt: string;
  }>;
}
```

Validate finite ranges with the current 366-day ceiling, discard corrupt entries, sort by update time, cap at 500, and never store handles, provider IDs, tokens, URLs, or names.

- [ ] **Step 4: Remove server history methods from the TV API**

Delete `history()` and `saveHistory()` from `TvApi` and `tvApi`. Change `TvApp` to create the local store only after a ready device is known and pass it into `BrowserShell`/`Viewer`.

- [ ] **Step 5: Rewire viewer persistence**

Replace asynchronous API calls with local reads/writes. Preserve saving no more than every 15 seconds and on pause/ended/item change/close. Do not reload history from the server on viewer close. Expose a polite, non-blocking message only if local history is unavailable; playback still works.

- [ ] **Step 6: Run TV history and viewer tests**

Run: `npx vitest run --config vitest.core.config.ts apps/tv/src/state/local-watch-history.test.ts apps/tv/src/components/viewer.test.tsx apps/tv/src/app.test.tsx tests/viewer-state.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit local TV history**

```powershell
git add apps/tv/src/state/local-watch-history.ts apps/tv/src/state/local-watch-history.test.ts apps/tv/src/api/client.ts apps/tv/src/app.tsx apps/tv/src/components/viewer.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/app.test.tsx
git commit -m "Store playback history locally on TV"
```

### Task 15: Move the TV application to sealed-handle live browsing

**Files:**
- Modify: `apps/tv/src/api/client.ts`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/components/folder-card.tsx`
- Modify: `apps/tv/src/components/media-card.tsx`
- Modify: `apps/tv/src/components/source-drawer.tsx`
- Modify: `apps/tv/src/components/tv-header.tsx`
- Modify: `apps/tv/src/components/viewer.tsx`
- Modify: `apps/tv/src/styles/app.css`
- Modify: `apps/tv/src/app.test.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `apps/tv/src/components/source-drawer.test.tsx`

**Interfaces:**
- Consumes: final shared TV DTOs and direct media responses.
- Produces: live folder navigation using item/root handles and local breadcrumbs.

- [ ] **Step 1: Update TV API tests first**

Add assertions that:

```ts
api.folder("sealed-folder", "sealed-cursor")
// GET /api/tv/folders/{encoded handle}?cursor={encoded cursor}

api.thumbnailUrls(["sealed-image"], signal)
// body: { handles: ["sealed-image"], maxDimension: 720 }

api.mediaUrl("sealed-video", signal)
// body: { handle: "sealed-video" }
```

Run: `npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx`

Expected: FAIL because the TV still sends indexed node IDs.

- [ ] **Step 2: Change navigation state from node IDs to sealed handles**

`BrowseItem` contains public `id` plus `handle`. `openItem()` uses `handle`; focus restoration/history uses `id`. The stack stores the previous folder handle, focused public ID/index, scroll, loaded sealed cursors, and local breadcrumb DTOs. Back navigation replays provider pages as needed and never asks the server to reconstruct ancestry.

- [ ] **Step 3: Remove indexed root readiness, counts, and folder mosaics**

Root cards render display name, provider, and account label with the existing program artwork. Folder cards render static collection artwork and no descendant count. Remove `ProgramStatus`, `folderCoverNodeIds`, `childFolderCount`, `childMediaCount`, `readiness`, and “preparing/indexing” branches from TV code and copy.

- [ ] **Step 4: Rewire thumbnails and viewer URL requests**

Visible entries send their sealed handles, then map returned `itemId` to the public DTO ID. Viewer sends the active item's sealed handle. Media URLs stay only in component state and are cleared on expiry/close/navigation. Keep no-referrer document/meta behavior in `apps/tv/index.html`.

- [ ] **Step 5: Preserve Chromium 68 and focus behavior**

No optional browser APIs without existing polyfills. Manual-only controls remain outside initial focus. Preserve source drawer, Back behavior, virtual grid, viewer arrow navigation, slideshow, seek, and authorization-error recovery.

- [ ] **Step 6: Run the focused TV suite**

Run: `npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/components/source-drawer.test.tsx apps/tv/src/components/virtual-grid.test.tsx tests/tv-focus.test.ts tests/viewer-state.test.ts`

Run: `npm run build -w @cloudframe/tv`

Run: `node scripts/check-tv-bundle.mjs`

Expected: PASS.

- [ ] **Step 7: Commit live TV browsing**

```powershell
git add apps/tv/src apps/tv/index.html
git commit -m "Use live provider handles on TV"
```

### Task 16: Simplify the admin application to one snapshot and live configuration

**Files:**
- Modify: `apps/admin/src/api/client.ts`
- Modify: `apps/admin/src/api/client.test.ts`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/app.test.tsx`
- Modify: `apps/admin/src/components/household-program.tsx`
- Modify: `apps/admin/src/components/source-workbench.tsx`
- Modify: `apps/admin/src/components/source-workbench.test.tsx`
- Modify: `apps/admin/src/components/sources.tsx`
- Modify: `apps/admin/src/components/settings.tsx`
- Modify: `apps/admin/src/components/provider-folder-stage.tsx`
- Modify: `apps/admin/src/components/provider-folder-stage.test.tsx`
- Delete: `apps/admin/src/components/index-status.tsx`

**Interfaces:**
- Consumes: `AdminSnapshotResponse` and final source/root/device/request DTOs.
- Produces: one admin-load request and indexing-free source/root UI.

- [ ] **Step 1: Write failing client and app-load tests**

```ts
it("loads the admin with one snapshot request", async () => {
  const api = createAdminApi(fetchMock.mockResolvedValue(ok(snapshot, "csrf-next")));
  await api.snapshot();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/snapshot", expect.anything());
});

it("does not request overview, settings, and sources separately", async () => {
  render(<AdminApp api={apiWithSnapshot(snapshot)} />);
  await screen.findByText("Household overview");
  expect(api.snapshot).toHaveBeenCalledTimes(1);
  expect("overview" in api).toBe(false);
  expect("settings" in api).toBe(false);
  expect("sources" in api).toBe(false);
});
```

- [ ] **Step 2: Run admin tests and confirm the old three-request behavior fails**

Run: `npx vitest run --config apps/admin/vitest.config.ts src/api/client.test.ts src/app.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Collapse API client and app state to one snapshot**

Replace `overview()`, `settings()`, and `sources()` reads with `snapshot()`. Mutations return focused results/revision, then `AdminApp.refresh()` reloads the single snapshot. Keep safe CSRF-token rotation and network error normalization.

- [ ] **Step 4: Remove every indexing and quota concept from admin UI**

Delete `IndexStatus`, Sync Now buttons, cadence card, index metrics, Firestore document estimates, quota recovery copy, processed/pending counts, and queued/indexing/reconciling states. Source status is one of Connected, Reauthorization required, Disabled, or Provider temporarily unavailable.

Change source-workbench copy to:

```text
Browse the provider live. Folders added to the household program are available to assigned televisions immediately.
```

Root removal copy must say access is removed immediately; do not mention reconciliation.

- [ ] **Step 5: Keep live folder selection and impact workflows**

The provider stage still pages live through Vercel. Root creation returns `{ root }`; update the local ledger immediately and refresh once. Source/root impact and device assignments remain explicit. Disabled legacy whole-drive roots may be shown as inactive migration records but cannot imply indexing.

- [ ] **Step 6: Replace settings health with control-plane truth**

Show counts for approved devices, connected sources, approved roots, pending requests, and recovery-copy status. If `recoveryCopy.status === "delayed"`, show “Recovery copy delayed; active service remains on Vercel” without claiming data loss.

- [ ] **Step 7: Run the full admin suite**

Run: `npx vitest run --config apps/admin/vitest.config.ts`

Run: `npm run build -w @cloudframe/admin`

Expected: PASS.

- [ ] **Step 8: Commit the simplified admin control plane**

```powershell
git add -u apps/admin/src
git add apps/admin/src
git commit -m "Remove indexing from household administration"
```

### Task 17: Add migration, recovery, and bounded legacy-cookie exchange

**Files:**
- Create: `scripts/lib/control-plane-ops.ts`
- Create: `scripts/migrate-vercel-control-plane.ts`
- Create: `scripts/restore-vercel-control-plane.ts`
- Create: `packages/server/src/control-plane/legacy-session-exchange.ts`
- Create: `tests/control-plane-ops.test.ts`
- Create: `tests/legacy-session-exchange.test.ts`
- Modify: `tests/ops-scripts.test.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Produces: dry-run-first migration/restore functions with injectable Firestore/Blob adapters.
- Produces temporary `LegacySessionExchange.exchangeAdmin()` and `.exchangeDevice()` used only during cutover.

- [ ] **Step 1: Write failing migration-plan tests**

```ts
it("reads only household, devices, pending requests, sources, and roots", async () => {
  const firestore = recordingLegacyReader();
  const plan = await buildControlPlaneMigrationPlan(firestore, "h1", now);
  expect(firestore.collectionsRead).toEqual([
    "households", "deviceRequests", "devices", "sources", "roots"
  ]);
  expect(firestore.collectionsRead).not.toEqual(expect.arrayContaining(["nodes", "watchHistory", "rateLimits"]));
  expect(plan.document.schemaVersion).toBe(2);
});

it("restore reads exactly one recovery document and prints only counts", async () => {
  const result = await restoreControlPlane({ apply: false, ...harness });
  expect(harness.firestore.documentReads).toEqual(["controlPlaneBackups/h1"]);
  expect(JSON.stringify(result)).not.toMatch(/token|hash|providerNodeId|ciphertext/i);
});
```

- [ ] **Step 2: Write failing one-time legacy exchange tests**

```ts
it("exchanges an existing device cookie once and issues a sealed v2 cookie", async () => {
  const result = await exchange.exchangeDevice("legacy-raw-token", now);
  expect(result?.sealedCookie).toBeTruthy();
  expect(harness.firestore.readCount).toBeGreaterThan(0);
  expect(harness.firestore.writeCount).toBe(0);
  await expect(exchange.exchangeDevice(result!.sealedCookie, now)).resolves.toBeNull();
});
```

- [ ] **Step 3: Run focused operations tests and confirm missing scripts**

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-ops.test.ts tests/legacy-session-exchange.test.ts tests/ops-scripts.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement a dry-run migration library**

Use injectable exact-path/query readers in tests. Production migration may query only the five named collections. Convert dates to ISO, remove `lastSeenAt`/sync/checkpoint fields, include only pending unexpired requests, require non-null verified provider account/root IDs, retain enabled selected roots, and retain disabled legacy whole-drive roots only as disabled records. Validate the final control document before output.

The report is exactly:

```ts
{
  apply: boolean;
  householdId: string;
  revision: number;
  counts: { devices: number; pendingRequests: number; sources: number; roots: number };
  checksum: string;
}
```

No IDs or secret-bearing fields are printed.

- [ ] **Step 5: Implement apply mode and recovery**

Migration apply encrypts and creates/replaces the private Blob snapshot, writes the one Firestore recovery document, then reads Blob and the one recovery document back to compare revision/checksum. Refuse apply unless `--apply` is explicit. Require an environment namespace such as `CONTROL_PLANE_ENV=production|preview` and derive distinct Blob path/cache keys.

Restore dry-run reads exactly `controlPlaneBackups/{householdId}`, validates it, and reports counts/checksum. Apply mode writes Blob/cache. It never changes Firestore.

- [ ] **Step 6: Implement the temporary legacy exchange boundary**

Keep legacy Firestore session reads in this isolated file only. It may read session by token hash, device/household for device sessions, or admin session/household for admin. It validates current revocation/expiry/version, issues the sealed cookie, and performs no write. `deploy/api-entry.ts` enables it only while `ENABLE_LEGACY_SESSION_EXCHANGE=1` and creates it with a separate `GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL` identity that has exact temporary read permissions and no write permission.

Add a source scan test asserting no other final public HTTP/service file imports the legacy reader.

- [ ] **Step 7: Run operations tests**

Run: `npx vitest run --config vitest.core.config.ts tests/control-plane-ops.test.ts tests/legacy-session-exchange.test.ts tests/ops-scripts.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit migration and recovery tooling**

```powershell
git add scripts/lib/control-plane-ops.ts scripts/migrate-vercel-control-plane.ts scripts/restore-vercel-control-plane.ts packages/server/src/control-plane/legacy-session-exchange.ts packages/server/src/index.ts tests/control-plane-ops.test.ts tests/legacy-session-exchange.test.ts tests/ops-scripts.test.ts
git commit -m "Add control-plane migration and recovery"
```

### Task 18: Switch production composition and remove indexing, Workflows, and the dormant Next.js app

**Files:**
- Modify: `deploy/api-entry.ts`
- Modify: `scripts/build-vercel.mjs`
- Modify: `deploy/vercel-build-contract.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `packages/server/package.json`
- Modify: `packages/server/src/index.ts`
- Modify: `tsconfig.base.json`
- Modify: `vitest.core.config.ts`
- Modify: `vercel.json`
- Modify: `firestore.indexes.json`
- Modify: `.env.example`
- Delete: `packages/indexer/`
- Delete: `workflows/`
- Delete: `packages/server/src/runtime/sync-runner.ts`
- Delete: `packages/server/src/services/indexing.ts`
- Delete: `packages/server/src/services/browse.ts`
- Delete: `packages/server/src/services/media-urls.ts`
- Delete: `packages/server/src/services/provider-folders.ts`
- Delete: `packages/server/src/services/sources.ts`
- Delete: `packages/server/src/services/oauth.ts`
- Delete: `packages/server/src/services/admin-auth.ts`
- Delete: `packages/server/src/services/device-auth.ts`
- Delete: `packages/server/src/services/device-enrollment.ts`
- Delete: `packages/server/src/services/bootstrap.ts`
- Delete: `packages/server/src/http/app.ts`
- Delete: `packages/server/src/firestore/repository.ts`
- Delete: `packages/server/src/firestore/memory-repository.ts`
- Delete: `packages/server/src/firestore/decode.ts`
- Delete: `src/`
- Delete: `next.config.ts`
- Delete or rewrite: `tests/indexer.test.ts`, `tests/workflow-runtime.test.ts`, `tests/repository.test.ts`, `tests/browse-authorization.test.ts`, `tests/media-url.test.ts`, `tests/oauth.test.ts`, `tests/http-auth.test.ts`, `tests/device-enrollment.test.ts`, `tests/admin-management-api.test.ts`, `tests/admin-mutation-boundary.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/workspace.test.ts`
- Modify: `tests/e2e-config.test.ts`

**Interfaces:**
- Consumes: all final control-plane services.
- Produces: the only deployed API composition and a workflow-free Vercel Build Output API.

- [ ] **Step 1: Rewrite configuration tests before deleting legacy code**

Assert:

```ts
expect(root.workspaces).toEqual(["apps/*", "packages/*"]);
expect(root.dependencies).not.toHaveProperty("@cloudframe/indexer");
expect(root.dependencies).not.toHaveProperty("workflow");
expect(root.dependencies).not.toHaveProperty("@workflow/builders");
expect(vercel).not.toHaveProperty("crons");
expect(firestoreIndexes.indexes).toEqual([]);
expect(buildOutput.functions).toEqual(expect.arrayContaining(["api.func"]));
expect(buildOutput.functions.some(path => path.includes("workflow"))).toBe(false);
```

Add a workspace scan that rejects tracked runtime code under `src/` and rejects index repository calls, Firestore watch-history/rate-limit collections, `crawlCheckpoint`, `sync-due-sources`, or Workflow imports in `deploy/`, `apps/`, and active `packages/` code. Do not reject the new browser-local `local-watch-history.ts` merely because it contains the words “watch history.” Exclude migration compatibility fixtures/docs.

- [ ] **Step 2: Run config tests and confirm they fail against the legacy tree**

Run: `npx vitest run --config vitest.core.config.ts tests/config.test.ts tests/workspace.test.ts tests/e2e-config.test.ts`

Expected: FAIL.

- [ ] **Step 3: Compose production from final services**

`deploy/api-entry.ts` creates:

```ts
const householdId = required("HOUSEHOLD_ID");
const durable = createVercelBlobControlStore({
  householdId,
  environment: required("CONTROL_PLANE_ENV"),
  storeId: required("BLOB_STORE_ID")
});
const cache = createVercelRuntimeControlCache({
  householdId,
  environment: required("CONTROL_PLANE_ENV")
});
const firestore = createFirestoreClient({
  environment: process.env.VERCEL_ENV === "production" ? "production" : "staging",
  projectId: required("FIRESTORE_PROJECT_ID"),
  databaseId: process.env.FIRESTORE_DATABASE_ID,
  workloadIdentityProvider: required("GCP_WORKLOAD_IDENTITY_PROVIDER"),
  serviceAccountEmail: required("GCP_SERVICE_ACCOUNT_EMAIL")
});
const mirror = createFirestoreRecoveryMirror(firestore, householdId);
const controlStore = createControlPlaneStore({
  durable,
  cache,
  mirror,
  deferred: { run: promise => waitUntil(promise) },
  keyring: controlPlaneKeyringFromEnv()
});
const credentialBroker = createCredentialBroker({
  controlStore,
  cache,
  providers,
  providerTokenKeyring: providerTokenKeyringFromEnv(),
  now: () => new Date()
});
const app = createControlApiApp(
  createControlServices({ controlStore, cache, credentialBroker, providers, now: () => new Date() })
);
```

The write-only Firestore client is passed only to `createFirestoreRecoveryMirror()`; it is never passed to the public app or services. Configure `GCP_SERVICE_ACCOUNT_EMAIL` with a custom role containing `datastore.entities.create` and `datastore.entities.update` only, plus an IAM Condition scoped to the `controlPlaneBackups/{householdId}` resource path where supported. When legacy exchange is enabled, build a separate Firestore client using `GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL` and pass it only to `createLegacySessionExchange()`. The migration/restore operator identity is separate again and must not be reused by the steady-state runtime.

- [ ] **Step 4: Remove Workflow build machinery and dependencies**

`scripts/build-vercel.mjs` builds static output and one `api.func` only. Remove Workflow builder invocation, manifest parsing, generated workflow define, workflow routes, workflow packages, `packages/indexer`, and `workflows`. Keep native Argon2 package copying.

- [ ] **Step 5: Remove broad repository/runtime and dormant Next.js code**

Delete the listed legacy services/repository, the tracked `src/` Next.js app, and `next.config.ts`. Before deletion, port the still-relevant pure connection/pairing tests to final control-plane tests; delete `tests/connection-records.test.mjs`, `tests/management-pairing.test.mjs`, and `tests/reconfigure-state.test.mjs` only after equivalent behavior is covered. Remove `@cloudframe/indexer` aliases and exports.

- [ ] **Step 6: Reduce Firestore and environment configuration**

Set `firestore.indexes.json` to:

```json
{ "indexes": [], "fieldOverrides": [] }
```

Remove `CRON_SECRET`, `WORKFLOW_QUEUE_NAMESPACE`, and sync/index variables. Add:

```text
BLOB_STORE_ID=
CONTROL_PLANE_ENV=
CONTROL_PLANE_KEY_VERSION=v1
CONTROL_PLANE_KEY_V1=
SESSION_KEY_VERSION=v1
SESSION_KEY_V1=
BROWSE_HANDLE_KEY_VERSION=v1
BROWSE_HANDLE_KEY_V1=
BROWSE_ID_SECRET=
RATE_LIMIT_SECRET=
ENABLE_LEGACY_SESSION_EXCHANGE=1
GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL=
```

Keep provider token keys and Google/OneDrive OAuth secrets server-only.

- [ ] **Step 7: Remove obsolete tests only after replacement coverage passes**

Delete index/workflow/repository suites whose production units no longer exist. Rewrite HTTP/admin/enrollment/OAuth/media suites against `createControlApiApp()` rather than deleting behavior coverage. Ensure the total suite explicitly covers every final route and all prior security boundaries that remain relevant.

- [ ] **Step 8: Run configuration, type, and build tests**

Run: `npm install`

Run: `npx vitest run --config vitest.core.config.ts tests/config.test.ts tests/workspace.test.ts tests/e2e-config.test.ts tests/firestore-budget.test.ts`

If `tests/config.test.ts` invokes `scripts/build-vercel.mjs` directly, ensure it first runs `npm run build` when `dist/index.html` or `dist/admin/index.html` is absent so a fresh worktree has the required static inputs.

Run: `npm run typecheck`

Run: `npm run build:vercel`

Expected: PASS; `.vercel/output/functions` contains `api.func` and no workflow functions.

- [ ] **Step 9: Commit the architecture cutover**

```powershell
git add -u
git add deploy package.json package-lock.json packages scripts tests tsconfig.base.json vitest.core.config.ts vercel.json firestore.indexes.json .env.example
git commit -m "Remove Firestore media indexing runtime"
```

### Task 19: Update synthetic E2E journeys for live browsing and local history

**Files:**
- Modify: `e2e/fixtures.ts`
- Modify: `e2e/browse-viewer.spec.ts`
- Modify: `e2e/enrollment.spec.ts`
- Modify: `e2e/shared-api.spec.ts`
- Modify: `e2e/source-workbench.spec.ts`
- Update: `e2e/browse-viewer.spec.ts-snapshots/*`
- Update: `e2e/source-workbench.spec.ts-snapshots/*`
- Update if visually changed: `e2e/enrollment.spec.ts-snapshots/*`

**Interfaces:**
- Consumes: final TV/admin APIs and browser-owned history.
- Produces: deterministic browser acceptance for enrollment, live folder selection, direct URL usage, local resume, and revocation states.

- [ ] **Step 1: Rewrite fixture contracts before changing journeys**

TV fixture objects must use:

```ts
const folder = { id: "item_folder", handle: "sealed-folder", ...metadata };
const image = { id: "item_image", handle: "sealed-image", ...metadata };
const video = { id: "item_video", handle: "sealed-video", ...metadata };
```

Remove test API history methods. Seed `localStorage` through `page.addInitScript()` only for explicit resume scenarios. Admin fixture provides one `snapshot()` method, root creation with immediate availability, and no index-state controls.

- [ ] **Step 2: Run E2E and observe expected contract failures**

Run: `npx playwright test`

Expected: FAIL because fixtures still expose indexed DTOs/history and source-workbench tests expect quota/indexing states.

- [ ] **Step 3: Update the browse/viewer journey**

Assert:

- root opens immediately;
- one folder page displays image/video items;
- viewer switches image to video;
- returned media URL points to the synthetic provider asset, not an API proxy;
- closing and reopening restores a nonzero position from `localStorage`;
- the stored JSON contains `item_video` and no handle/URL/token/provider ID.

- [ ] **Step 4: Replace source-workbench quota journey**

Test live provider folder browsing, add Trips, verify “Available immediately”, close/reopen, verify the selected root remains, inspect device impact, remove it, and verify “No folders in the household program.” Remove index-state mutation helpers and quota screenshots.

- [ ] **Step 5: Preserve enrollment and shared API journeys**

Enrollment still covers request, pending state, admin approval, and ready TV. Add revocation validation: after admin revokes the device, the next TV API refresh clears the sealed cookie and returns the revoked state. Shared API tests assert `/api/tv/watch-history` and sync routes are absent.

- [ ] **Step 6: Regenerate only changed screenshots and inspect them**

Run: `npx playwright test --update-snapshots`

Inspect every changed PNG with the image viewer. Reject unexpected layout/focus regressions; do not approve snapshots merely because tests generated them.

- [ ] **Step 7: Run full E2E without update mode**

Run: `npx playwright test`

Expected: all TV/admin projects PASS.

- [ ] **Step 8: Commit E2E acceptance updates**

```powershell
git add e2e
git commit -m "Test live browsing and local TV history"
```

### Task 20: Rewrite product and operations documentation around the corrected control plane

**Files:**
- Modify: `PRODUCT.md`
- Modify: `README.md`
- Modify: `DESIGN.md`
- Modify: `docs/operations/firebase-vercel-setup.md`
- Modify: `docs/operations/webos-acceptance.md`
- Modify: `.env.example`
- Modify: `tests/design-materials.test.ts`
- Modify: `tests/ops-scripts.test.ts`

**Interfaces:**
- Produces: one accurate operational story matching deployed code and the approved specification.

- [ ] **Step 1: Write failing documentation assertions**

Add checks that active docs contain:

```text
private Vercel Blob
zero steady-state Firestore reads
live Google Drive and OneDrive metadata
local TV watch history
direct provider media
explicit recovery
```

and do not contain active claims for:

```text
Firestore-backed metadata index
Sync now
reconciliation schedule
indexed nodes
Firestore quota recovery
15-minute sync
```

Historical design/plan documents under `docs/superpowers/` may retain their original context and are excluded from this scan.

- [ ] **Step 2: Run documentation tests and confirm stale claims**

Run: `npx vitest run --config vitest.core.config.ts tests/design-materials.test.ts tests/ops-scripts.test.ts`

Expected: FAIL.

- [ ] **Step 3: Rewrite product/runtime descriptions**

`PRODUCT.md` and `README.md` must say:

- Firestore is a compact recovery mirror only;
- Vercel Blob is active state;
- provider folders are listed live through Vercel;
- Google/OneDrive bytes go directly to TV;
- Google access-token URL exposure is an accepted bounded trade-off;
- resume history is local and clears with browser data;
- no index, workflows, sync, server history, or Firestore request counters exist.

- [ ] **Step 4: Rewrite Firebase/Vercel setup and recovery runbook**

Document:

- private Blob creation and environment binding;
- generation and rotation of control/session/browse/provider encryption keys;
- WIF/OIDC permissions limited to exact Firestore recovery document writes during runtime;
- migration dry-run/apply commands;
- explicit restore dry-run/apply commands;
- mirror delayed observability;
- `ENABLE_LEGACY_SESSION_EXCHANGE` cutover/removal;
- no project deletion;
- exact production verification of zero Firestore reads.

Remove cron, Workflow, index deployment, sync, and Firestore quota recovery instructions.

- [ ] **Step 5: Update webOS acceptance**

Add real-TV checks for direct Google/OneDrive playback, range seeking, expired URL renewal, local resume across reload, no history after browser-data clearing, folder listing latency, Back/focus restoration, revoked-device refresh, and Chromium 68 storage-denied fallback.

- [ ] **Step 6: Run documentation tests and link checks**

Run: `npx vitest run --config vitest.core.config.ts tests/design-materials.test.ts tests/ops-scripts.test.ts`

Run: `git grep -n -E "Sync now|Indexed nodes|Cloudframe indexing|quota exhausted|15-minute reconciliation|WORKFLOW_QUEUE_NAMESPACE" -- README.md PRODUCT.md DESIGN.md docs/operations .env.example`

Expected: tests PASS and grep returns no stale active-runtime claims.

- [ ] **Step 7: Commit corrected documentation**

```powershell
git add PRODUCT.md README.md DESIGN.md docs/operations .env.example tests/design-materials.test.ts tests/ops-scripts.test.ts
git commit -m "Document the Vercel control plane"
```

### Task 21: Perform complete verification, migration rehearsal, deployment, and cutover

**Files:**
- Modify only if verification exposes defects: files from prior tasks.
- Produce no committed secret files or raw migration outputs.

**Interfaces:**
- Consumes: completed implementation and operations scripts.
- Produces: verified branch, migration evidence, production deployment, and bounded rollback path.

- [ ] **Step 1: Run the complete deterministic verification suite**

Run in order:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
node scripts/check-tv-bundle.mjs
node scripts/check-tv-legacy.mjs
npm run check:chromium68
npm run build:vercel
npx playwright test
git diff --check
```

Expected: every command exits 0. Verify `.vercel/output/functions` contains only `api.func` plus expected static/config files and contains no Workflow path.

- [ ] **Step 2: Run explicit architectural guard scans**

```powershell
git grep -n -E "listNodesForSource|commitIndexBatch|putWatchHistory|getWatchHistory|listWatchHistory|COLLECTIONS.*watchHistory|COLLECTIONS.*rateLimits|sync-due-sources|crawlCheckpoint|@cloudframe/indexer|workflow/api" -- deploy apps packages scripts tests ':!scripts/migrate-vercel-control-plane.ts' ':!packages/server/src/control-plane/legacy-session-exchange.ts'
git grep -n -E "access_token=|Authorization.*Bearer" -- deploy apps packages/server ':!packages/providers/src/google-drive.ts' ':!packages/providers/src/http.ts'
```

Expected: first scan returns no active-runtime legacy paths; second shows only reviewed provider boundary code.

- [ ] **Step 3: Run the Firestore budget suite independently**

Run: `npx vitest run --config vitest.core.config.ts tests/firestore-budget.test.ts tests/control-plane-store.test.ts tests/firestore-mirror.test.ts`

Expected: 10,000 browse/media requests produce 0 Firestore reads and writes; one control mutation produces 0 reads and 1 deferred mirror write.

- [ ] **Step 4: Rehearse migration and restore against staging**

With staging-only environment values:

```powershell
node --experimental-strip-types scripts/migrate-vercel-control-plane.ts
node --experimental-strip-types scripts/migrate-vercel-control-plane.ts --apply
node --experimental-strip-types scripts/restore-vercel-control-plane.ts
```

Expected: dry run and apply report only counts/revision/checksum; Blob and Firestore recovery revisions match. Restore dry run reads exactly one recovery document. Do not point staging at production Blob paths, keys, household ID, or recovery document.

- [ ] **Step 5: Request a focused code review before merge**

Review specifically for:

- any public-request Firestore read path;
- CAS/cache stale-authorization windows;
- access/refresh token leakage;
- raw provider-ID acceptance;
- Google/OneDrive byte proxying;
- localStorage history leaking handles/URLs;
- legacy-session exchange escaping its feature flag;
- destructive migration behavior;
- Chromium 68 regressions.

Apply only technically justified findings, rerun the affected focused tests, then repeat Step 1.

- [ ] **Step 6: Push and create a ready pull request**

```powershell
git push -u origin codex/firestore-control-plane
$prBody = Join-Path $env:TEMP "cloudframe-control-plane-pr.md"
@'
## Summary
- move active device, source, root, and household control state to encrypted private Vercel Blob
- list Google Drive and OneDrive metadata live through Vercel while media bytes stream directly to the TV
- reduce Firestore to a write-only compact recovery mirror and store playback history locally on the TV

## Security trade-off
- Google playback uses a short-lived access-token media URL so Vercel never proxies video bytes
- refresh tokens remain encrypted and server-only

## Migration and safety
- migration and restore are dry-run first
- legacy Firestore data and all Google Cloud/Firebase projects remain untouched

## Verification
- full Vitest, typecheck, lint, build, Chromium 68, Vercel Build Output API, Playwright, migration rehearsal, and Firestore zero-read budget suite
'@ | Set-Content -Encoding utf8 $prBody
gh pr create --base master --head codex/firestore-control-plane --title "Move Cloudframe browsing off Firestore" --body-file $prBody
```

PR body must summarize architecture, accepted Google-token trade-off, migration/cutover, tests, and the non-deletion guarantee. It must not contain memory citations, secrets, IDs, or raw operational output.

- [ ] **Step 7: Provision production Vercel state before alias cutover**

In the Vercel project, configure the private Blob store and production-only values for `CONTROL_PLANE_ENV`, all versioned encryption keys, `BROWSE_ID_SECRET`, `RATE_LIMIT_SECRET`, `ENABLE_LEGACY_SESSION_EXCHANGE=1`, and `GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL`. Confirm preview and production use distinct values. Grant the permanent writer no Firestore reads and grant the temporary reader no writes. Do not remove existing Firestore/WIF variables until migration and legacy exchange are complete.

- [ ] **Step 8: Apply production migration once**

Run production dry run, review counts/revision/checksum, then run explicit `--apply`. Verify:

- active private Blob exists and decrypts;
- Firestore recovery document matches revision/checksum;
- no `nodes`, history, rate-limit, session, or workflow collections were read by migration;
- no legacy document or cloud project was deleted.

- [ ] **Step 9: Deploy preview and run authenticated browser smoke tests**

Deploy the PR branch to Vercel. Use an authenticated browser session because direct PowerShell probes may hit Vercel Security Checkpoint. Verify admin login/snapshot, live Google/OneDrive folder browsing, root add/remove, TV legacy-cookie exchange, sealed-cookie bootstrap, live folder browse, thumbnails, direct media hostnames, local resume, and revocation.

Vercel logs must show metadata/API requests only and must not contain media bodies, access tokens, refresh tokens, direct URLs, provider IDs, or encrypted payloads.

- [ ] **Step 10: Merge and deploy production**

After CI/review passes, squash merge to `master`, update the local master safely without touching unrelated untracked files, and deploy production from the merged commit. Confirm aliases point to the Ready deployment.

- [ ] **Step 11: Verify real production and Firestore inactivity**

With the authenticated production browser and real TV:

- admin loads one snapshot;
- TV has a version-2 sealed cookie;
- live folder browsing works for Google and OneDrive;
- Google/OneDrive playback and seeking work directly;
- local resume survives reload;
- revocation takes effect on the next request;
- Vercel does not proxy media bytes;
- Cloud Monitoring shows zero Firestore reads during a continuous browse/playback window;
- expected Firestore writes occur only for explicit admin/control changes.

- [ ] **Step 12: Remove the legacy exchange after both active browsers migrate**

Once the one admin browser and one TV hold version-2 cookies, set `ENABLE_LEGACY_SESSION_EXCHANGE=0`, redeploy, and run login/bootstrap smoke tests again. Delete `legacy-session-exchange.ts`, its tests, the flag, `GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL`, and the IAM/WIF binding for the temporary reader. Rerun Step 1 and confirm the deployed runtime identity has no Firestore get/list permission.

- [ ] **Step 13: Exercise explicit recovery in isolated staging**

Delete only the staging Blob snapshot, confirm public staging requests fail closed, apply the restore script from the staging Firestore recovery document, and verify staging recovers. Never perform this destructive drill against production.

- [ ] **Step 14: Record final evidence and leave legacy data untouched**

Record merged commit, PR URL, deployment ID/aliases, test totals, migration revision/checksum, recovery rehearsal result, authenticated browser result, real-TV result, and Firestore monitoring window. State explicitly that old Firestore collections and all Google Cloud/Firebase projects remain undeleted. Any future cleanup requires a separate approved inventory and dry run.
