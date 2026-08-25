# TV Cloud Browser Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current application with a Vercel-hosted, Firestore-backed, cookie-only TV cloud browser and mobile admin panel that directly streams Google Drive and OneDrive media.

**Architecture:** An npm workspace builds a legacy-targeted Preact/Vite TV SPA and a modern React/Vite admin SPA into one Vercel static output. Vercel functions own authentication, OAuth, Firestore access, indexing workflows, and temporary provider URL vending; browsers never access Firestore directly, and media/thumbnail bytes flow directly from Google or Microsoft.

**Tech Stack:** TypeScript, Preact, React, Vite, Vitest, Testing Library, Vercel Functions, Vercel Workflows, Cloud Firestore, Vercel OIDC, Google Drive API v3, Microsoft Graph, Playwright

**Spec:** `docs/superpowers/specs/2026-08-26-tv-cloud-browser-redesign-design.md`

## Global Constraints

- The product is single-household and single-admin.
- The TV is read-only and folder-only; there is no timeline.
- Cloud providers at launch are Google Drive and OneDrive behind one shared adapter contract.
- Application-owned browser persistence is cookies only: no localStorage, sessionStorage, IndexedDB, Cache Storage, or service-worker state.
- TV support is guaranteed for LG webOS 5.x / Chromium 68 and newer.
- Folder contents use a uniform virtualized grid with subfolders first.
- Folder covers are deterministic browser-composed three-image mosaics using up to three provider thumbnails, with explicit two/one/empty fallbacks.
- The admin panel is mobile-first and remains fully usable on tablet and desktop.
- Firestore is private behind Vercel and located in `asia-south1`; trusted Vercel functions run in `bom1`.
- Firebase Authentication, Storage, Hosting, and Functions are not used.
- Vercel and Firebase never proxy original image or video bytes.
- Memories is visual inspiration only; no AGPL source is copied.
- New production behavior follows test-driven development.
- Existing unrelated work and `.superpowers/` visual-companion files must not be committed.

---

