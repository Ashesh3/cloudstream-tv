# Task 6 Report: Admin Live Folder Workbench

## Outcome

- Replaced indexed `MediaNodeDto` folder selection with a live provider folder stage backed by `AdminApi.providerFolders`.
- Added breadcrumb navigation, bounded cursor paging without duplicate rows, loading skeletons, stale-request aborts, keyboard-operable folder actions, and selection persistence while browsing.
- Added a persistent household program rail with normalized index truth, assigned televisions, removal impact confirmation, and explicit legacy whole-drive labeling/warning.
- Preserved `FolderPicker` as a compatibility wrapper and changed the Sources action to **Browse & choose folders**.
- Passed existing overview devices through `AdminApp -> Sources -> SourceWorkbench`; no per-root impact fan-out is needed for ordinary display.

## State and Error Rulings

- Provider-empty renders only after a successful live response with zero child folders.
- Loading, provider failure, reauthorization, indexing, reconciliation, quota exhaustion, and empty remain distinct states.
- Sources now uses the normalized ledger copy rather than exposing raw infrastructure error codes.
- Legacy provider-root selections render as **Entire My Drive** or **Entire OneDrive** with **Legacy whole-drive selection** and are never removed automatically.
- Removal remains isolated in a single confirmation dialog; affected televisions are fetched before the destructive action is enabled.

## TDD Evidence

- Initial RED: all three requested suites failed because `ProviderFolderStage`, `HouseholdProgram`, and `SourceWorkbench` did not exist.
- Added regressions for successful provider-empty, provider/error state separation, stale-request abort, pagination deduplication, breadcrumb/back navigation, add persistence, assigned televisions, legacy whole-drive warning, and removal impact.
- Updated the compatibility wrapper tests to prove the retired indexed tree and thumbnail path is no longer used.

## Verification

- `npx vitest run --config apps/admin/vitest.config.ts` — 7 files, 32 tests passed.
- `npx tsc -p apps/admin/tsconfig.json --noEmit` — passed.
- `npm run build -w @cloudframe/admin` — passed.
- Changed-file ESLint — passed.
- `git diff --check` — passed.
- Impeccable detector intentionally not run; the approved plan reserves its single run for Task 10.

## Self-Review

- `AdminApi.providerFolders` accepts an optional `AbortSignal` and forwards it to fetch without changing query serialization.
- Cursor pages merge by `providerNodeId`; navigation aborts the previous request and stale responses cannot overwrite the active location.
- Adding a folder updates the program immediately, refreshes authoritative admin data, and remains selected while the user browses elsewhere.
- No fabricated child/media counts, browser storage, provider secrets, backend authorization changes, or Task 7 global visual replacement were introduced.
- Protected product, plan, spec, and Impeccable artifacts plus `apps/admin/node_modules` remain untouched and unstaged.
