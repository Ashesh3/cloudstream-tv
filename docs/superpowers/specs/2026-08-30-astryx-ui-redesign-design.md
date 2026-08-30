# Cloudframe Astryx UI Redesign

**Date:** 2026-08-30

**Status:** Approved for planning

## Goal

Replace Cloudframe's current Screening Room Ledger interface with one coherent Astryx design system across the household administrator and television applications. Preserve all product truth, authorization boundaries, media delivery behavior, remote-control behavior, and operational state semantics while replacing the visual world, layout primitives, forms, lists, navigation, dialogs, and responsive composition.

## Confirmed platform target

- The household television runs webOS TV 24 with Chromium 108.
- Administration remains a mobile-first web application for modern phone and desktop browsers.
- The self-hosted Node and Docker runtime, encrypted SQLite state, Google Drive and OneDrive integrations, direct-media service worker, FFmpeg/HLS path, and one-active-transcode policy do not change as part of this redesign.
- Cloudframe continues to support the configured target household rather than advertise the former generic LG webOS 5+/Chromium 68 UI promise.

## Design direction

### Cloudframe Night

Cloudframe will use a quiet, dark household-media interface built from Astryx's structural grammar rather than the current projection-booth metaphor. The visual system will feel calm at television distance and precise on a phone:

- graphite body and surface planes;
- warm-white primary content and restrained cool secondary content;
- a clear cloud-blue accent for selection, focus, and committed action;
- semantic success, warning, and error colors reserved for real operational state;
- moderate rounded geometry from the Astryx radius scale;
- soft elevation only for standalone widgets and temporary layers;
- system or bundled sans typography, with large television headings and compact administrative metadata;
- short, purposeful transitions with complete reduced-motion alternatives.

The old paper texture, perforations, registration marks, projection terminology, condensed display typography, and cue-orange accent will be removed. Product language such as household, source, collection, television access, local storage, and transcoder remains.

## Astryx foundation

### Packages

The repository will use these compatible Astryx 0.5.1 packages:

- `@astryxdesign/core@0.5.1`;
- `@astryxdesign/theme-neutral@0.5.1` as the maintained starting theme;
- `@stylexjs/stylex@0.19.0`, required by Astryx Core;
- `@astryxdesign/cli@0.5.1` as a development dependency;
- React and React DOM 19 in both UI applications.

Charts and Lab are not required. The published CLI exposes them as optional peers, and no suitable 0.5.1 package is available or necessary for this product.

### Required entry styles

Both applications will import:

```ts
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
```

A shared Cloudframe theme module will extend Astryx Neutral and will be the sole owner of brand color, typography, radius, focus, shadow, and motion tokens. Application CSS may use Astryx semantic tokens and component data attributes, but it must not redefine `--color-*` tokens in `:root` or introduce raw palette values.

### Component discipline

- Page frames use `AppShell`, `Layout`, `LayoutHeader`, `LayoutContent`, `LayoutPanel`, `SideNav`, `MobileNav`, or `TopNav` as appropriate.
- Layout uses Astryx `VStack`, `HStack`, `Grid`, `Section`, and related structural components rather than layout-only `div` or `span` elements.
- Dense records use `List`/`Item`, `Table`, `TreeList`, or `MetadataList`; they are not wrapped in individual Cards.
- Cards are reserved for standalone widgets, media tiles, and independently actionable gallery entries.
- Status uses `StatusDot`, `Token`, `Banner`, `FieldStatus`, or `ProgressBar`. Badge is used for counts only.
- Forms use `FormLayout`, `Field`, `TextInput`, `NumberInput`, `CheckboxList`, `Switch`, and a Chromium-108-safe choice control.
- New component usage must be preceded by `npx astryx component <Name>` and follow its documented props.
- Project styling uses component props first and Astryx token variables second. Raw interior pixel spacing and hardcoded colors are prohibited.

## Browser and renderer strategy

### React migration

Astryx Core officially requires React 19 and React DOM 19. The television application currently uses Preact, so it will migrate to React instead of relying on the unsupported `preact/compat` alias.

