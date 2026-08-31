---
name: Cloudframe Night
description: A quiet, dark Astryx interface for private household media administration and television browsing.
colors:
  body: "#0F1217"
  surface: "#181C22"
  card: "#171B21"
  muted: "#13171D"
  accent: "#62AFFF"
  accent-muted: "#17324F"
  text-primary: "#F4F1EA"
  text-secondary: "#AAB4C2"
  focus: "#8BC4FF"
typography:
  body:
    fontFamily: "Instrument Sans Variable, Segoe UI Variable, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
  heading:
    fontFamily: "Instrument Sans Variable, Segoe UI Variable, Segoe UI, sans-serif"
    fontSize: "1.125rem"
  scale:
    supporting: "0.75rem"
    body: "0.9375rem"
    heading: "1.125rem"
    title: "1.625rem"
    display: "3.625rem"
rounded:
  inner: "4px"
  element: "8px"
  container: "12px"
  page: "28px"
  full: "9999px"
---

# Cloudframe Night

Cloudframe uses one Astryx-based visual system across the household administrator and television applications. Graphite planes keep attention on private household media; warm-white content maintains long-distance legibility; cloud blue is reserved for focus, selection, and committed action. Success, warning, and error colors communicate real operational state only.

## Overview

**Creative North Star: "Cloudframe Night"**

Cloudframe is a calm, high-contrast household media interface. Graphite planes recede, warm-white content leads, and cloud blue marks focus, selection, and committed action without competing with the media.

**Key Characteristics:**

- One coherent dark system across administrator and television.
- Rows for dense administrative records; cards only for standalone widgets and media tiles.
- Live provider browsing and approved-root truth without indexing or quota fiction.
- Unmistakable television focus without changing remote navigation order.
- Product-specific media and focus engines remain authoritative.

### Product truth

- Cloudframe is a private, single-household cloud-media browser.
- Google Drive and OneDrive folders are browsed live; there is no crawl or indexing workflow.
- Only administrator-approved roots reach approved televisions.
- Control state is encrypted local SQLite under `/data` with explicit backup responsibility.
- Compatible media uses browser-side authenticated direct delivery; incompatible video may use demand-paged FFmpeg HLS with one active TV transcode.
- Local watch history stays browser-only.

## Colors

The shared `cloudframe-night` theme owns the palette. Application CSS consumes semantic Astryx tokens and never redefines `--color-*` values.

### Neutral planes

