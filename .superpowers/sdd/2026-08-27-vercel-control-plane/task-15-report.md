# Task 15 report: sealed-handle live TV browsing

## Status

Implemented the final TV data and navigation migration to live provider pages, sealed item/root handles, sealed provider cursors, public pseudonymous item IDs, and TV-owned breadcrumbs/navigation state.

## Implemented

- Updated the TV client to final `TvBootstrapResponse`, `TvRootDto`, `TvFolderPageResponse`, `TvBrowseItemDto`, `DirectThumbnailItem`, and `DirectMediaUrlResponse` contracts.
- Folder requests encode only sealed handles and optional sealed cursors. Thumbnail and media bodies use only `{ handles, maxDimension: 720 }` and `{ handle }`.
- Hardened TV error decoding for both raw final server error JSON and legacy wrapped API-result errors. Codes and retry values are bounded; server/internal messages are replaced by truthful TV-safe recovery copy.
- Replaced indexed-node navigation with a TV-owned in-memory stack. Each entry carries the folder/root handle, parent DTO, local breadcrumb DTOs, public focused item ID/index, scroll position, accumulated children, next cursor, loaded cursors, loading/error state, and root list.
- Back restores accumulated pages, focus, scroll, breadcrumb, pagination, and loading state without a provider refetch or server ancestry reconstruction. Drawer-selected roots also receive a local Home stack entry.
- Pagination appends, deduplicates by public item ID, accepts the newest DTO/renewed handle for duplicates, re-sorts all accumulated entries with `sortBrowseItems()` using the ready device order, and restores the requested destination by public ID after sorting.
- Root cards now show only display name, provider, and account label with the incumbent Screening Room Ledger program-stock artwork. Folder cards use static collection artwork. Readiness, index/preparing branches, descendant counts, folder covers, and mosaics were removed from the TV runtime and CSS.
- Visible previewable media send sealed handles. Returned thumbnail `itemId` values are matched only against requested public IDs; unrelated results are discarded. Media cards apply no-referrer and recover when a renewed thumbnail URL replaces a failed URL.
- Viewer now consumes `TvBrowseItemDto`, uses handles only for media vending, verifies returned public `itemId` and media kind, and retains public IDs for viewer state and local watch history.
- Viewer URL requests are aborted and state is discarded on close, unmount, revocation, or navigation expiry. `NAVIGATION_EXPIRED`/`ITEM_NOT_FOUND` close the viewer and refresh Home; `DEVICE_UNAUTHORIZED` clears session UI and re-bootstraps.
- Preserved Task 14's exact keyed-video element/history lifecycle, unauthorized no-write behavior, local history isolation, viewer arrows/slideshow/seek, source drawer, virtual grid, manual-only focus exclusions, and no-referrer document meta policy.

## TDD evidence

### RED 1: legacy request payloads and Viewer public-ID authorization

Command:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx
```

Observed expected failures:

```text
Test Files 2 failed (2)
Tests 2 failed | 40 passed (42)

thumbnail request received:
{ nodeIds: ["sealed-image"], maxDimension: 720 }
expected:
{ handles: ["sealed-image"], maxDimension: 720 }

Viewer mediaUrl received public IDs including "item_video_1"
expected sealed handle "sealed-item_video_1"
```

This proved the final authorization boundary was not yet implemented.

### RED 2: final media response validation

After the handle call was implemented, strict `itemId`/kind validation exposed legacy TV test doubles that still returned only `{ url, expiresAt, revision }`:

```text
Test Files 2 failed (2)
Tests 21 failed | 21 passed (42)
```

The doubles were migrated to complete final `DirectMediaUrlResponse` fixtures. This retained validation that a returned thumbnail/media public ID is never confused with its handle.

### RED 3: Viewer expiry and thumbnail lifecycle hardening

Command:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/components/viewer.test.tsx apps/tv/src/components/virtual-grid.test.tsx
```

Observed expected failures:

```text
Test Files 2 failed (2)
Tests 2 failed | 25 passed (27)

navigation-expired callback: expected 1 call, received 0
thumbnail: expected referrerpolicy="no-referrer", received null
```

The implementation now propagates stale navigation once, aborts outstanding URL requests, applies no-referrer thumbnails, and permits a fresh provider thumbnail URL to replace a failed URL.

### RED 4: raw final server error envelope

Command:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx -t "preserves bounded raw server error codes"
```

Observed expected failure:

```text
expected code NAVIGATION_EXPIRED, received REQUEST_FAILED
expected retryAfterSeconds 5, received undefined
```

The client now consumes the final raw `{ code, message, retryAfterSeconds }` error response while continuing to accept a wrapped error shape during transition. It never renders the server message.

### RED 5: drawer root Back path

Command:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx -t "returns from a drawer-selected collection"
```

Observed expected failure: Back remained in the selected empty folder because drawer navigation cleared the stack. The root cause was the drawer bypassing the ordinary stack entry creation. Drawer selection now creates an explicit local Home entry and restores the selected public root ID without another Home request.

### GREEN

