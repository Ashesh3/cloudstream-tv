# Cloudframe Astryx UI Redesign Implementation Plan

> Execute this plan in order. Each migration slice starts with a failing behavior or structure test, keeps the previous slice runnable, and does not delete legacy UI code until the final cleanup task.

**Goal:** Replace the Admin and TV presentation with the approved Cloudframe Night Astryx system while preserving every authorization, provider, media, remote-navigation, state-integrity, and self-hosted runtime contract.

**Architecture:** A shared `@cloudframe/theme` workspace package extends Astryx Neutral and produces normal Admin artifacts plus a deterministic Chromium-108 TV stylesheet. The TV renderer migrates from Preact to React before its presentation changes. Admin and TV then migrate in behavior-preserving slices; obsolete frameworks and assets are removed only after repository-wide zero-use scans.

**Tech stack:** React 19, TypeScript, Vite 8, Astryx Core/Neutral/CLI 0.5.1, StyleX 0.19.0 as Astryx's runtime peer, Vitest, Testing Library, Playwright, Chromium 108, Node 24, Docker.

**Approved specification:** `docs/superpowers/specs/2026-08-30-astryx-ui-redesign-design.md`

## Global constraints

- `AGENTS.md` is binding: discover Astryx APIs before use, use component-led layout, avoid layout-only `div`/`span`, keep dense records in rows, reserve Cards for standalone widgets/media, use status primitives for status, and keep app styling token-based.
- The approved Cloudframe Night specification supersedes the obsolete Screening Room Ledger direction in `DESIGN.md` and existing Impeccable artifacts. Regenerate those from the shipped interface in Task 13.
- Target the household TV at webOS TV 24 / Chromium 108. Keep the Google direct-media worker on its deliberately conservative Chrome 68 build/check lane.
- Preserve the Admin state machine, StrictMode-safe bootstrap, committed-mutation ordering, stale-result rejection, abort behavior, 401 handling, focus restoration, and provider state distinctions.
- Preserve TV pairing/session recovery, deterministic focus IDs, virtualized navigation, source-drawer focus behavior, direct Google and OneDrive delivery, HLS fallback, URL renewal, browser-only history, and Viewer reducer/media semantics.
- Do not introduce hosted media proxying, provider credentials in UI, internal IDs in diagnostics, indexing/crawl language, or server-synchronized watch history.
- Preserve unrelated untracked `.agents/`, `.codex/`, and `.impeccable/` files.
- Before every new Astryx component enters source, run `npx astryx component <Name>` and follow its documented props. Read the named template when `npx astryx build` recommends one.

## Task 1: Establish the Astryx and Cloudframe Night foundation

**Files:**

- Create: `packages/theme/package.json`
- Create: `packages/theme/src/cloudframe-night.ts`
- Create: `packages/theme/src/index.ts`
- Generate: `packages/theme/dist/cloudframe-night.css`
- Generate: `packages/theme/dist/cloudframe-night.js`
- Generate: `packages/theme/dist/cloudframe-night.d.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/admin/package.json`
- Modify: `apps/tv/package.json`
- Test: `tests/astryx-foundation.test.ts`

- [ ] Write a failing foundation test that requires exact Astryx 0.5.1 packages, StyleX 0.19.0, a shared theme workspace, deterministic generated artifacts, and the required Core CSS imports at the point each app adopts Astryx.
- [ ] Run `npx vitest run tests/astryx-foundation.test.ts` and confirm RED.
- [ ] Add `@astryxdesign/core@0.5.1`, `@astryxdesign/theme-neutral@0.5.1`, and `@stylexjs/stylex@0.19.0` to the correct workspace manifests; add `@cloudframe/theme` as the shared app dependency.
- [ ] Define `cloudframeNightTheme` with `defineTheme`, extending Neutral. The theme owns graphite body/surfaces, warm-white primary text, cool secondary text, cloud-blue accent, semantic states, moderate radii, strong focus, system sans typography, and reduced-motion-safe timing.
- [ ] Add root `build:theme` and `check:theme` scripts using `npx astryx theme build`; make product builds generate/check theme artifacts before app compilation.
- [ ] Generate and review the committed CSS/JS/declaration outputs. Do not add custom variants unless a documented built-in variant cannot carry the product state.
- [ ] Run the focused test, theme check, typecheck, and both app builds.

