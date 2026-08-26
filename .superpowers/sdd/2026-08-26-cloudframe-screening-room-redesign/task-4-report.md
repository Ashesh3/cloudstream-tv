# Task 4 Report: Selected Roots and Initial Sync

## Outcome

- Root creation now accepts a live provider node identity, resolves trusted provider ancestry, and persists only the deterministic `AssignedRoot` plus its provider ancestry IDs.
- Root enable/re-enable and initial source reset happen atomically in both Firestore and memory repositories.
- Initial indexing is launched after persistence; launch failure keeps the selection enabled in a retryable queued state and returns a secret-safe `503 INDEXING_LAUNCH_FAILED` response.
- Legacy whole-drive roots are preserved until explicitly removed.
- Duplicate concurrent selections retain a single deterministic root and a single workflow launch through the sync lease.

## TDD Evidence

The first focused run failed with eight expected regressions: live provider IDs returned indexed-node `404 FOLDER_NOT_FOUND`, and `enableRootAndResetInitial` did not exist. A later queued-state regression failed because launch failure encoded `recoverable: false`. Both failure modes were observed before their implementations.

## Verification

- `npm run typecheck`
- `npx vitest run --config vitest.core.config.ts tests/admin-management-api.test.ts tests/repository.test.ts tests/indexer.test.ts tests/api-contracts.test.ts tests/structured-logging.test.ts`
- Result: 5 files passed, 92 tests passed.
- `git diff --check`

## Self-review

- No provider ancestor `MediaNode` documents are created.
- Source identity and encrypted credentials are preserved by field-level transaction updates.
- Launch errors are wrapped and normalized without exposing backend error messages.
- An active initial lease is not cleared by a concurrent duplicate selection.
- Protected product, plan, spec, and impeccable artifacts remain untouched and unstaged.