Required focused suite after all fixes:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/components/source-drawer.test.tsx apps/tv/src/components/virtual-grid.test.tsx tests/tv-focus.test.ts tests/viewer-state.test.ts

Test Files 6 passed (6)
Tests 94 passed (94)
```

## Static and production verification

```text
npm run typecheck
Exit code 0

npx eslint apps/tv/src
Exit code 0

npm run build -w @cloudframe/tv
39 modules transformed
Built successfully

node scripts/check-tv-bundle.mjs
TV bundle compatibility and budget check passed (42458 B JS, 5667 B CSS compressed).

npm run check:chromium68
Pinned Chromium 555668 executed required TV APIs successfully.

git diff --check
Exit code 0
```

Runtime-removal audits:

```text
No forbidden TV runtime references found for ProgramStatus, readiness,
folderCoverNodeIds, descendant counts, mosaics, indexed/preparing copy.

No legacy TV DTO type references found.
No raw node-id request payloads found.
```

The existing `apps/tv/index.html` still contains `<meta name="referrer" content="no-referrer" />` and was not changed.

## Impeccable detector

The required single detector pass was run after the visual/card/CSS migration:

```text
node F:\Projects\tv-video-ui\.agents\skills\impeccable\scripts\detect.mjs --json apps/tv/src/app.tsx apps/tv/src/components/folder-card.tsx apps/tv/src/components/media-card.tsx apps/tv/src/components/source-drawer.tsx apps/tv/src/components/tv-header.tsx apps/tv/src/components/viewer.tsx apps/tv/src/styles/app.css
[]
```

Subsequent fixes were behavior-only stack/request cleanup and did not change the visual system.

## Self-review

- Authorization inputs are handles only. Public IDs are used for keys, focus, history, thumbnail result association, and media response validation.
- No handle, provider cursor, or direct URL is persisted or logged. The only TV persistence remains Task 14's device-scoped public-ID watch history.
- URL values live only in transient thumbnail/viewer component state. Viewer requests are aborted on close/navigation/revocation/expiry and viewer state unmount discards the reducer URL window.
- Local Back uses saved accumulated children and local breadcrumb DTOs. The server is never asked to reconstruct ancestry, and Back does not refetch pages.
- Pagination cannot duplicate a public item. Renewed duplicate DTOs replace old handles, accumulated items are re-sorted by current device order, and focus targets a public ID after reorder.
- Root and folder visuals preserve Screening Room Ledger program stock, cue, focus scale, safe insets, and drawer behavior while removing indexed status/count/mosaic assumptions.
- Manual-only header/source controls remain `tabIndex={-1}` outside explicit drawer focus. Pagination does not reset focus to the first card.
- Exact Task 14 keyed-video element association, final valid history saves, duplicate-write coalescing, and unauthorized no-write tests remain green.
- No cloud mutations, plan/spec/ledger edits, admin changes, or shared legacy DTO deletions were made.

## Concerns

None blocking. Provider-backed pagination remains page-local by contract; the TV re-sorts only the accumulated pages it has loaded, as required.

## Fix Round 1

Addressed all five review findings with focused RED/GREEN regressions and boundary-owned fixes.

### 1. Direct URL expiry

`ViewerUrlState` now retains a validated `expiresAtEpoch`. The new `url-expired` transition removes the direct URL, creates a new request without consuming the error-retry allowance, and carries the exact active-video position for resume. Images and adjacent prefetches renew with zero resume.

Viewer schedules request/expiry-guarded cancellable timeout chains, including delays beyond the platform timeout maximum. Entries leaving the URL window cancel their timers. Close, unmount, device revocation, navigation expiry, and request supersession abort requests and clear timers. Every successfully issued URL receives its own one-error retry allowance.

Thumbnail entries retain the handle that produced them and a validated expiry epoch. Ready entries are removed on expiry and re-vended only while visible. `unavailable` entries remain terminal for that handle and do not spin. Timers are cleared when the entry leaves the visible browse window or the shell unmounts.

### 2. Thumbnail item-not-found recovery

Thumbnail rejection now treats `ITEM_NOT_FOUND` exactly like `NAVIGATION_EXPIRED`: stale browse/viewer/thumbnail state is cleared and Home is refreshed once. `DEVICE_UNAUTHORIZED` still follows the session re-bootstrap path.

### 3. Initial-page dedupe

Home roots and first-page children are defensively deduplicated by public ID before rendering. The last/newest DTO wins, including its renewed handle, kind, and display metadata. Append pages retain the same last/newest-wins rule.

### 4. Cursor and no-progress guards

The TV stops before requesting a cursor already present in `loadedPageCursors`. After append, a repeated current cursor, an A-to-B-to-A cycle, or a page with zero new public IDs terminates pagination. Renewed duplicate DTOs are still adopted, accumulated items remain visible, focus is restored by public ID, Back remains local, and a nonblocking safe status explains that the collection can be refreshed.

### 5. Strict successful response decoding

The TV client now requires a route-specific decoder for every successful request. Bootstrap/enrollment, create-request, Home, folder, thumbnail, and media payloads are validated for exact keys, array ceilings, final enums, public item-ID shape, opaque handle/cursor bounds, visible-name bounds, finite nonnegative integer metadata, canonical nullable timestamps, MIME/kind agreement, nullable bounded revisions, HTTPS direct URLs, and future canonical expiry.

Unknown fields such as provider node IDs, malformed `ok:true` payloads, unavailable thumbnails carrying URL data, expired URLs, and media item-ID/kind mismatches become fixed safe `INVALID_RESPONSE` errors. Transitional wrapped error decoding remains only for error responses. Folder parent public ID is checked against the requested root/folder ID on initial and paginated requests; mismatch clears stale navigation and refreshes Home.

### RED evidence

Strict success decoder:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx -t "malformed successful|malformed bootstrap"
Test Files 1 failed
Tests 9 failed
```