The migration changes the rendering layer, JSX imports, test renderer configuration, and Vite plugin. It does not rewrite the television state machine, data fetching, playback pipeline, or remote navigation algorithms. Existing hooks and presentational components will be ported incrementally with behavior tests kept green.

### Chromium 108 compatibility

Chromium 108 is below Astryx Tier 2. Astryx guarantees only best-effort behavior there because its generated styles use `light-dark()`, and its layered controls may depend on native Popover and CSS anchor positioning.

Cloudframe will therefore define a deliberate compatibility profile:

1. The TV uses dark mode only.
2. A build-time compatibility transform emits a TV Astryx stylesheet in which every `light-dark(light, dark)` expression is resolved to its dark value.
3. The transform also resolves unsupported `color-mix()` declarations used by shipped TV components or supplies token-equivalent fallback declarations before them.
4. The TV does not use Astryx Tooltip, HoverCard, Popover, ContextMenu, DropdownMenu, Selector, MultiSelector, Tokenizer suggestions, anchored Carousel controls, or collapsed navigation flyouts.
5. Choice controls on TV use visible buttons, ButtonGroup, SegmentedControl only after a compatibility probe, or native controls with Astryx Field styling. The phone admin may use richer Astryx layers where its supported-browser contract permits them.
6. The TV source chooser remains a full-screen modal/drawer with the existing explicit focus manager. It is not implemented as an anchored Astryx popover.
7. Viewer controls remain an explicit overlay with existing capture-phase key handling. They do not depend on hover-only or popover behavior.
8. Core CSS used by the TV must pass a Chromium 108 parse and runtime probe. Unsupported declarations may be progressive enhancements only when a functional fallback is present.

Astryx's compiled theme package uses `@scope`, which Chromium 108 does not support. The TV will not rely on scoped theme CSS. The shared theme build will additionally emit an unscoped, application-root-prefixed token and component-override stylesheet for the TV. Admin may use the normal Astryx Theme provider and compiled theme output.

### Retiring the Chromium 68 UI lane

The Vite legacy target, CSS rejection rules, pinned browser harness, documentation, and tests will be retargeted from Chromium 68 to Chromium 108 for the application UI. The compatibility checker will continue to enforce compressed budgets and syntax parsing, but its unsupported-feature list will match Chromium 108 rather than reject broadly supported CSS such as `gap`, `aspect-ratio`, and `clamp`.

The classic Google media service worker remains deliberately conservative. Its authenticated `Range` forwarding, same-origin response reconstruction, no-`If-Range` rule, syntax checks, and size budget are independent of the visual target and remain intact unless a separate verified media change requires adjustment.

## Admin information architecture

The administrator remains one React state machine rather than becoming a client-side route hierarchy:

1. installation check;
2. first-run household claim;
3. administrator login;
4. authenticated application with Requests, Devices, Sources, and Settings sections.

### Frame

- Wide screens use `AppShell` with a persistent `SideNav` and a stable top context/action region.
- Narrow screens use `MobileNav`; the current sticky-header overlap is removed.
- Refresh, current section, pending request count, and global notices remain visible without covering content.
- The overview becomes a compact set of semantic sections and standalone summary widgets, not a decorative hero.

### Requests

Pending television requests render as a row collection. Each row exposes the device identity, request age/state, and direct Approve/Deny actions. Approval uses Astryx Dialog with device-name autofocus; denial and revocation use Astryx AlertDialog. All existing Escape, focus-trap, initial-focus, and opener-restoration contracts remain.

### Devices

Approved devices render as List/Item on mobile and may become Table rows at wide widths. StatusDot distinguishes enabled, disabled, active-access, and inactive legacy states. Editing uses FormLayout for name, enabled state, assigned roots, playback order, and slideshow timing. Revocation remains isolated and destructive.

### Sources