### Task 1: Workspace, builds, and test harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts`
- Create: `vercel.json`
- Create: `scripts/build-site.mjs`
- Create: `apps/tv/package.json`
- Create: `apps/tv/index.html`
- Create: `apps/tv/tsconfig.json`
- Create: `apps/tv/vite.config.ts`
- Create: `apps/tv/src/main.tsx`
- Create: `apps/admin/package.json`
- Create: `apps/admin/index.html`
- Create: `apps/admin/tsconfig.json`
- Create: `apps/admin/vite.config.ts`
- Create: `apps/admin/src/main.tsx`
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/server/package.json`
- Create: `packages/tv-core/package.json`
- Delete: legacy `src/**` and legacy `tests/**` after replacement coverage exists

**Interfaces:**
- Produces: workspace scripts `npm run build`, `npm test`, `npm run lint`, and `npm run typecheck`.
- Produces: Vercel output `dist/index.html` for TV and `dist/admin/index.html` for admin.
- Produces: importable packages `@cloudframe/shared`, `@cloudframe/server`, and `@cloudframe/tv-core`.

- [ ] **Step 1: Write the failing workspace smoke test**

Create `tests/workspace.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it("declares separate TV and admin applications", async () => {
    const root = JSON.parse(await readFile("package.json", "utf8"));
    expect(root.workspaces).toEqual(["apps/*", "packages/*"]);
    expect(root.scripts.build).toContain("build-site.mjs");
  });
});
```

- [ ] **Step 2: Run the smoke test and verify RED**

Run: `npx vitest run tests/workspace.test.ts`

Expected: FAIL because the current package is not an npm workspace.

- [ ] **Step 3: Create the workspace and install pinned dependencies**

The root scripts must be:

```json
{
  "build": "npm run build -w @cloudframe/tv && npm run build -w @cloudframe/admin && node scripts/build-site.mjs",
  "test": "vitest run",
  "test:watch": "vitest",
  "typecheck": "tsc -p tsconfig.base.json --noEmit",
  "lint": "eslint .",
  "dev:tv": "npm run dev -w @cloudframe/tv",
  "dev:admin": "npm run dev -w @cloudframe/admin"
}
```

Use Vite's legacy plugin to emit a Chromium 68-compatible TV bundle and configure the admin as a normal modern build. `scripts/build-site.mjs` must copy the TV build to `dist/`, the admin build to `dist/admin/`, and preserve hashed assets.

- [ ] **Step 4: Configure Vercel routing**

`vercel.json` must route `/api/**` to functions, `/admin/**` to the admin SPA, and all other non-file routes to the TV SPA. Functions use `bom1`; the scheduled sync path is configured for every 15 minutes and documented as requiring Vercel Pro.

- [ ] **Step 5: Run workspace test and builds**

Run:

```powershell
npm test -- tests/workspace.test.ts
npm run typecheck
npm run build
```

Expected: PASS and both `dist/index.html` and `dist/admin/index.html` exist.

- [ ] **Step 6: Commit**

```powershell
git add package.json package-lock.json .gitignore tsconfig.base.json vitest.config.ts vercel.json scripts apps packages tests/workspace.test.ts
git commit -m "build: create TV and admin workspace"
```

### Task 2: Shared contracts, secure cookies, crypto, and Firestore repository

**Files:**
- Create: `packages/shared/src/contracts.ts`
- Create: `packages/shared/src/api.ts`
- Create: `packages/shared/src/sorting.ts`
- Create: `packages/server/src/auth/tokens.ts`
- Create: `packages/server/src/auth/cookies.ts`
- Create: `packages/server/src/auth/passphrase.ts`
- Create: `packages/server/src/crypto/provider-tokens.ts`
- Create: `packages/server/src/firestore/client.ts`
- Create: `packages/server/src/firestore/repository.ts`
- Create: `packages/server/src/firestore/memory-repository.ts`
- Create: `packages/server/src/index.ts`
- Test: `tests/auth.test.ts`
- Test: `tests/repository.test.ts`
- Test: `tests/sorting.test.ts`

**Interfaces:**
- Produces: `AppRepository` for household, sessions, requests, devices, sources, roots, nodes, history, and sync leases.
- Produces: `issueOpaqueToken(): { raw: string; hash: string }`.
- Produces: `createSessionCookie(kind, rawToken, expiresAt): string` and `clearSessionCookie(kind): string`.
- Produces: `hashPassphrase(passphrase, pepper)` and `verifyPassphrase(...)` using Argon2id.
- Produces: `encryptProviderToken` and `decryptProviderToken` using AES-256-GCM plus key version.
- Produces: stable sorting and folder-cover selection contracts shared by server and UI.

- [ ] **Step 1: Write failing auth tests**

```ts
it("stores only a SHA-256 hash for an opaque session token", () => {
  const token = issueOpaqueToken();
  expect(token.raw).not.toBe(token.hash);
  expect(token.hash).toMatch(/^[a-f0-9]{64}$/);
});

it("creates a rolling secure HTTP-only device cookie", () => {
  const cookie = createSessionCookie("device", "secret", new Date("2027-08-26T00:00:00Z"));
  expect(cookie).toContain("device_session=secret");
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Strict");
});
```

- [ ] **Step 2: Verify auth tests fail for missing modules**

Run: `npx vitest run tests/auth.test.ts`

Expected: FAIL with unresolved imports.

- [ ] **Step 3: Implement token, cookie, passphrase, and encryption helpers**

Use `crypto.randomBytes(32)`, SHA-256, `@node-rs/argon2`, and AES-256-GCM. Cookie names are `admin_session`, `device_session`, and `device_request`; all use `Path=/`, admin is SameSite Lax, device/request are SameSite Strict.

- [ ] **Step 4: Write failing repository atomicity tests**

```ts
it("approves a request atomically with device, assignments, and session", async () => {
  const repo = new MemoryRepository();
  await repo.createDeviceRequest(pendingRequest);
  await repo.approveDeviceRequest({ requestId: "r1", device, session, rootIds: ["root-1"] });
  expect((await repo.getDeviceRequest("r1"))?.status).toBe("approved");
  expect((await repo.getDevice("d1"))?.assignedRootIds).toEqual(["root-1"]);
  expect(await repo.getDeviceSessionByHash(session.tokenHash)).toMatchObject({ deviceId: "d1" });
});
```

- [ ] **Step 5: Implement memory and Firestore repositories**

The memory repository is the behavioral reference for tests. The Firestore implementation uses transactions/batched writes for approval, revocation, leases, and passphrase rotation. Production credentials use Vercel OIDC and GCP Workload Identity Federation; local/staging also support the Firestore emulator and explicit non-production credentials.

- [ ] **Step 6: Write RED/GREEN sorting and cover-selection tests**

Cover selection must prefer newest suitable descendants, exclude duplicates, and use provider ID as the final tie-breaker. Folder listing must place alphabetized folders before media sorted by the configured mode.

- [ ] **Step 7: Run focused and full tests**

Run:

```powershell
npx vitest run tests/auth.test.ts tests/repository.test.ts tests/sorting.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages tests package.json package-lock.json
git commit -m "feat: add secure Firestore domain layer"
```

### Task 3: HTTP API router and permanent device enrollment

**Files:**
- Create: `api/[...route].ts`
- Create: `packages/server/src/http/app.ts`
- Create: `packages/server/src/http/request.ts`
- Create: `packages/server/src/http/response.ts`
- Create: `packages/server/src/http/errors.ts`
- Create: `packages/server/src/services/bootstrap.ts`
- Create: `packages/server/src/services/admin-auth.ts`
- Create: `packages/server/src/services/device-enrollment.ts`
- Create: `packages/server/src/services/device-auth.ts`
- Test: `tests/http-auth.test.ts`
- Test: `tests/device-enrollment.test.ts`

**Interfaces:**
- Produces: `createApiApp(dependencies): (request: Request) => Promise<Response>`.
- Produces endpoints: bootstrap, admin login/logout, device request/status, admin request list/approve/deny, device list/update/revoke, heartbeat.
- Consumes: `AppRepository`, auth helpers, and environment configuration.

- [ ] **Step 1: Write failing device-request policy tests**

```ts
it("rejects a device request while new requests are disabled", async () => {
  const app = createTestApi({ allowNewDeviceRequests: false });
  const response = await app(jsonRequest("/api/device-requests", "POST", { name: "Living Room" }));
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toMatchObject({ code: "DEVICE_REQUESTS_DISABLED" });
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/device-enrollment.test.ts`

Expected: FAIL because the API does not exist.

- [ ] **Step 3: Implement API routing and consistent errors**

Use one catch-all Vercel function and a small method/path router. Every error is `{ code, message, retryAfterSeconds? }`; never return secrets or provider payloads.

- [ ] **Step 4: Implement admin login and cookie renewal**

Seed the first household passphrase from `ADMIN_INITIAL_PASSPHRASE` only when no household exists. Renew 365-day cookies only when fewer than 30 days remain. Apply origin/CSRF validation to admin mutations.

- [ ] **Step 5: Implement request, approval, and revocation flow**

Approval requires a non-empty name and at least one root, creates the device/session atomically, and sets the permanent device cookie from the status endpoint. Revocation invalidates the next TV request.

- [ ] **Step 6: Add rate-limit tests and implementation**

Use Firestore-backed fixed-window counters for login, request creation, polling, and URL vending. Tests use an injected clock.

- [ ] **Step 7: Run API tests**

Run:

```powershell
npx vitest run tests/http-auth.test.ts tests/device-enrollment.test.ts
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add api packages tests
git commit -m "feat: add permanent device enrollment API"
```

### Task 4: Google Drive and OneDrive OAuth/provider adapters

**Files:**
- Create: `packages/providers/package.json`
- Create: `packages/providers/src/types.ts`
- Create: `packages/providers/src/google-drive.ts`
- Create: `packages/providers/src/onedrive.ts`
- Create: `packages/providers/src/registry.ts`
- Create: `packages/providers/src/index.ts`
- Create: `packages/server/src/services/sources.ts`
- Create: `packages/server/src/services/oauth.ts`
- Test: `tests/provider-contract.test.ts`
- Test: `tests/oauth.test.ts`
- Create: `tests/fixtures/google/*.json`
- Create: `tests/fixtures/onedrive/*.json`

**Interfaces:**
- Produces exact `ProviderAdapter` from the design spec.
- Produces OAuth start/callback APIs and source health management.
- Produces temporary provider thumbnail and media URLs; never proxies bytes.

- [ ] **Step 1: Write failing provider contract tests**

Run the same fixture-driven suite against both adapters. Assert normalization of folders, images, videos, timestamps, pagination, deletes/moves, and throttling metadata.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/provider-contract.test.ts`

Expected: FAIL because adapters do not exist.

- [ ] **Step 3: Implement Google Drive adapter**

Use Drive v3 list/change endpoints, readonly OAuth, page tokens, `thumbnailLink`, and `files/{id}?alt=media&access_token=...`. Preserve access-token expiry and refresh safely.

- [ ] **Step 4: Implement OneDrive adapter**

Use Microsoft Graph children/delta endpoints, readonly scopes, thumbnail URLs, and `@microsoft.graph.downloadUrl`.

- [ ] **Step 5: Implement OAuth state and source APIs**

OAuth state is single-use, 10-minute, tied to the admin session, and stored hashed. Callback encrypts tokens, creates/updates the source, starts initial sync, and redirects to `/admin/sources` with a safe status code.

- [ ] **Step 6: Run provider and OAuth tests**

Run:

```powershell
npx vitest run tests/provider-contract.test.ts tests/oauth.test.ts
npm run typecheck
```

Expected: PASS without live credentials.

- [ ] **Step 7: Commit**

```powershell
git add packages tests
git commit -m "feat: add cloud provider adapters"
```

### Task 5: Resumable indexing, roots, browse APIs, and direct URL vending

**Files:**
- Create: `packages/indexer/package.json`
- Create: `packages/indexer/src/batch.ts`
- Create: `packages/indexer/src/covers.ts`
- Create: `packages/indexer/src/reconcile.ts`
- Create: `packages/indexer/src/workflow.ts`
- Create: `packages/indexer/src/index.ts`
- Create: `packages/server/src/services/indexing.ts`
- Create: `packages/server/src/services/browse.ts`
- Create: `packages/server/src/services/media-urls.ts`
- Modify: `packages/server/src/http/app.ts`
- Test: `tests/indexer.test.ts`
- Test: `tests/browse-authorization.test.ts`
- Test: `tests/media-url.test.ts`

**Interfaces:**
- Produces: `syncSourceWorkflow(sourceId, mode)` with durable bounded steps.
- Produces: virtual-root and paginated folder APIs authorized by ancestry.
- Produces: batch thumbnail URL and single media URL endpoints.

- [ ] **Step 1: Write failing idempotency and checkpoint tests**

```ts
it("replaying the same provider page does not duplicate nodes", async () => {
  const first = await runIndexBatch(context, page);
  const second = await runIndexBatch(context, page);
  expect(second.totalNodeCount).toBe(first.totalNodeCount);
  expect(second.checkpoint.providerPageCursor).toBe(first.checkpoint.providerPageCursor);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/indexer.test.ts`

Expected: FAIL because the indexer does not exist.

- [ ] **Step 3: Implement bounded batch and cover recomputation**

Each step processes a fixed provider page, writes a sync generation, updates only affected ancestry branches, and persists the cursor. Deleted/unseen nodes become unavailable rather than disappearing immediately.

- [ ] **Step 4: Add Vercel Workflow wrapper and cron lease starter**

Workflow steps call the deterministic batch implementation and rely on Firestore as the authoritative checkpoint/lease ledger. Cron leases due sources transactionally and starts delta workflows. Manual sync starts the same workflow.

- [ ] **Step 5: Write and implement ancestry authorization tests**

Assert a device can browse and vend URLs only for descendants of its assigned roots, including after reassignment or revocation.

- [ ] **Step 6: Implement browse, thumbnails, media URL, and history APIs**

Folder results paginate with stable cursors. Thumbnail endpoint accepts only visible authorized node IDs. URL responses use `Cache-Control: private, no-store` and never log URLs. Watch history is device-scoped.

- [ ] **Step 7: Run index/API tests**

Run:

```powershell
npx vitest run tests/indexer.test.ts tests/browse-authorization.test.ts tests/media-url.test.ts
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages api tests vercel.json
git commit -m "feat: add indexed cloud browsing"
```

### Task 6: LG webOS-compatible TV shell and virtualized Drive grid

**Files:**
- Create: `packages/tv-core/src/keys.ts`
- Create: `packages/tv-core/src/focus.ts`
- Create: `packages/tv-core/src/navigation.ts`
- Create: `packages/tv-core/src/index.ts`
- Create: `apps/tv/src/app.tsx`
- Create: `apps/tv/src/api/client.ts`
- Create: `apps/tv/src/state/use-tv-session.ts`
- Create: `apps/tv/src/components/device-request.tsx`
- Create: `apps/tv/src/components/waiting-screen.tsx`
- Create: `apps/tv/src/components/tv-header.tsx`
- Create: `apps/tv/src/components/source-drawer.tsx`
- Create: `apps/tv/src/components/virtual-grid.tsx`
- Create: `apps/tv/src/components/folder-card.tsx`
- Create: `apps/tv/src/components/media-card.tsx`
- Create: `apps/tv/src/styles/tokens.css`
- Create: `apps/tv/src/styles/app.css`
- Test: `tests/tv-focus.test.ts`
- Test: `apps/tv/src/components/virtual-grid.test.tsx`
- Test: `apps/tv/src/app.test.tsx`

**Interfaces:**
- Produces: `moveFocus(state, direction): FocusState` and normalized TV key actions.
- Produces: virtual-root/folder navigation stack with exact focus and scroll restoration.
- Consumes: bootstrap, enrollment, root, folder, and thumbnail APIs.

- [ ] **Step 1: Write failing remote/focus tests**

Cover grid edges, column changes, Back behavior, Menu fallback, page extension, and restoration after child navigation.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/tv-focus.test.ts`

Expected: FAIL because TV core is missing.

- [ ] **Step 3: Implement pure focus/navigation core**

Normalize browser and TV key codes without proprietary APIs. Focus movement is explicit and deterministic.

- [ ] **Step 4: Write failing TV state tests**

Test name request, disabled requests, pending approval, approved activation, no roots, folder loading, errors, and revocation.

- [ ] **Step 5: Implement Memories-inspired TV visual system**

Use a near-black canvas, compact blue top chrome, generous overscan, strong white/blue focus, clean breadcrumbs, and image-led cards. Build original CSS and components; copy no Memories code or assets.

- [ ] **Step 6: Implement uniform virtual grid and mosaics**

Render only visible rows plus two-row overscan. Compose three/two/one-image folder covers in CSS. Load thumbnail URLs in batches for visible nodes. Skeletons preserve final geometry.

- [ ] **Step 7: Verify TV tests and legacy build**

Run:

```powershell
npx vitest run tests/tv-focus.test.ts apps/tv/src/**/*.test.tsx
npm run build -w @cloudframe/tv
npm run typecheck
```

Inspect the generated legacy bundle and ensure no syntax exceeds the Chromium 68 target.

- [ ] **Step 8: Commit**

```powershell
git add apps/tv packages/tv-core tests
git commit -m "feat: build TV folder browser"
```

### Task 7: Unified image viewer, slideshow, and direct video player

**Files:**
- Create: `packages/tv-core/src/viewer.ts`
- Create: `apps/tv/src/components/viewer.tsx`
- Create: `apps/tv/src/components/image-viewer.tsx`
- Create: `apps/tv/src/components/video-player.tsx`
- Create: `apps/tv/src/components/viewer-overlay.tsx`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/styles/app.css`
- Test: `tests/viewer-state.test.ts`
- Test: `apps/tv/src/components/viewer.test.tsx`