- **Graphite Body** (#0F1217): the page and television canvas.
- **Graphite Surface** (#181C22): primary working planes and state surfaces.
- **Media Card** (#171B21): standalone widgets and media tiles.
- **Warm White** (#F4F1EA): primary content.
- **Cool Secondary** (#AAB4C2): supporting content and metadata.

### Cloud accent

- **Cloud Blue** (#62AFFF): selection and committed action.
- **Cloud Blue Muted** (#17324F): selected or informative surfaces.
- **Focus Blue** (#8BC4FF): the visible focus outline.

## Typography

**Body Font:** Instrument Sans Variable (with Segoe UI Variable, Segoe UI, and system sans-serif fallbacks)

**Display Font:** Instrument Sans Variable (with Segoe UI Variable, Segoe UI, and system sans-serif fallbacks)

**Character:** Neutral and highly legible at phone, desktop, and living-room distances. Hierarchy comes from weight and spacing rather than decorative type.

### Hierarchy

- **Display** (Instrument Sans Variable, semibold): television state and collection headings.
- **Heading** (Instrument Sans Variable, semibold): page and section leads.
- **Body** (Instrument Sans Variable, regular): instructions and operational content.
- **Supporting** (Instrument Sans Variable, regular): metadata and secondary guidance.

## Layout

One outer frame owns every surface. Admin uses `AppShell` and one page `Layout`; television views keep explicit remote-navigation geometry inside Astryx structural primitives. Interior rhythm uses the Astryx spacing scale, while only frame and device geometry may use structural dimensions.

- Wide Admin uses persistent `SideNav`; phone and narrow-tablet Admin use `MobileNav`.
- Requests, devices, sources, provider folders, and selected household folders render as row collections.
- The source workbench is a two-plane desktop layout and sequential full-width mobile flow.
- TV collections and media use spacious fixed navigation geometry without changing deterministic IDs or order.

## Elevation

Elevation communicates focus or a temporary layer, never decoration. Resting interfaces remain predominantly flat.

- **Low shadow** (`0 1px 1px rgba(0, 0, 0, 0.20), 0 2px 8px rgba(0, 0, 0, 0.20)`): standalone widgets and media tiles.
- **High shadow** (`0 2px 2px rgba(0, 0, 0, 0.20), 0 8px 24px rgba(0, 0, 0, 0.30)`): focused TV cards and temporary layers.

## Shapes

Use moderate Astryx radii. Containers use the container radius, controls use the element radius, and pills are reserved for count, token, or progress affordances. The four-pixel focus outline remains outside component geometry so focus never reflows a grid.

## Components

### Admin Frame

`AppShell`, `Layout`, `SideNav`, and generated `MobileNav` provide one responsive frame for Requests, Devices, Sources, and Settings.

### Dense Record

`List` and `ListItem` render administrative records and live provider folders as rows with dividers. Do not wrap each row in a Card.

### Operational Status

`StatusDot`, `Token`, `Banner`, and `ProgressBar` communicate real source, access, mutation, and transcoder state. `Badge` communicates counts only.

### Source Workbench

The live provider browser stays in layout rather than becoming a dialog. It preserves abort-on-navigation, stale-result rejection, optimistic add/remove, impact confirmation, Escape close, and trigger-focus restoration.

### TV Collection Card

One native button remains the remote-navigation authority while Cloudframe Night tokens and Astryx structural primitives own presentation.

### TV Collection Drawer

The full-height chooser keeps deterministic first focus, directional movement, Back dismissal, modal background blocking, and exact focus restoration.

### Media Viewer

Cloudframe Night presentation surrounds the existing viewer reducer, direct-media bridge, HLS lifecycle, Video.js/native fallback hierarchy, and capture-phase remote controls.

## Do's and Don'ts

### Do

- Use household, collection, folder, source, television, local storage, playback, and transcoder language.
- Keep every operational state distinct and adjacent to the object it affects.
- Use component props first and semantic Astryx tokens second.
- Preserve visible focus, complete reduced-motion behavior, and one focus authority per TV surface.
- Keep provider credentials, URLs, sealed handles, tokens, internal IDs, and raw infrastructure errors private.

### Don't

- Do not use projection-booth, screening-room, program-stock, quota, or fabricated readiness language, and do not imply an indexing workflow exists.
- Do not add popover-dependent controls to the Chromium 108 television path.
- Do not turn dense records into card stacks or badges into status labels.
- Do not redefine the application palette outside the shared theme.
- Do not replace the product-specific media or remote-focus engines with decorative abstractions.

## Implementation notes

- Theme: `cloudframe-night`, extending Astryx Neutral.
- Typography: Instrument Sans Variable for body and headings, with system fallbacks.
- Geometry: moderate Astryx radii; cards are reserved for standalone widgets and media tiles.
- Focus: a high-contrast blue outline and lift that never changes navigation order.
- Motion: short, purposeful transitions with reduced-motion alternatives.
- Styling: component props first, semantic Astryx tokens second; no application-owned palette overrides.

### Administrator

- `AppShell`, `SideNav`, `MobileNav`, and one page `Layout` own the frame.
- Requests, devices, sources, provider folders, and selected household folders are dense row collections, not card stacks.
- Badge communicates counts only. Status uses StatusDot, Token, Banner, Field status, and ProgressBar.
- Settings is one ordered scroll surface: defaults, current household truth, transcoder diagnostics, passphrase rotation, and sign-out.
- Committed mutations update local state immediately, close task UI, and perform one background refresh. A failed refresh produces a recovery warning without undoing the mutation.

### Television

- The target is webOS TV 24 with Chromium 108 and a dark-only compatibility stylesheet.
- State screens are calm, centered household surfaces with remote-scale controls.
- Collection and media tiles keep one native button as the remote-navigation authority while using Cloudframe Night tokens and Astryx structural primitives.
- The source chooser remains an explicit modal drawer with deterministic first focus, directional movement, Back dismissal, and exact focus restoration.
- The viewer preserves the product-specific reducer, direct-media bridge, HLS lifecycle, capture-phase remote keys, and Video.js/native fallback hierarchy.
- Loading, provider failure, no roots, empty folder, pagination failure, viewer failure, and transcode-busy remain distinct.

### Language

Use household, collection, folder, source, television, local storage, playback, and transcoder. Do not use projection-booth, screening-room, program-stock, quota, or fabricated readiness language, and do not imply an indexing workflow exists.

### Accessibility and privacy

- Every interactive control has an accessible name and visible focus.
- Remote-only manual controls do not take automatic grid focus.
- Dialogs and drawers trap or explicitly manage focus and restore the opener.
- Provider credentials, URLs, sealed handles, tokens, internal IDs, and raw infrastructure errors never appear in user-facing copy.