## Task 2: Build the deterministic Chromium 108 Astryx CSS profile

**Files:**

- Create: `scripts/astryx-css-compat.mjs`
- Create: `scripts/build-tv-astryx-css.mjs`
- Generate: `packages/theme/dist/cloudframe-night.tv.css`
- Modify: `package.json`
- Modify: `apps/tv/package.json`
- Test: `tests/astryx-tv-css.test.ts`

- [ ] Write failing fixture tests for nested `light-dark()` resolution to the dark branch, required `color-mix()` fallbacks/resolution, `@scope` removal with an application-root prefix, deterministic byte output, and fail-closed malformed/unresolved expressions.
- [ ] Add an integration assertion that shipped TV theme CSS contains no `light-dark(`, unsupported `@scope`, or unresolved required `color-mix(`.
- [ ] Implement a pure transformer and a build wrapper that consume the installed Core CSS plus the generated Cloudframe theme CSS.
- [ ] Prefix the unscoped result to the Cloudframe TV theme root so it cannot leak outside the application.
- [ ] Fail the build when an unsupported expression remains in a declaration used by shipped TV components.
- [ ] Wire `build:theme` to emit both the normal and TV compatibility artifacts.
- [ ] Run `npx vitest run tests/astryx-tv-css.test.ts`, build TV, and scan the emitted CSS.

## Task 3: Migrate the TV renderer from Preact to React with markup parity

**Files:**