**Interfaces:**
- Produces: viewer reducer for index, overlay, slideshow, playback, and URL-refresh state.
- Consumes: media URL, thumbnail URL, and watch-history APIs.

- [ ] **Step 1: Write failing viewer reducer tests**

Test Left/Right bounds, slideshow image advance, video pause semantics, overlay Up/Down, and restoration target.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/viewer-state.test.ts`

Expected: FAIL because viewer reducer is missing.

- [ ] **Step 3: Implement viewer reducer and image flow**

Active images request direct media URLs; nearby previews are limited to one on each side. Slideshow stops on error and pauses on video.

- [ ] **Step 4: Write failing direct-video tests**

Test media URL request, retry-once after authorization error, resume timestamp, periodic history saves, seek step, and unsupported codec message.

- [ ] **Step 5: Implement native video player controls**

Use one HTML media element, custom ten-foot controls, range-capable direct provider URL, auto-hide timer, buffering state, and exact history saving. Do not add a proxy or transcoder.

- [ ] **Step 6: Run viewer tests and TV build**

Run:

```powershell
npx vitest run tests/viewer-state.test.ts apps/tv/src/components/viewer.test.tsx
npm run build -w @cloudframe/tv
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/tv packages/tv-core tests
git commit -m "feat: add unified TV media viewer"
```

### Task 8: Mobile-first admin panel

**Files:**
- Create: `apps/admin/src/app.tsx`
- Create: `apps/admin/src/api/client.ts`
- Create: `apps/admin/src/components/shell.tsx`
- Create: `apps/admin/src/components/login.tsx`
- Create: `apps/admin/src/components/requests.tsx`
- Create: `apps/admin/src/components/approval-sheet.tsx`
- Create: `apps/admin/src/components/devices.tsx`
- Create: `apps/admin/src/components/sources.tsx`
- Create: `apps/admin/src/components/folder-picker.tsx`
- Create: `apps/admin/src/components/settings.tsx`
- Create: `apps/admin/src/styles/tokens.css`
- Create: `apps/admin/src/styles/app.css`
- Test: `apps/admin/src/app.test.tsx`
- Test: `apps/admin/src/components/approval-sheet.test.tsx`

**Interfaces:**
- Consumes all admin APIs.
- Produces four sections: Requests, Devices, Sources, Settings.
- Produces approval flow that requires name plus at least one root.

- [ ] **Step 1: Write failing admin workflow tests**

Test login, empty requests, approval validation, deny, rename, reassign, disable/revoke confirmation, connect/reconnect/remove source, Sync now, request toggle, passphrase change, and sign-out.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run apps/admin/src/**/*.test.tsx`

