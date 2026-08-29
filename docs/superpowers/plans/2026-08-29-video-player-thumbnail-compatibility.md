# Video Player and Thumbnail Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Video.js 10-enhanced playback with a native TV fallback and load local-folder, OneDrive, media, and folder thumbnails before scrolling reaches them.

**Architecture:** Provider listing responses carry optional short-lived preview capabilities only inside sealed browse handles. The TV immediately vends every loaded handle in byte-bounded sequential batches, warms each returned URL through the browser image cache, and speculatively loads at most one provider page ahead. Video.js 10 HTML components progressively enhance the existing native media element so current viewer state and Chromium 68 fallback behavior remain intact.

**Tech Stack:** TypeScript, Preact 10, Vite 8 legacy build, Video.js `@videojs/html@10.0.0-beta.32`, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-29-video-player-thumbnail-compatibility-design.md`

## Global Constraints

- Target LG webOS 5+ and Chromium 68; Video.js 10 must never be required for native playback.
- Preserve current device, source, root, browse-handle, Google proxy, OneDrive direct-media, watch-history, slideshow, and remote-navigation boundaries.
- Do not expose provider IDs, tokens, provider response bodies, or raw preview URLs in browse JSON.
- Keep virtualized card rendering; optimize URL vending and browser cache readiness rather than mounting the full folder.
- Request at most one provider page ahead and keep thumbnail URL-vending requests sequential.
- Preserve unrelated untracked `.agents`, `.codex`, and `.impeccable` files.

---

### Task 1: Seal listing-derived preview capabilities

**Files:**
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/google-drive.ts`
- Modify: `packages/providers/src/onedrive.ts`
- Modify: `packages/server/src/auth/browse-handles.ts`
- Modify: `packages/server/src/services/live-browse.ts`
- Test: `tests/provider-contract.test.ts`
- Test: `tests/browse-handles.test.ts`
- Test: `tests/live-browse.test.ts`

**Interfaces:**
- Produces: `ProviderNode.preview: TemporaryUrl | null`.
- Produces: optional `BrowseItemClaims.preview: { url: string; expiresAt: number } | null`, normalized to `null` for old handles.
- Consumes: Google `thumbnailLink`, OneDrive expanded `thumbnails[0].large.url`, and the provider clock.

- [ ] **Step 1: Write provider tests for listing previews**

Add literal assertions that Google and OneDrive folder pages preserve image/video preview URLs, that OneDrive preserves a representative folder preview, and that provider JSON stays server-internal rather than entering a TV DTO.

- [ ] **Step 2: Run provider tests to verify RED**

Run: `npm test -- --run tests/provider-contract.test.ts`

Expected: FAIL because `ProviderNode` does not expose a preview and folders always report no preview.

- [ ] **Step 3: Add provider preview normalization**

Add `preview` to `ProviderNode`. Normalize bounded HTTPS thumbnail URLs into `TemporaryUrl` values: Google uses a resized `thumbnailLink` with the access-token expiry; OneDrive uses the expanded large thumbnail with `temporaryExpiry(now())`. Keep `getThumbnailUrl` as the renewal fallback.

- [ ] **Step 4: Run provider tests to verify GREEN**

Run: `npm test -- --run tests/provider-contract.test.ts`

- [ ] **Step 5: Write browse-handle and live-browse tests for sealed previews**

Assert that a preview URL never appears in the opaque handle or folder JSON, survives `openItem`, old handles without the optional field still open as `preview: null`, malformed/overlong preview objects fail safely, and folders may return `hasPreview: true`.

- [ ] **Step 6: Run browse tests to verify RED**

Run: `npm test -- --run tests/browse-handles.test.ts tests/live-browse.test.ts`

Expected: FAIL because preview claims are neither parsed nor minted and folder previews are discarded.

- [ ] **Step 7: Seal normalized previews into browse handles**

Add a backwards-compatible optional preview parser with a 4,096-character HTTPS URL bound. Copy safe provider previews into child claims, retain no preview URL in `TvBrowseItemDto`, and allow folder `hasPreview` metadata.

