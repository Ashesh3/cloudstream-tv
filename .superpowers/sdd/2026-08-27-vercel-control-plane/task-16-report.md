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

## Review fix round 1

### Findings addressed

- Split focused mutation success from snapshot refresh recovery. Approval, denial, device edits, revocation, settings, root creation/removal, and source removal now apply their committed result locally, close editors/confirmations, show success, then attempt exactly one refresh. A non-401 refresh failure shows: “Change saved, but the household ledger could not be refreshed. Refresh to confirm the latest state.” Mutation failures still use the existing stale-mutation recovery path.
- Device cards count only enabled assigned roots, identify disabled assignments as inactive legacy entries that grant no access, and never show active access when no active roots remain. Device editing starts from enabled IDs only, explicitly names stale assignments that saving removes, and submits an empty active assignment set when appropriate.
- Added one shared provider authorization URL validator used by the admin client decoder and the control OAuth service. Google is restricted to `https://accounts.google.com/o/oauth2/v2/auth`; Microsoft is restricted to `https://login.microsoftonline.com/{one safe tenant segment}/oauth2/v2.0/authorize`. Alternate origins/ports/paths, credentials, fragments, encoded separators, dot segments, empty tenants, and multiple tenant segments are rejected.
- Hardened successful-response decoding to plain own enumerable data records and ordinary arrays only. Symbols, non-enumerables, accessors, class instances, inherited structure, proxies, and unsafe integers fail as `AdminApiError(INVALID_RESPONSE)`; null-prototype data records remain accepted.
- Raised primary workbench Close, Back, Add, breadcrumb, and removal controls to at least 44×44 CSS pixels. Browser acceptance now measures each class of target and verifies focus restoration after Cancel, Escape, and workbench closure.
- Replaced the global reduced-motion kill switch with scoped alternatives for program-row animation, folder/approval transitions, admin controls, and dialogs.

### RED evidence

The focused pre-fix run produced 12 failing admin regressions and 2 failing OAuth regressions. Failures showed committed mutations remaining in dialogs or being reported as errors after refresh rejection, inactive root IDs counted/submitted as active, arbitrary provider URLs accepted, hostile decoder objects accepted, and the global reduced-motion rule still present.

### GREEN and verification evidence

```text
npx vitest run --config apps/admin/vitest.config.ts
Test Files  10 passed (10)
Tests       54 passed (54)
```

```text
npx vitest run tests/control-oauth.test.ts
Test Files  1 passed (1)
Tests       26 passed (26)
```

```text
npm run typecheck
Exit code: 0
```

```text
npm run lint -- --quiet
Exit code: 0
```

```text
npm run build -w @cloudframe/admin
1951 modules transformed
build completed successfully
```

```text
npx playwright test e2e/source-workbench.spec.ts --project=admin-mobile --project=admin-wide
2 passed (12.4s)
```

The Playwright journey checks touch dimensions, live selection/removal, Cancel focus restoration, Escape focus restoration, and return focus after closing the workbench on mobile and wide projects.

### Impeccable review pass

Re-read the hardening and craft-floor guidance, preserved the Screening Room Ledger identity, and ran the design detector once after final visual changes:

```text
node F:\Projects\tv-video-ui\.agents\skills\impeccable\scripts\detect.mjs --json <changed admin UI targets>
[]
```

## Review fix round 2

### Findings addressed

- Committed approval, device-edit, and revocation dialogs now close and clear their mutation pending state immediately after the focused server operation resolves. The single snapshot refresh starts in the background, so a never-settling refresh cannot retain a dialog or spinner. Refresh rejection and 401 handling remain on the existing recovery path.
- Admin HTTP decoding no longer invokes `Response.json()`. It incrementally reads and bounds the native response byte stream before fatal UTF-8 decoding and captured intrinsic `JSON.parse`. Exotic objects and transparent proxies cannot enter from an overridden JSON method or execute traps during decoding.
- Scoped reduced-motion CSS now also disables runtime `animate-spin` and `animate-pulse` classes under the admin/login surfaces while preserving visible status text.
- Microsoft tenant validation now allows only `common`, `organizations`, `consumers`, canonical GUIDs, or bounded DNS-style names with nonempty labels, alphanumeric boundaries, and internal hyphens. Trailing dots, consecutive dots, underscores, tildes, percent encodings, separators, and dot segments are rejected by the shared client/server boundary.

### RED evidence

The focused pre-fix run failed six admin regressions and one server OAuth regression:

- approval, device edit, and revocation stayed open with pending controls while a post-commit refresh never settled;
- the client invoked an overridden `Response.json()`;
- reduced-motion CSS omitted `animate-spin` and `animate-pulse`;
- `common.` was accepted as a Microsoft tenant in both client and server validation.

### GREEN evidence

```text
npx vitest run --config apps/admin/vitest.config.ts src/app.test.tsx src/api/client.test.ts src/styles/app.test.ts
Test Files  3 passed (3)
Tests       39 passed (39)
```