Expected: FAIL because admin components are missing.

- [ ] **Step 3: Implement original Memories-inspired responsive shell**

Use a pale sidebar/blue accent on wide screens, bottom navigation on phones, white content canvas, compact controls, thumbnail-led folder picker, and clear status cards. Copy no Memories code or assets.

- [ ] **Step 4: Implement request/device/source/settings workflows**

All mutations show pending/error states. Destructive actions display affected devices and require confirmation. Source health exposes sync state and safe errors.

- [ ] **Step 5: Run admin tests and build**

Run:

```powershell
npx vitest run apps/admin/src/**/*.test.tsx
npm run build -w @cloudframe/admin
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add apps/admin
git commit -m "feat: build mobile device admin"
```

### Task 9: Firebase/Vercel configuration, migration, documentation, and browser acceptance

**Files:**
- Create: `.firebaserc`
- Create: `firebase.json`
- Create: `firestore.rules`
- Create: `firestore.indexes.json`
- Create: `.env.example`
- Create: `scripts/seed-dev.mjs`
- Create: `scripts/migrate-vercel-blob.mjs`
- Create: `scripts/check-tv-bundle.mjs`
- Create: `playwright.config.ts`
- Create: `e2e/enrollment.spec.ts`
- Create: `e2e/browse-viewer.spec.ts`
- Rewrite: `README.md`
- Create: `docs/operations/firebase-vercel-setup.md`
- Create: `docs/operations/webos-acceptance.md`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces reproducible emulator/staging/production setup.
- Produces one-time token migration with reauth-required fallback.
- Produces configuration assertions and E2E acceptance flows.