Every malformed `ok:true` response resolved before the route decoders existed, including provider-ID leakage, wrong parent kind, non-array children, invalid cursor, smuggled unavailable-thumbnail URL, expired/bad URLs, and malformed bootstrap/request DTOs.

Initial dedupe, parent identity, and thumbnail item-not-found:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx -t "thumbnail vending reports item not found|deduplicates initial roots|parent does not match"
Test Files 1 failed
Tests 3 failed
```

The stale thumbnail card remained, duplicate roots rendered twice, and a mismatched folder parent was adopted.

Viewer URL lifecycle reducer:

```text
npx vitest run --config vitest.core.config.ts tests/viewer-state.test.ts
Test Files 1 failed
Tests 2 failed | 12 passed
```

`url-expired` was missing, so the reducer returned no renewed state and retained no expiry epoch.

Viewer timed renewal:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/components/viewer.test.tsx -t "direct URL expires|timed URL renewal|expired adjacent URL"
Test Files 1 failed
Tests 3 failed
```

Active image/video URLs did not renew, exact video resume was lost, and obsolete timers were not governed by the URL window.

Thumbnail timed renewal:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx -t "expired thumbnail|reported unavailable"
Test Files 1 failed
Tests 2 failed
```

Ready thumbnails had no expiry owner and unavailable results had no stable handle-bound terminal state.

Cursor/no-progress guard:

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx -t "repeats the current sealed cursor|A to B to A|duplicate-only page"
Test Files 1 failed
Tests 3 failed
```

Pagination did not stop cursor cycles or duplicate-only pages and provided no safe status.

Per-issued-URL retry allowance:

```text
npx vitest run --config vitest.core.config.ts tests/viewer-state.test.ts -t "each successfully issued URL"
Test Files 1 failed
Tests 1 failed
expected refreshUsed false, received true
```

The old revision-scoped retry ledger incorrectly carried an error attempt onto a newly issued URL.

### GREEN verification

```text
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/components/source-drawer.test.tsx apps/tv/src/components/virtual-grid.test.tsx tests/tv-focus.test.ts tests/viewer-state.test.ts
Test Files 6 passed (6)
Tests 126 passed (126)

npm run typecheck
Exit code 0

npx eslint apps/tv/src packages/tv-core/src tests/viewer-state.test.ts
Exit code 0

npm run build -w @cloudframe/tv
39 modules transformed
Built successfully

node scripts/check-tv-bundle.mjs
TV bundle compatibility and budget check passed (45896 B JS, 5711 B CSS compressed).

npm run check:chromium68
Pinned Chromium 555668 executed required TV APIs successfully.

git diff --check
Exit code 0
```

Required single final detector pass after the pagination-status UI edit:

```text
node F:\Projects\tv-video-ui\.agents\skills\impeccable\scripts\detect.mjs --json apps/tv/src/app.tsx apps/tv/src/styles/app.css
[]
```

### Fix-round self-review

- Direct URLs enter state only after strict HTTPS/future-expiry decoding. No URL, handle, expiry, or cursor is persisted or logged.
- Expected expiry is distinct from error retry. Renewal clears the old URL and resets the allowance for the newly issued URL.
- Active-video renewal samples the exact item-associated element position; Task 14 lifecycle tests remain green. Unauthorized and navigation-expired paths still perform no trailing history writes.
- Cancellable bounded timer chains survive Chromium's timeout ceiling and are cancelled after chunk rollover, URL-window removal, close, unmount, revocation, or navigation refresh.
- Thumbnail expiry is handle-bound; renewed DTO handles force a new request, expired ready entries re-vend only while visible, and unavailable entries do not loop.
- Initial and appended dedupe use last/newest DTO wins. Viewer/media vending therefore receives the chosen renewed handle and kind.
- Cursor cycles and duplicate-only pages stop without dropping accumulated items or refetching on Back. The focused public item remains the restoration authority.
- Route decoders reject extra fields, private provider fields, malformed IDs/handles/cursors, wrong enums/shapes, timestamp and metadata violations, non-HTTPS/expired URL data, and contextual media ID/kind mismatch.
- The only visual addition is the noninteractive, nonfocusable Ledger-styled pagination status. Existing remote focus, manual-only controls, source drawer, no-referrer policy, and static root/folder artwork are unchanged.

### Fix-round concern

None blocking. As ruled, a duplicate-only provider page terminates pagination; later provider pages require a collection/Home refresh.