- [ ] **Step 8: Run browse tests to verify GREEN**

Run: `npm test -- --run tests/browse-handles.test.ts tests/live-browse.test.ts`

- [ ] **Step 9: Commit Task 1**

Run: `git add packages/providers/src/types.ts packages/providers/src/google-drive.ts packages/providers/src/onedrive.ts packages/server/src/auth/browse-handles.ts packages/server/src/services/live-browse.ts tests/provider-contract.test.ts tests/browse-handles.test.ts tests/live-browse.test.ts && git commit -m "Preserve provider thumbnail previews"`

### Task 2: Vend folder and OneDrive previews safely

**Files:**
- Modify: `packages/server/src/services/direct-media.ts`
- Test: `tests/direct-media.test.ts`

**Interfaces:**
- Consumes: `BrowseItemClaims.preview` from Task 1.
- Produces: existing `DirectThumbnailItem` responses for folders, images, and videos without changing the public JSON shape.

- [ ] **Step 1: Write failing direct-media tests**

Cover a sealed listing preview being returned without a provider thumbnail call, an expired preview falling back to `getThumbnailUrl`, a folder handle receiving a representative thumbnail, realistic `*.storage.live.com` and `*.files.1drv.com` capabilities being accepted, and Graph/authenticated/attacker-shaped URLs remaining unavailable.

- [ ] **Step 2: Run direct-media tests to verify RED**

Run: `npm test -- --run tests/direct-media.test.ts`

Expected: FAIL because folders are excluded, sealed previews are ignored, and storage subdomains are rejected.

- [ ] **Step 3: Implement preview-first vending**

Authorize every handle first. For each source group, acquire compatible credentials once, validate an unexpired sealed preview with the provider URL policy, then call `getThumbnailUrl` only when no usable sealed preview exists. Preserve per-item failure isolation and at-most-once credential refresh.

- [ ] **Step 4: Expand only the OneDrive thumbnail host boundary**

Accept capability-bearing `storage.live.com` and its subdomains while retaining HTTPS, credentials, fragment, path, and query-capability checks. Do not admit `graph.microsoft.com`, login hosts, bare unrelated Microsoft domains, or SharePoint paths outside the exact download handler.

- [ ] **Step 5: Run direct-media tests to verify GREEN**

Run: `npm test -- --run tests/direct-media.test.ts`

- [ ] **Step 6: Commit Task 2**

Run: `git add packages/server/src/services/direct-media.ts tests/direct-media.test.ts && git commit -m "Fix folder and OneDrive thumbnail vending"`

### Task 3: Render folder previews and prewarm all loaded thumbnails

**Files:**
- Create: `apps/tv/src/thumbnails.ts`
- Create: `apps/tv/src/thumbnails.test.ts`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/components/folder-card.tsx`
- Modify: `apps/tv/src/components/media-card.tsx`
- Modify: `apps/tv/src/components/virtual-grid.test.tsx`
- Modify: `apps/tv/src/app.test.tsx`

**Interfaces:**
- Produces: `thumbnailRequestBatches(items, state, maxBytes)` returning sequential handle batches bounded by 100 handles and 30 KiB encoded JSON.
- Produces: `warmThumbnail(url)` with URL deduplication, `no-referrer`, and cleanup on load/error.
- Consumes: unchanged `TvApi.thumbnailUrls` and `ThumbnailState` mapping.

- [ ] **Step 1: Write failing batching and warming unit tests**

Assert that folders and offscreen items with `hasPreview` are included, already-requested handles are excluded, long handles split below the request-byte ceiling, batches never exceed 100 items, duplicate URLs create one `Image`, and `referrerPolicy` is assigned before `src`.

- [ ] **Step 2: Run thumbnail unit tests to verify RED**

Run: `npm test -- --run apps/tv/src/thumbnails.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement bounded thumbnail scheduling and cache warming**

Create pure batching helpers plus a small browser-image warmer. Use sequential API calls so one folder page consumes a bounded number of rate-limit entries without a request burst.