- [ ] **Step 1: Write failing configuration tests**

Assert Firestore rules deny clients, indexes cover browse/sync queries, Vercel routes both SPAs, function region is `bom1`, and environment examples contain every required variable without values.

- [ ] **Step 2: Verify RED and implement configuration**

Run: `npx vitest run tests/config.test.ts`, then add the exact Firebase/Vercel files until green.

- [ ] **Step 3: Implement seed and migration scripts**

`seed-dev` creates the household from an environment passphrase. Migration reads existing Vercel Blob connection records, encrypts valid refresh tokens, and marks invalid/missing-scope sources `reauth-required`; it never migrates localStorage device sessions.

- [ ] **Step 4: Write and implement Playwright journeys**

Use an in-memory or emulator-backed API test mode to cover request → approval → roots → browse → viewer → revoke. Add route fixtures for provider bytes so E2E never requires live accounts.

- [ ] **Step 5: Create/configure external dev resources**

Using the authenticated CLIs/APIs:

1. Create a dedicated billing-enabled Firebase project for development.
2. Create Firestore in `asia-south1` and deploy rules/indexes.
3. Configure Vercel OIDC workload identity and least-privilege Firestore service account where permissions allow.
4. Add dev/preview/production environment variables to the existing Vercel project without exposing values in logs.
5. Configure the dev deployment and OAuth redirect URI inventory.