```text
npx vitest run tests/control-oauth.test.ts
Test Files  1 passed (1)
Tests       27 passed (27)
```

The final full-suite/build/lint/typecheck evidence for this round follows in the commit verification record.

## Review fix round 2

### Findings addressed

- Focused mutation completion no longer waits for the snapshot refresh. Approval, device edit, and revocation apply local truth and resolve their close callbacks immediately, then start the single refresh in the background. Never-settling refresh regressions prove dialogs and spinners do not remain open.
- Admin response decoding ignores overridden `Response.json()` methods and incrementally bounds the native response stream at 4 MiB before decoding/parsing. A transparent side-effecting proxy supplied by a mocked `json()` override is never called or observed.
- Reduced-motion CSS now stops continuous `animate-spin` and `animate-pulse` runtime classes in the admin, login, and portaled dialog contexts while retaining visible loading labels and avoiding a global selector.
- Microsoft tenant validation now permits only the three documented aliases, canonical GUIDs, and bounded DNS-style tenant/domain names. Tests reject trailing/consecutive dots, underscores, tildes, percent encodings, separators, dot segments, and invalid label boundaries in both client and server paths.

### RED evidence

The focused pre-fix run failed six admin tests and one OAuth test: approval/edit/revoke stayed pending against a never-resolving refresh, the client invoked an overridden `Response.json()`, scoped motion missed spin/pulse utilities, and `common.` was accepted as a Microsoft tenant.

### Final verification evidence

```text
npx vitest run --config apps/admin/vitest.config.ts
Test Files  10 passed (10)
Tests       59 passed (59)
```

```text
npx vitest run tests/control-oauth.test.ts
Test Files  1 passed (1)
Tests       27 passed (27)
```

```text
npm run typecheck
Exit code: 0
```

```text
npm run lint -- --quiet
Exit code: 0
```

```text
npm run build -w @cloudframe/admin
1951 modules transformed
build completed successfully
```

No Playwright rerun was needed because this round changed callback ordering covered directly by component tests and reduced-motion CSS only; touch/focus markup and behavior were unchanged from the passing fix-round-1 browser run.

### Impeccable detector

Ran once after final CSS changes:

```text
node F:\Projects\tv-video-ui\.agents\skills\impeccable\scripts\detect.mjs --json apps/admin/src/app.tsx apps/admin/src/styles/app.css
[]
```

## Review fix round 3

### Finding addressed

The 4 MiB admin response limit is now enforced while reading raw response bytes instead of after `Response.text()` fully buffers the body. The client obtains a stream reader, counts each `Uint8Array.byteLength`, stops and cancels immediately once the total exceeds 4 MiB, joins only a complete bounded body, decodes UTF-8 with `fatal: true`, and then parses with the captured intrinsic JSON parser.

Null bodies, stream read failures, synchronous/asynchronous cancellation failures, malformed UTF-8, malformed JSON, and downstream decoder failures all retain the existing safe response-error behavior.

### RED evidence

Before the fix, the streaming regression pulled all eight 1 MiB producer chunks instead of stopping after the fifth and did not cancel the producer. The prior report claim that the 4 MiB bound applied at the byte boundary was therefore incorrect; it applied only after full text buffering.

### Focused GREEN evidence

```text
npx vitest run --config apps/admin/vitest.config.ts src/api/client.test.ts
Test Files  1 passed (1)
Tests       16 passed (16)
```

Coverage includes early oversize cancellation, raw multibyte UTF-8 byte counting, null and failing streams, sync/async cancellation failures, malformed UTF-8/JSON, and the existing decoder/security cases.

## Review fix round 4

### Finding addressed

Every response-stream value is now branded as an actual `Uint8Array` before byte accounting or retention. The guard uses captured ArrayBuffer-view and typed-array intrinsic operations, so a hostile object cannot execute a `byteLength` getter. A non-byte chunk is cancelled after the first pull and returns through the existing `AdminApiError(INVALID_RESPONSE)` path rather than leaking a raw getter, type, or range error. Retained chunks are revalidated during bounded concatenation so later mutation also fails closed.

### RED evidence

The new Response-backed regression originally escaped with the hostile chunk's raw `Error: non-byte chunk getter executed`; cancellation and safe admin error mapping were never reached.

### Final verification evidence

```text
npx vitest run apps/admin/src/api/client.test.ts
Test Files  1 passed (1)
Tests       17 passed (17)
```

The focused suite proves the non-byte stream is pulled once, cancelled once, never reads the hostile getter, and rejects as status-200 `AdminApiError(INVALID_RESPONSE)`. It also keeps the oversized/read/cancel/malformed regressions green.

```text
npx vitest run --project admin
Test Files  10 passed (10)
Tests       63 passed (63)
```

```text
npm run typecheck
Exit code: 0
```

```text
npm run lint
Exit code: 0
```

```text
npm run build -w @cloudframe/admin
1951 modules transformed
build completed successfully
```

No Playwright or design-detector rerun was needed because this round changes only the response decoder and its unit regression; admin UI markup, styling, focus, and interaction behavior are unchanged.