- Modify: `apps/tv/package.json`
- Modify: `apps/tv/vite.config.ts`
- Modify: `apps/tv/tsconfig.json`
- Modify: `apps/tv/src/main.tsx`
- Modify: `apps/tv/src/vite-env.d.ts`
- Modify: `vitest.core.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify hook/type imports in `apps/tv/src/app.tsx`, `apps/tv/src/state/use-tv-session.ts`, and TV components
- Modify renderer imports in `apps/tv/src/app.test.tsx`, `source-drawer.test.tsx`, `viewer.test.tsx`, and `virtual-grid.test.tsx`

- [ ] Change the four renderer test files to Testing Library React and add a source/config assertion for `createRoot` with no Preact aliases; confirm RED.
- [ ] Replace Preact runtime/build/test dependencies with React 19, React DOM 19, and `@vitejs/plugin-react` without changing presentation markup.
- [ ] Replace `render` with `createRoot`, `preact/hooks` with React hooks, and Preact-only node/ref types with React equivalents.
- [ ] Remove the five Preact compatibility aliases from `vitest.core.config.ts` and the TV `jsxImportSource` setting.
- [ ] Keep the existing CSS, classes, state machine, key handlers, focus IDs, and media code unchanged.
- [ ] Run the 105 existing App, drawer, Viewer, and VirtualGrid behavior tests; then all TV tests, TV typecheck, and TV production build.

## Task 4: Retarget the application compatibility lane to Chromium 108

**Files:**

- Rename/modify: `scripts/check-chromium68.mjs` to `scripts/check-chromium108.mjs`
- Rename/modify: `scripts/chromium68-harness.mjs` to `scripts/chromium108-harness.mjs`
- Modify: `scripts/check-tv-bundle.mjs`
- Retire or repurpose: `scripts/check-tv-legacy.mjs`
- Modify: `apps/tv/vite.config.ts`
- Modify: `tests/tv-compatibility-scripts.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `PRODUCT.md`
- Modify: `docs/operations/webos-acceptance.md`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/app.test.tsx`

- [ ] Write failing tests for exact Chrome 108 naming/pinning, modern app chunks, accepted Chromium-108 layout features, rejected unresolved Astryx compatibility features, and the independently preserved Chrome-68 media worker.
- [ ] Change the TV application build target to Chrome 108 and remove legacy application chunks/polyfills once measured modern output passes.
- [ ] Freeze a browser artifact only after its executable reports `Chrome/108.*`; record its revision/checksum in the harness.
- [ ] Preserve startup, native Video.js fallback, revoked-grant ordering, authenticated Range delivery, lazy-chunk budgets, CSS budgets, and media-worker checks.
- [ ] Update active product/operations copy and unsupported-browser guidance without rewriting historical design records.
- [ ] Run compatibility tests, media-worker tests, TV build/bundle checker, pinned Chromium probe, typecheck, lint, and full Vitest.
- [ ] Stop before Task 5 if the transformed Astryx foundation cannot start and operate in pinned Chromium 108; report the exact failing primitive.

## Task 5: Migrate Admin authentication, overview, and application shell

**Files:**

- Modify: `apps/admin/src/main.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/components/login.tsx`
- Modify: `apps/admin/src/components/first-run.tsx`
- Modify: `apps/admin/src/components/shell.tsx`
- Create: `apps/admin/src/components/admin-overview.tsx`
- Create/modify focused tests for those files
- Create: `apps/admin/src/astryx-structure.test.ts`

- [ ] Add structure tests that reject legacy UI imports, layout-only `div`, Tailwind utility classes, raw palette/interior pixel styling, obsolete direction terms, status badges, and record Cards in each migrated file.
- [ ] Expand login tests for autofocus, password visibility, duplicate-submit prevention, safe failures, and retained privacy copy.
- [ ] Preserve first-run validation, setup-code/passphrase semantics, `/data` ownership, backup truth, and pending behavior.
- [ ] Preserve the App bootstrap/install/claim/login state machine, one effective StrictMode snapshot, stale refresh protection, 401 handling, OAuth cleanup, and committed-mutation warnings.
- [ ] Build the wide `AppShell`/`SideNav` and narrow `MobileNav` shell with Requests, Devices, Sources, and Settings; Badge is allowed only for the numeric pending-request count.
- [ ] Replace decorative hero/figures with semantic Sections and standalone summary widgets.
- [ ] Keep legacy CSS/wrappers loaded for unmigrated Admin slices.
- [ ] Run focused Admin tests, Admin typecheck/build, and wide/mobile shell/auth Playwright coverage.

## Task 6: Migrate Admin Requests and Devices

**Files:**

- Modify: `apps/admin/src/components/requests.tsx`
- Modify: `apps/admin/src/components/requests.test.tsx`
- Modify: `apps/admin/src/components/approval-sheet.tsx`
- Modify: `apps/admin/src/components/approval-sheet.test.tsx`
- Modify: `apps/admin/src/components/devices.tsx`
- Modify: `apps/admin/src/components/devices.test.tsx`
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/app.test.tsx`
- Modify: `e2e/enrollment.spec.ts`

- [ ] Describe pending-request rows, newest-first ordering, pause warning, direct Approve/Deny actions, and distinct empty state in failing tests.
- [ ] Use `List`/`Item`, `StatusDot`, `Token`, `Banner`, Dialog, AlertDialog, and Astryx form controls; do not wrap requests/devices in per-record Cards.
- [ ] Preserve approval autofocus, focus trap, Escape, opener restoration, enabled-root filtering, validation, and phone-height behavior.
- [ ] Preserve denial/revocation confirmation, immediate committed removal, task-UI closure, exactly one background refresh, and non-rollback recovery warnings.
- [ ] Preserve device name/enabled state/root assignments/media order/slideshow timing, strip inactive assignments, and distinguish enabled/disabled/active/inactive legacy state.
- [ ] Verify 44-by-44 minimum targets, internally scrolling dialogs, no TV-cookie creation, and updated wide/mobile enrollment screenshots.