If an external billing/IAM action is blocked by account permissions, preserve all local configuration and record the exact remaining console action in the operations doc.

- [ ] **Step 6: Run build, config, and E2E checks**

Run:

```powershell
npm run build
node scripts/check-tv-bundle.mjs
npx vitest run tests/config.test.ts
npx playwright test
```

Expected: PASS or, for real-TV-only checks, an explicit documented pending acceptance item rather than a false pass.

- [ ] **Step 7: Commit**

```powershell
git add .firebaserc firebase.json firestore.rules firestore.indexes.json .env.example scripts e2e playwright.config.ts README.md docs/operations tests/config.test.ts
git commit -m "ops: configure Firebase and Vercel deployment"
```

### Task 10: Full verification, review, cleanup, and push

**Files:**
- Modify only files required by verified review findings.

**Interfaces:**
- Consumes: the complete spec and every earlier task.
- Produces: a verified `dev` branch pushed to `origin/dev`.

- [ ] **Step 1: Run the complete verification matrix**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
node scripts/check-tv-bundle.mjs
npx playwright test
git diff --check origin/dev...HEAD
```

Expected: every automated check passes with no warnings that indicate broken behavior.

- [ ] **Step 2: Review spec coverage line by line**

Map every acceptance criterion in the design spec to code and a test or documented real-device acceptance check. Fix any uncovered requirement using RED/GREEN tests.

- [ ] **Step 3: Review security and deployment state**

Confirm no secrets, provider URLs, cookies, `.superpowers/`, build outputs, Firebase credential JSON, or service-account keys are tracked. Confirm production paths never proxy media bytes and browser code contains no prohibited storage APIs.

- [ ] **Step 4: Request code review and address findings**

Use the requesting-code-review workflow against the design commit and current HEAD. Fix all Critical and Important findings, then rerun the complete verification matrix.

- [ ] **Step 5: Commit final fixes**

```powershell
git add <verified-explicit-paths>
git commit -m "fix: complete TV cloud browser verification"
```

Skip the commit if there are no review fixes.

- [ ] **Step 6: Push the user-authorized branch**

```powershell
git pull --rebase origin dev
npm test
npm run build
git push origin dev
```

Expected: push succeeds without force and `dev` is synchronized with `origin/dev`.
