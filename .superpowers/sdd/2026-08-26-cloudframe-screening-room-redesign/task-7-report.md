# Task 7 Report: Admin Screening Room Ledger

## Outcome

- Replaced the complete admin visual world with the approved Screening Room Ledger: projection black, warm program stock, cue orange, ash metal, hairline seams, condensed ledger titles, and selective depth across login, shell, overview, requests, approvals, devices, sources, settings, dialogs, empty/loading/error states, and the live folder workbench.
- Added self-hosted Instrument Sans and Archivo Narrow and removed the retired Geist package.
- Emitted the exact direction contract as the first admin-root child at runtime and in the production HTML root; `apps/admin/dist/index.html` contains seed `b10bdc63`.
- Reordered the first viewport to source truth, attention, then quiet program figures; removed the Operations eyebrow and generic metric-card dashboard.

## Functional and Accessibility Rulings

- Mobile navigation remains four actions with bottom safe-area padding; each section has one H1 and icon-only controls retain accessible names.
- Async refresh, success, warning, and failure states use status/alert live regions.
- Approval rows name provider/account, normalized index readiness, and affected access. Quota-exhausted roots remain assignable with “Content appears after indexing resumes.”
- Settings Library Health now renders the same normalized `IndexStatus` states and ties quota recovery to Firestore headroom/billing or a smaller selected library.
- Post-add refresh failure is now a non-destructive status warning; optimistic root selection remains in the household program.

## Control Regression

- Removed the global 44px minimum that stretched Radix checkbox/switch primitives.
- Kept 44px hit targets through component buttons and checkbox/switch pseudo-elements.
- Corrected checked styling to Radix `data-state="checked"` selectors, including field-label styling.
- Added hierarchy, live-region, control-state, approval-state, and optimistic-refresh regressions.

## Verification

- RED: focused suite initially reported 7 expected failures; 17 existing tests remained green.
- `npx vitest run --config apps/admin/vitest.config.ts` — 7 files, 41 tests passed.
- `npm run typecheck` — passed.
- Changed-file ESLint — passed.
- `npm run build -w @cloudframe/admin` — passed; seed found in `apps/admin/dist/index.html:18`.
- `git diff --check` — passed.
- Full `npm run lint` is blocked by pre-existing unused `AssignedRoot` in unchanged `packages/server/src/http/app.ts:2`; no Task 7 file errors.
- Existing admin enrollment E2E completed all behavior on mobile and wide; only Task 9-owned visual baselines differed. Temporary regenerated captures were inspected, then fixture/snapshot changes were fully restored. The E2E command therefore remains non-green until Task 9 updates those owned baselines.

## Visual Inspection and Scope

- One disposable desktop and 390x844 local sanity round confirmed the projection/ledger login composition without overflow.
- Temporary mobile/wide post-enrollment captures confirmed responsive truth strip, program figures, navigation, empty state, and final notices; no final Task 10 review artifacts were created.
- Impeccable detector was intentionally not run; Task 10 owns the single detector/review pass.
- Protected plan/spec/product/Impeccable artifacts and `apps/admin/node_modules` remain untouched and unstaged.