- [ ] **Step 4: Run thumbnail unit tests to verify GREEN**

Run: `npm test -- --run apps/tv/src/thumbnails.test.ts`

- [ ] **Step 5: Write failing TV integration tests**

Assert that thumbnails for items outside the mounted virtual window are requested immediately, returned URLs are warmed, folder cards render ready previews with stock fallback on failure, and unavailable items do not loop.

- [ ] **Step 6: Run TV tests to verify RED**

Run: `npm test -- --run apps/tv/src/app.test.tsx apps/tv/src/components/virtual-grid.test.tsx`

Expected: FAIL because the app still filters by mounted non-folder items and `FolderCard` has no thumbnail surface.

- [ ] **Step 7: Integrate page-wide vending and folder artwork**

Replace mounted-row thumbnail selection with byte-bounded page-wide batches, install and warm each ready URL, keep existing expiry/retry semantics, and pass folder preview URLs into a resilient `FolderCard` image layer.

- [ ] **Step 8: Run TV tests to verify GREEN**

Run: `npm test -- --run apps/tv/src/thumbnails.test.ts apps/tv/src/app.test.tsx apps/tv/src/components/virtual-grid.test.tsx`

- [ ] **Step 9: Commit Task 3**

Run: `git add apps/tv/src/thumbnails.ts apps/tv/src/thumbnails.test.ts apps/tv/src/app.tsx apps/tv/src/components/folder-card.tsx apps/tv/src/components/media-card.tsx apps/tv/src/components/virtual-grid.test.tsx apps/tv/src/app.test.tsx && git commit -m "Preload TV folder thumbnails"`

### Task 4: Prefetch one provider page before scroll reaches it

**Files:**
- Create: `apps/tv/src/pagination.ts`
- Create: `apps/tv/src/pagination.test.ts`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/components/virtual-grid.tsx`
- Modify: `apps/tv/src/components/virtual-grid.test.tsx`
- Modify: `apps/tv/src/app.test.tsx`

**Interfaces:**
- Produces: a pure near-end calculation using item count, columns, row height, viewport height, scroll offset, and focused index.
- Consumes: existing `appendNextPage`, cursor-cycle protection, page-request lock, and focus restoration.

- [ ] **Step 1: Write failing pagination threshold tests**

Assert that entering the final two visible rows by focus or scroll requests extension, ordinary middle-of-folder movement does not, and a short first page with a cursor qualifies for one idle prefetch.

- [ ] **Step 2: Run pagination tests to verify RED**

Run: `npm test -- --run apps/tv/src/pagination.test.ts apps/tv/src/components/virtual-grid.test.tsx`

Expected: FAIL because pagination occurs only when D-pad movement has no loaded destination.

- [ ] **Step 3: Implement near-end signaling**

Add the pure threshold helper and let `VirtualGrid` report when its focused/scroll window enters the threshold. Preserve the existing explicit `needsPageExtension` path.

- [ ] **Step 4: Add one idle prefetch per loaded page**

After the current page's thumbnail batches are queued, schedule `appendNextPage()` once for its current sealed cursor using `requestIdleCallback` when available and a short timeout fallback. Cancel on navigation/unmount and never recursively schedule beyond one page ahead without subsequent user proximity.

- [ ] **Step 5: Run pagination and app tests to verify GREEN**

Run: `npm test -- --run apps/tv/src/pagination.test.ts apps/tv/src/components/virtual-grid.test.tsx apps/tv/src/app.test.tsx`

- [ ] **Step 6: Commit Task 4**

Run: `git add apps/tv/src/pagination.ts apps/tv/src/pagination.test.ts apps/tv/src/app.tsx apps/tv/src/components/virtual-grid.tsx apps/tv/src/components/virtual-grid.test.tsx apps/tv/src/app.test.tsx && git commit -m "Prefetch the next TV folder page"`

### Task 5: Add Video.js 10 progressive enhancement

**Files:**
- Modify: `apps/tv/package.json`
- Modify: `package-lock.json`
- Create: `apps/tv/src/videojs.ts`
- Create: `apps/tv/src/videojs.test.ts`
- Modify: `apps/tv/src/components/video-player.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `apps/tv/src/styles.css`

