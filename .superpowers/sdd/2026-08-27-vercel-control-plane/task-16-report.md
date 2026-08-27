# Task 16 report: one admin snapshot and live configuration

## Status

Implemented the final admin data and UX migration. The browser now loads one strictly decoded `AdminSnapshotResponse`, all focused mutations refresh that snapshot once, provider browsing remains live, and every indexing/quota/sync concept has been removed from the admin runtime and its acceptance fixtures.

No cloud mutation was performed. No plan, specification, ledger, or TV application file was changed.

## Implementation

- Replaced `overview()`, `settings()`, and `sources()` with `snapshot()` as the only admin read/refresh boundary.
- Removed `syncSource`, source-tree, thumbnail, overview, settings-read, and sources-read client APIs.
- Corrected the passphrase route to `/api/admin/passphrase` and retained exact confirmation bodies for destructive mutations.
- Added strict successful-payload and raw error-envelope decoders for final Control DTOs. Unknown fields, legacy DTO fields, malformed envelopes, unsafe authorization URLs, and invalid enum/primitive shapes fail closed.
- Normalized all user-visible server errors to bounded safe copy; upstream/internal messages are never rendered or logged.
- Preserved credentials and in-memory CSRF behavior, including one safe retry and monotonic token updates across concurrent responses.
- Collapsed `AdminApp` to one snapshot state with a single initial request, generation-protected refreshes, StrictMode-safe mounted state, unmount protection, and stale-response rejection.
- Converted requests, devices, sources, roots, impact dialogs, settings, approval, workbench, and fixtures to final Control DTOs.
- Deleted `IndexStatus` and removed its design/CSS helpers.
- Removed indexing, quota, cadence, sync, document estimates, readiness, processed/pending/reconciling/preparing language, attributes, controls, and screenshots.
- Added the exact workbench copy: “Browse the provider live. Folders added to the household program are available to assigned televisions immediately.”
- Root/source removal now says access is removed immediately and retains explicit affected-root/device review.
- Root creation updates the workbench program immediately, retains the safe provider ID only as ephemeral authenticated workbench state, and refreshes the snapshot once.
- Source status maps exactly to Connected, Reauthorization required, and Disabled. Provider request failures use the transient “Provider temporarily unavailable” presentation without changing source status.
- Settings and overview show approved devices, connected healthy sources, approved roots, pending requests, and recovery-copy truth. Delayed copy is exactly “Recovery copy delayed; active service remains on Vercel”.
- Disabled roots remain visible as inactive legacy migration records with accessible removal impact, without readiness/index implications.
- Updated admin synthetic fixtures and acceptance coverage to the snapshot contract; regenerated the two enrollment baselines and removed obsolete quota screenshots.

## RED evidence

### Required initial snapshot tests

Command:

```text
npx vitest run --config apps/admin/vitest.config.ts src/api/client.test.ts src/app.test.tsx
```

Observed before implementation:

```text
Test Files  2 failed (2)
Tests       2 failed | 21 passed (23)
TypeError: client.snapshot is not a function
Unable to find an element with the text: Household overview
```

This demonstrated the missing client method and the app's continued dependence on the legacy three-read load.

### StrictMode lifecycle regression

Command:

```text
npx vitest run --config apps/admin/vitest.config.ts src/app.test.tsx
```

Observed after adding the regression and before the mounted-state fix:

```text
Test Files  1 failed (1)
Tests       1 failed | 14 passed (15)
Unable to find role="heading" and name "Device requests"
```

The first StrictMode effect cleanup left the mounted guard false, preventing the single snapshot result from committing. The effect setup now restores the guard without issuing a second request.

## GREEN evidence

### Focused client boundary

```text
npx vitest run --config apps/admin/vitest.config.ts src/api/client.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)
```

Covered one snapshot request, absence of legacy reads, credentials, CSRF rotation/retry/concurrency, strict success/error decoding, safe errors, exact routes/bodies, and live paging query encoding.

### Focused lifecycle and live-workbench coverage

```text
npx vitest run --config apps/admin/vitest.config.ts src/app.test.tsx src/components/source-workbench.test.tsx src/components/provider-folder-stage.test.tsx
Test Files  3 passed (3)
Tests       23 passed (23)
```

Covered stale refresh ordering, unmount safety, exact copy, optimistic roots, one refresh, empty/error distinction, paging aborts, provider-ID locality, impact races, and immediate removal truth.

### Final admin suite

```text
npx vitest run --config apps/admin/vitest.config.ts
Test Files  8 passed (8)
Tests       41 passed (41)
```

### Typecheck

```text
npm run typecheck
tsc -p tsconfig.base.json --noEmit && tsc -p apps/tv/tsconfig.json --noEmit && tsc -p apps/admin/tsconfig.json --noEmit
Exit code: 0
```

### Lint

```text
npm run lint -- --quiet
Exit code: 0
```

### Admin production build

```text
npm run build -w @cloudframe/admin
1944 modules transformed
build completed successfully
```

### Browser acceptance

```text
npx playwright test e2e/enrollment.spec.ts e2e/source-workbench.spec.ts --project=admin-mobile --project=admin-wide
4 passed (12.1s)
```

Covered approval/update/revoke and live source selection/removal on Pixel 7 and 1440x960 desktop viewports.

### Static removal check

The final runtime scan found no indexing, quota, Firestore, sync action/cadence, reconciliation, preparation, queue, processed/pending-folder, index-status, or `data-index-state` concepts in admin runtime code or migrated admin E2E fixtures. Remaining `index` substrings are ordinary array indices and negative test assertions.

## Impeccable evidence

- Ran context once for `apps/admin/src/app.tsx`.
- Read the harden, distill, and craft-floor guidance.
- Preserved the Screening Room Ledger visual world; did not refresh its stale indexing-era metadata.
- Ran the required detector exactly once after final visual edits:

```text
node F:\Projects\tv-video-ui\.agents\skills\impeccable\scripts\detect.mjs --json <changed admin UI targets>
[]
```

- Performed one batched visual inspection of regenerated mobile and desktop enrollment baselines. No clipping, hierarchy, contrast, touch-target, or identity regression was found.

## Self-review

- Confirmed initial session bootstrap makes one snapshot call even under React StrictMode.
- Confirmed older snapshot and CSRF responses cannot overwrite newer state.
- Confirmed aborts remain distinguishable from network failures.
- Confirmed provider IDs are not stored in snapshot/app state or rendered as user-facing copy.
- Confirmed every focused control mutation refreshes once; logout and passphrase rotation intentionally end the authenticated session instead.
- Confirmed inactive roots remain removable and never claim access readiness.
- Confirmed no unrelated worktree changes are included.

## Concerns

None known. The committed design metadata still describes the superseded indexing model, but it was intentionally not refreshed because the task explicitly prohibited stale metadata refresh and plan/spec/ledger edits.