## Task 7: Migrate Admin Sources and source workbench

**Files:**

- Modify: `apps/admin/src/components/sources.tsx`
- Add: `apps/admin/src/components/sources.test.tsx`
- Modify: `apps/admin/src/components/source-workbench.tsx`
- Modify: `apps/admin/src/components/source-workbench.test.tsx`
- Modify: `apps/admin/src/components/provider-folder-stage.tsx`
- Modify: `apps/admin/src/components/provider-folder-stage.test.tsx`
- Modify: `apps/admin/src/components/household-program.tsx`
- Modify: `apps/admin/src/components/household-program.test.tsx`
- Modify: `apps/admin/src/components/folder-picker.tsx`
- Modify: `apps/admin/src/components/folder-picker.test.tsx`
- Create: `apps/admin/src/lib/provider-name.ts`
- Modify: `e2e/source-workbench.spec.ts`

- [ ] Add failing source-row tests for provider/account/status/root-count/actions, reauthentication, disabled state, reconnect IDs, and count-only Badge usage.
- [ ] Preserve source-impact loading, stale-response rejection, focus restoration, safe failures, immediate committed removal, assignment cleanup, and recovery warnings.
- [ ] Preserve live provider browsing, successful empty versus transient failure, abort on navigation/unmount, breadcrumb navigation, pagination append/de-duplication, retry without losing rows, and immediate root creation.
- [ ] Keep the workbench in-layout: desktop `LayoutContent` plus fixed `LayoutPanel`, stacked tablet regions, and sequential full-width mobile planes.
- [ ] Preserve Escape/close behavior, trigger focus restoration, root-impact confirmation, optimistic add/remove, and inactive-root truth.
- [ ] Replace old stage/ledger/program-stock implementation language with provider folders and household/television access language.
- [ ] Add intentional desktop/mobile workbench captures and assert no horizontal leakage or undersized controls.

## Task 8: Migrate Admin Settings and diagnostics

**Files:**

- Modify: `apps/admin/src/components/settings.tsx`
- Add: `apps/admin/src/components/settings.test.tsx`
- Modify: `apps/admin/src/components/transcode-diagnostics.tsx`
- Modify: `apps/admin/src/components/transcode-diagnostics.test.tsx`
- Modify: `apps/admin/src/app.test.tsx`
- Replace: `apps/admin/src/styles/app.test.ts`
- Add: `e2e/admin-settings.spec.ts`

- [ ] Add failing tests for prop resynchronization, exact defaults submission, finite/range validation, pending behavior, and committed-save recovery warnings.
- [ ] Render a flat ordered Section/FormLayout composition for playback defaults, local installation/storage truth, diagnostics, passphrase rotation, and sign-out.
- [ ] Use MetadataList/StatusDot/ProgressBar/Banner for diagnostics; never show internal identifiers, URLs, credentials, or fabricated progress.
- [ ] Add fake-timer tests for immediate five-second polling, abort-before-next, unmount cleanup, stable callback dependencies, and distinct 401 behavior.
- [ ] Preserve 16-character passphrase checks, session invalidation after rotation, and admin-only sign-out.
- [ ] Remove the Admin legacy CSS/font entry imports only when all active Admin consumers are Astryx-based; retain physical wrapper deletion for Task 12.
- [ ] Run the full Admin suite, root typecheck/lint, Admin build, wide/mobile Playwright, and a bounded desktop/phone visual pass.

## Task 9: Migrate TV state panels, request/waiting flows, header, and source drawer

**Files:**

- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/app.test.tsx`
- Modify: `apps/tv/src/components/device-request.tsx`
- Add/modify focused request tests
- Modify: `apps/tv/src/components/waiting-screen.tsx`
- Add/modify focused waiting tests
- Modify: `apps/tv/src/components/tv-header.tsx`
- Add/modify focused header tests
- Modify: `apps/tv/src/components/source-drawer.tsx`
- Modify: `apps/tv/src/components/source-drawer.test.tsx`
- Add: `apps/tv/src/astryx-structure.test.ts`

- [ ] Add structural tests for imported Astryx primitives and the absence of forbidden popover/tooltip/dropdown/selector dependencies in TV code.
- [ ] Preserve every distinct application state: opening, requests disabled, request form, waiting, denied/expired, offline, unsupported, no roots, source unavailable, empty folder, pagination failure, and viewer/transcode states.
- [ ] Compose remote-scale forms/states with Layout, Section, VStack/HStack, Heading/Text, Field/TextInput, Button/ButtonGroup, Banner, StatusDot, Spinner, and ProgressBar where documented.
- [ ] Keep the header shallow and non-layered; avoid Astryx subcomponents that internally require Popover until the Chromium probe proves them safe.
- [ ] Keep the source chooser an explicit full-screen/large drawer with the existing focus manager, background blocking, deterministic first focus, same-column movement, Back dismissal, and restoration.
- [ ] Exclude manual/reconfigure controls from automatic initial or replacement focus.
- [ ] Run focused TV tests, pinned Chromium request/wait/drawer interactions, and a 1920-by-1080 focus/overflow review.

## Task 10: Migrate TV collections, folder/media cards, and browse composition

**Files:**

- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/app.test.tsx`
- Modify: `apps/tv/src/components/folder-card.tsx`
- Modify: `apps/tv/src/components/media-card.tsx`
- Modify: `apps/tv/src/components/virtual-grid.tsx`
- Modify: `apps/tv/src/components/virtual-grid.test.tsx`
- Modify: `apps/tv/src/thumbnails.ts`
- Modify: `apps/tv/src/thumbnails.test.ts`
- Modify: `apps/tv/src/pagination.ts`
- Modify: `apps/tv/src/pagination.test.ts`
- Modify: `e2e/browse-viewer.spec.ts`

- [ ] Add failing structure/presentation tests for spacious root collection Cards/ClickableCards, virtualized folder/media tiles, visible focus, fallback art, loading/error state, and pagination status outside navigation targets.
- [ ] Preserve VirtualGrid row/column math, mounted-window behavior, deterministic IDs, visibility callbacks, thumbnail warming, one-page prefetch, and focus recovery.
- [ ] Use Astryx Grid/Card/ClickableCard/AspectRatio/Overlay/Thumbnail only where their DOM and keyboard behavior pass Chromium 108 and do not replace the explicit remote navigation authority.
- [ ] Make focus unmistakable through theme-owned outline/elevation/scale without changing geometry or DOM order.
- [ ] Keep provider-empty, provider-failed, source-disabled/revoked, no-roots, and healthy empty-folder states distinct.
- [ ] Run browse/grid/thumbnail/pagination tests, TV build/bundle checks, pinned Chromium navigation, and TV home/focused/source-drawer captures.

## Task 11: Migrate Viewer presentation without replacing its media engine

**Files:**

- Modify: `apps/tv/src/components/viewer.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`
- Modify: `apps/tv/src/components/image-viewer.tsx`
- Modify: `apps/tv/src/components/video-player.tsx`
- Modify: `apps/tv/src/components/viewer-overlay.tsx`
- Modify: `apps/tv/src/videojs.ts`
- Preserve media bridge/worker/HLS/history modules except for required type imports
- Modify: `e2e/browse-viewer.spec.ts`