**Interfaces:**
- Produces: `loadVideoJs()` as a memoized dynamic import of `@videojs/html/video/player`, resolving to `true` only when `video-player` and `media-container` register successfully.
- Consumes: the existing native `HTMLVideoElement` ref and all current viewer callbacks.

- [ ] **Step 1: Install the pinned dependency**

Run: `npm install --save-exact @videojs/html@10.0.0-beta.32 -w @cloudframe/tv`

- [ ] **Step 2: Write failing loader and viewer tests**

Assert that loader failure resolves to the native fallback, repeated calls share one import attempt, the rendered tree always contains the native `<video>`, and the Video.js player/container state boundary appears without changing media callbacks or source/MIME handling.

- [ ] **Step 3: Run Video.js tests to verify RED**

Run: `npm test -- --run apps/tv/src/videojs.test.ts apps/tv/src/components/viewer.test.tsx`

Expected: FAIL because the loader and state boundary do not exist.

- [ ] **Step 4: Implement the progressive wrapper**

Render `video-player > media-container > video` from first paint, dynamically register the v10 HTML preset after mount, and retain the Cloudframe control overlay. Do not use the v10 skin, popovers, or unsupported TV-only features. Style unknown and upgraded custom elements as block/fill containers.

- [ ] **Step 5: Run Video.js tests to verify GREEN**

Run: `npm test -- --run apps/tv/src/videojs.test.ts apps/tv/src/components/viewer.test.tsx`

- [ ] **Step 6: Commit Task 5**

Run: `git add apps/tv/package.json package-lock.json apps/tv/src/videojs.ts apps/tv/src/videojs.test.ts apps/tv/src/components/video-player.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/styles.css && git commit -m "Enhance TV playback with Video.js 10"`

### Task 6: Verify legacy runtime and complete browser acceptance

**Files:**
- Modify: `e2e/browse-viewer.spec.ts`
- Modify: `e2e/fixtures.ts`
- Modify: `scripts/check-chromium68.mjs`
- Modify: `docs/operations/webos-acceptance.md` if the existing checklist lacks thumbnail/player coverage.

**Interfaces:**
- Consumes: the completed TV build and synthetic browse APIs.
- Produces: automated evidence that first-page/offscreen/folder thumbnails are requested and loaded before scroll, Video.js registration cannot break Chromium 68 rendering, and native playback remains available.

- [ ] **Step 1: Extend end-to-end fixtures and assertions**

Add a representative folder preview and enough items to exceed the mounted window. Assert thumbnail requests include offscreen media and folder handles before scrolling, then scroll/focus and verify preview images are already present.

- [ ] **Step 2: Extend the Chromium 68 probe**

Inspect runtime errors after the Video.js dynamic import attempt and assert a native video element remains available in the synthetic viewer even if the v10 custom elements cannot upgrade.

- [ ] **Step 3: Run focused end-to-end verification**

Run: `npx playwright test e2e/browse-viewer.spec.ts --project=tv-1920`

- [ ] **Step 4: Run full verification**

Run: `npm test`

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run build`

Run: `npm run build:vercel`

Run: `npm run check:chromium68`

Expected: all commands exit 0 with no new warnings attributable to this change.

- [ ] **Step 5: Inspect the TV surface once**

Run the Playwright TV journey at 1920×1080, inspect the captured screenshot and trace for folder/media preview readiness, stable focus, missing images, and playback overlay regressions. Apply one batched correction pass if needed, then rerun the focused journey once.

- [ ] **Step 6: Commit Task 6**

Run: `git add e2e/browse-viewer.spec.ts e2e/fixtures.ts scripts/check-chromium68.mjs docs/operations/webos-acceptance.md && git commit -m "Verify TV thumbnail and player compatibility"`