Source records render as rows with provider, account label, connection status, root count, and direct actions. Healthy, reauthentication-required, and disabled states remain distinct. Connecting Google Drive or OneDrive, reconnecting, browsing, and removal preserve their existing behavior.

### Source workbench

The live provider browser remains an in-layout work surface, not a dialog:

- desktop: `LayoutContent` provider browser plus a fixed `LayoutPanel` household-access rail;
- tablet: stacked regions with the active browser first;
- mobile: full-viewport sequential planes with stable close/back controls and no horizontal page leakage.

Breadcrumbs, folder rows, loading, pagination, errors, empty provider folders, selected roots, and removal impact use Astryx components. The existing abort-on-navigation, stale-result rejection, optimistic mutation, Escape close, trigger focus restoration, and minimum 44-by-44-pixel target contracts remain.

### Settings

Settings becomes a flat Astryx Settings Form composition. Playback defaults, installation/storage truth, transcoder diagnostics, passphrase rotation, and sign-out remain separate Sections. Diagnostics remain read-only and expose no internal identifiers. Passphrase rotation continues to invalidate administrator sessions. Container-owned padding preserves equal top and horizontal form alignment.

### Authentication and first run

Login and household claim use a centered Astryx Layout/FormLayout surface. They retain exact validation, passphrase visibility, pending, failure, `/data` backup, and installation ownership semantics without promotional content.

## Television information architecture

### Application states

Every current state receives an Astryx composition without being merged into a generic empty screen:

- opening/loading;
- device requests disabled;
- request form;
- waiting for approval;
- denied or expired request;
- offline;
- browser/runtime unsupported;
- no assigned roots;
- source unavailable;
- empty folder;
- healthy browse;
- pagination in progress or failed;
- viewer loading, playing, image display, failure, or transcode busy.

### Home and browse

- The TV opens on large approved collections with a quiet TopNav-style header and a source action.
- Root collections use a spacious Astryx media Card/ClickableCard grid.
- Folder contents use the existing VirtualGrid algorithm with Astryx card presentation.
- Each tile preserves deterministic IDs, focusability, thumbnail warming, and visibility behavior.
- Focus is unmistakable through the Cloudframe theme focus token, scale/elevation, and high-contrast outline, without changing layout order.
- Pagination status remains outside the grid's remote-navigation targets.

### Source drawer

The source chooser stays a full-screen or large side drawer suitable for directional navigation. It preserves modal background blocking, deterministic first focus, same-column movement, Back dismissal, and focus restoration. Reconfigure/manual controls remain excluded from automatic initial or replacement focus.

### Viewer

The viewer retains Cloudframe's existing media implementation:

- direct Google delivery through the authenticated service worker;
- direct temporary OneDrive URLs;
- server HLS for incompatible video;
- native/video.js/HLS fallback decisions;
- URL renewal;
- local browser-only history;
- overlay-first Back behavior;
- capture-phase directional and playback shortcuts;
- thumbnail and image error fallbacks.

Astryx supplies the surface composition, buttons, progress/status presentation, and visual overlay grammar. The existing Viewer reducer and VideoPlayer behavior remain the authority. Astryx Lightbox is reference material only and will not replace the product-specific player without proving parity.

## State and behavior preservation

The redesign must not alter these contracts:

- Admin snapshot bootstrap remains StrictMode-safe and performs exactly one effective initial request.
- Successful mutations update committed local state immediately, close task UI, then perform one background refresh.
- A failed refresh after a committed mutation produces a recovery warning without undoing the mutation.
- 401 responses return the administrator to login.
- Stale root-impact and folder responses cannot overwrite newer navigation or mutation state.
- Provider folder work aborts on navigation and unmount.
- Television session recovery, headers/cookies, pairing tokens, and server authorization stay unchanged.
- Provider-empty, provider-failed, reauthentication-required, disabled, revoked, storage-disabled, transcoder-busy, and unsupported playback remain distinct.
- Media credentials, provider URLs, sealed handles, internal IDs, and tokens never appear in user-facing copy or diagnostics.
- New UI must not proxy media, image, or thumbnail bytes through Vercel or introduce any hosted control plane.