- [ ] Lock existing Viewer reducer, source-selection, URL-renewal, history, slideshow, Back, capture-phase keys, fallback, and transcode-busy behavior with the current tests before presentation edits.
- [ ] Compose viewer surfaces with Astryx Overlay, Button/ButtonGroup, ProgressBar, StatusDot, Banner, Text, and token-driven layout without adopting Lightbox as the authority.
- [ ] Preserve the media element/custom-element lifecycle, native/video.js/HLS decisions, Google worker bridge, OneDrive capabilities, error fallbacks, and secret boundaries.
- [ ] Keep overlay-first Back behavior and directional/playback shortcuts at capture phase.
- [ ] Add viewer loading/error/busy/control captures and pinned Chromium direct-media Range/HLS later-seek/runtime coverage.
- [ ] Run all Viewer/media tests, TV build/bundle/Chromium gates, and browse-viewer Playwright.

## Task 12: Remove obsolete frameworks, wrappers, assets, and direction artifacts

**Files:** repository-wide usage-driven cleanup

- [ ] Prove zero active references to Preact, Testing Library Preact, local Admin UI wrappers, Radix/shadcn utilities, Tailwind, old fonts, program-stock assets, and obsolete direction symbols before deleting anything.
- [ ] Remove `apps/admin/src/components/ui/`, obsolete `components/dialog.tsx`, unused `folder-picker.tsx`, `lib/utils.ts`, `hooks/use-mobile.ts`, `components.json`, Tailwind/PostCSS config, and unused manifests only after the scans are clean.
- [ ] Remove Preact dependencies and aliases after the React checkpoint remains green.
- [ ] Remove obsolete `program-stock.webp`, its metadata/generator, Archivo Narrow, old theme CSS/tokens, and unused starter SVGs after zero-use verification.
- [ ] Rewrite `tests/design-materials.test.ts` around Cloudframe Night/Astryx invariants instead of Screening Room material.
- [ ] Keep only narrowly necessary token/data-attribute CSS for product-specific behavior; enforce no raw app palette/interior pixel values and no layout-only `div`/`span` in migrated files.
- [ ] Run focused UI tests, all Vitest, typecheck, lint, full build, and `git diff --check` after deletion.

## Task 13: Complete automated, visual, independent, documentation, and real-TV gates

**Files:**

- Modify: `scripts/copy-review-captures.ps1`
- Replace final screenshots/detector evidence under `.impeccable/review/`
- Regenerate: `DESIGN.md`
- Regenerate: `.impeccable/design.json`
- Modify active operations/product documentation as required

- [ ] From a clean dependency tree run theme validation/Astryx doctor, all Vitest, typecheck, lint, full UI/server builds, TV bundle/Chromium checks, all Playwright, production dependency audit, Docker build, and container smoke.
- [ ] Add intentional Admin login/first-run/settings/workbench and TV home/focused/drawer/viewer/error/busy screenshots; replace baselines only after opening and inspecting every PNG.
- [ ] Fix `scripts/copy-review-captures.ps1` so it copies real final desktop, mobile, and TV captures instead of deleted quota snapshots.
- [ ] Perform one batched desktop/mobile/TV visual inspection, one consolidated correction batch, and at most one confirmation capture.
- [ ] Run the Impeccable detector once on changed UI targets, then send the original request/spec, diff, automated results, final captures, detector findings, target sizes, intentional exceptions, and craft-floor reference to a fresh independent finish reviewer.
- [ ] Close the review under its `recapture`, `rebuild`, `fix`, or `ship` disposition; do not self-certify around open findings.
- [ ] Regenerate `DESIGN.md` and `.impeccable/design.json` from the shipped Cloudframe Night interface after the final correction.
- [ ] Build and identify the exact Docker candidate with commit SHA/image digest and record all synthetic gate results.
- [ ] Execute `docs/operations/webos-acceptance.md` on the physical webOS TV 24. Until that external pass is complete, report `REAL_WEBOS_ACCEPTANCE_PENDING` rather than claiming television acceptance.
- [ ] Finish with `git status`, `git diff --stat`, `git diff --check`, untracked-scope review, and confirmation that transferred/temp artifacts are excluded from commits.

