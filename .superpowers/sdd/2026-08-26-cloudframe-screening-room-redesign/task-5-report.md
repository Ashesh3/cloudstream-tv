# Task 5 Report: Root-Scoped Index Work

## Outcome

- Initial and already-launched delta workflows complete without credentials or provider calls when no roots are enabled.
- Initial crawl still starts from enabled provider roots, and generation reconciliation marks metadata from disabled roots unavailable.
- Delta pages retain only selected roots and descendants proven by same-page or current indexed ancestry; existing nodes moved outside the selected program become removals.
- Manual Sync now and due-source launches derive `initial`, `reconcile`, or `delta` from persisted source state; only root creation explicitly forces `initial`.
- `RESOURCE_EXHAUSTED` is persisted as terminal recoverable source state with no automatic retry date while preserving replay, lease, and checkpoint guards.
- Source index-state classification is shared through `sourceIndexStateKind` for later admin and TV consumers.

## TDD Evidence

- The first RED run had 11 expected failures covering shared state export, manual/due mode selection, zero-root work, delta scope/removal, and quota persistence.
- Additional RED regressions caught child-before-parent ordering, same-page parent removal, zero-root delta work, failure-state write masking, and quota after an already-committed checkpoint.

## Architecture Rulings

- The plan's sequential `acceptedProviderIds` sample was not used because provider change ordering is not an ancestry guarantee. The filter resolves the complete page recursively and accepts a changed child even when its changed parent appears later.
- An `available` indexed parent is insufficient by itself: it must contain an enabled root node in its current indexed ancestry, preventing stale whole-drive metadata from admitting new nodes before reconciliation.
- Generation reconciliation already provides the required stale-metadata behavior, so repository reconciliation transactions were left unchanged.
- If the bounded failure-state transaction is also rejected by Firestore quota, the original quota error is preserved rather than masked; no workflow-level retry loop was added.

## Verification

- `npx vitest run --config vitest.core.config.ts tests/indexer.test.ts tests/workflow-runtime.test.ts tests/ops-scripts.test.ts tests/repository.test.ts tests/admin-management-api.test.ts tests/api-contracts.test.ts tests/browse-authorization.test.ts` — 7 files, 132 tests passed.
- `npm test` — 29 files, 354 tests passed.
- `npm run typecheck` — passed.
- `git diff --check` — passed.

## Self-Review

- Delta cursors, filtered page fingerprints, checkpoints, and node mutations remain in the existing atomic batch commit.
- Failure recording re-reads the current source so quota after a successful page commit is guarded against the advanced checkpoint.
- The durable workflow still executes exactly one orchestrator page per step and contains no quota-specific retry handling.
- Protected product, plan, spec, and impeccable artifacts remain untouched and unstaged.

## Fix Round 1

- Reproduced an active two-root initial crawl continuing through a disabled root's queued descendant. Initial checkpoints now persist sorted `rootProviderIds`; every step compares that snapshot with current enabled roots. A changed or legacy missing snapshot restarts from current roots with a fresh generation while preserving the valid lease and workflow run. Removing the last root transitions directly to reconciliation without credentials or provider calls, so prior metadata becomes unavailable.
- Reproduced folder delete and move-out leaving unchanged descendants available. The atomic batch boundary now derives cascade removals only for removed folders, includes every available descendant in the memory/Firestore write set, recomputes affected ancestor metadata, and counts cascaded writes before Firestore's bound. Non-folder removal does not cascade.
- Added TV browse authorization and admin source-tree regressions proving cascaded descendants are inaccessible and omitted, plus availability-count coverage and a Firestore transaction regression.
- Migration ruling: `rootProviderIds` is optional only for persisted compatibility; any legacy active initial checkpoint without it is unsafe and restarts. Delta and reconciliation checkpoints require no snapshot or backfill.
- Verification: focused indexer/repository/browse/admin/workflow/API suites passed with 134 tests; full suite passed with 363 tests; typecheck and `git diff --check` passed.