## Testing strategy

### Test-driven migration

Behavior changes and renderer migrations follow red-green-refactor. Before replacing each surface, tests will describe the preserved public behavior and new Astryx structure. Presentation-only generated theme artifacts are verified by deterministic build tests rather than line-by-line unit tests.

### Automated gates

The completed redesign must pass:

- focused component tests during each migration slice;
- all Vitest suites;
- TypeScript checks for the root, Admin, and TV applications;
- ESLint;
- production Admin and TV builds;
- full self-hosted server build;
- Astryx integration doctor or equivalent import/theme verification;
- TV Chromium 108 JavaScript/CSS compatibility and compressed-budget checker;
- pinned Chromium 108 runtime probe for app startup, focus navigation, dialogs/drawer, image browse, direct media Range delivery, and viewer controls;
- Playwright desktop Admin, mobile Admin, and television-sized UI scenarios;
- production dependency audit with no high or critical findings.

### Visual verification

One batched inspection covers:

- Admin desktop;
- Admin phone width;
- TV at 1920 by 1080;
- the actual television browser when available.

The pass checks hierarchy, text clipping, layout overflow, minimum target size, visible focus, reduced motion, dialogs, empty/error states, source workbench behavior, gallery density, and player overlays. One batched correction and one confirmation round are the implementation ceiling before independent finish review.

### Real television acceptance

Synthetic Chromium 108 and Playwright checks do not constitute final television acceptance. `docs/operations/webos-acceptance.md` will be updated for webOS TV 24/Chromium 108 and executed against the exact candidate image. Until that checklist passes, the result is locally verified but not declared accepted on the television.

## Migration sequence

1. Add Astryx Core, Neutral theme, StyleX, and shared Cloudframe theme source/build tooling.
2. Add deterministic compatibility transforms and tests for Chromium 108 theme CSS.
3. Migrate the TV renderer from Preact to React while preserving current markup and behavior; prove parity before redesigning presentation.
4. Retarget the application compatibility lane from Chromium 68 to Chromium 108 while preserving the conservative media-worker checks.
5. Migrate Admin authentication and shell.
6. Migrate Admin Requests and Devices.
7. Migrate Admin Sources and the source workbench.
8. Migrate Admin Settings and diagnostics.
9. Migrate TV state panels, request/waiting flows, and header/drawer.
10. Migrate TV collection/folder/media cards and browse composition.
11. Migrate viewer presentation without replacing its media engine or reducer.
12. Remove unused Tailwind, local shadcn/Radix, Preact, and obsolete visual assets only after repository-wide usage checks and passing tests.
13. Run full automated, visual, independent review, documentation, and real-TV acceptance handoff.

## Failure handling and rollback boundaries

- The React renderer migration is an independent checkpoint. If Astryx cannot pass the Chromium 108 runtime probe after compatibility transforms, stop before broad UI migration and report the exact failing primitive.
- Admin and TV are migrated in testable slices; neither requires changing server contracts.
- The old CSS and wrapper components remain until their final consumers are migrated. Removal is the last step, not a prerequisite.
- The compatibility transform is deterministic and generated from installed Astryx CSS. It fails the build when it encounters an unresolved unsupported color expression rather than silently emitting unthemed television UI.
- Existing unrelated untracked Impeccable and Codex files are preserved.

## Completion criteria

The redesign is complete when:

- both apps render through React 19 and the shared Cloudframe Astryx theme;
- the Admin surface uses Astryx components and token styling throughout;
- the TV uses Astryx non-layered components with the explicit Chromium 108 profile;
- prohibited layout-only `div`/`span`, hardcoded visual values, Tailwind utility styling, and legacy UI wrappers are removed from migrated UI files;
- all operational states and interaction contracts remain covered and passing;
- automated and visual verification completes;
- the independent finish review is closed;
- `DESIGN.md` is regenerated from the shipped UI;
- the exact Docker candidate is ready for the documented real-TV acceptance pass.
