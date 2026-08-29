---
name: Cloudframe Screening Room Ledger
description: A private household media system staged as a projection-booth program and ledger.
colors:
  admin-projection: "#101112"
  tv-projection: "#070705"
  projection-deep: "#030302"
  program-stock: "#d9ccb2"
  program-stock-bright: "#f0e3c8"
  program-stock-dim: "#988d79"
  cue: "#ed6b2c"
  cue-bright: "#ff8a45"
  metal: "#45423b"
  metal-soft: "#292823"
  hairline: "rgba(224, 211, 185, .22)"
  danger: "#f08b72"
typography:
  display:
    fontFamily: "Cloudframe Condensed, Archivo Narrow Variable, Arial Narrow, sans-serif"
    fontSize: "clamp(3.5rem, 7vw, 6rem)"
    fontWeight: 650
    lineHeight: 0.86
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Cloudframe Sans, Instrument Sans Variable, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Cloudframe Sans, Instrument Sans Variable, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0.08em"
rounded:
  square: "0"
  admin-control: "0.125rem"
  admin-panel: "0.25rem"
  tv-card: "13px"
spacing:
  admin-control-height: "44px"
  tv-control-height: "58px"
  admin-gutter: "1rem"
  tv-safe-x: "54px"
  tv-safe-y: "36px"
  tv-grid-gap: "20px"
components:
  button-primary:
    backgroundColor: "{colors.cue}"
    textColor: "{colors.projection-deep}"
    rounded: "{rounded.square}"
    padding: "0 30px"
    height: "{spacing.tv-control-height}"
  button-secondary:
    backgroundColor: "{colors.tv-projection}"
    textColor: "{colors.program-stock}"
    rounded: "{rounded.square}"
    padding: "0 14px"
    height: "42px"
  input-program:
    backgroundColor: "{colors.program-stock-bright}"
    textColor: "{colors.projection-deep}"
    rounded: "{rounded.square}"
    padding: "0 18px"
    height: "{spacing.tv-control-height}"
  card-tv:
    backgroundColor: "{colors.metal-soft}"
    textColor: "{colors.program-stock}"
    rounded: "{rounded.tv-card}"
    padding: "0"
    height: "178px"
---

## Overview

**Creative North Star: "Screening Room Ledger."** Cloudframe programs household media like a private screening, not a generic SaaS dashboard. Projection black carries the room; warm program stock carries the household's approved selection; a single cue orange marks action, motion, and attention. The result should feel like a precise projection-booth cue sheet that still makes live-source, access, and recovery truth easy to read.

The visual story follows the runtime truth: private Vercel Blob is the active control ledger, Firestore is an explicit recovery copy only, live Google Drive and OneDrive metadata supplies the program, browser-side authenticated direct delivery sends media bytes directly from both providers, and local TV watch history never appears as a server-side admin fact. The approved TV holds a short-lived Google bearer token only in memory while its root-scoped service worker forwards exact raw or filename-alias requests; the interface must never imply that Vercel streams, caches, remuxes, or transcodes provider media.

The admin surface keeps the visible source truth above quiet navigation, then places the live provider stage beside the household program so a folder's move into the program remains legible. The TV surface enlarges the same hierarchy for a remote and viewing distance: collection first, program status attached, chrome only when it serves the moment. The locally generated program-stock raster supplies paper fiber, registration marks, perforation dots, and sparse cue geometry without becoming a decorative background.

**Key Characteristics:**

- Projection black and warm stock create the two dominant planes.
- Cue orange is reserved for a decision, active state, progress, or focus.
- Hairline seams and ledger type describe state before another container does.
- Truth stays attached to its source, program entry, collection, or recovery path.
- Admin and television use one world at their own scale rather than mimicking each other.

## Colors

The palette is a restrained projection booth: almost-black room, tactile stock, ash and metal neutrals, and one warm cue signal.

### Primary

- **Cue Orange:** Marks primary action, selected movement into the household program, provider loading, progress, and the few structural registration details that need attention.

### Secondary

- **Program Stock:** Carries the selected household program, enrollment panels, source-workbench planes, and other moments where household material should come forward from the dark room.
- **Bright Stock:** Keeps display type and focused media legible against the projection field.

### Tertiary

- **Metal and Ash:** Separate inactive media, structural tracks, and secondary facts without competing with the cue.
- **Danger Coral:** Identifies blocked, exhausted, failed, and destructive states truthfully.

### Neutral

- **Admin Projection and TV Projection:** Ground the respective operating and living-room surfaces in near black.
- **Projection Deep:** Holds fullscreen viewing and the deepest receding plane.
- **Hairline:** Divides ledger rows, frames, and panels with an optical seam instead of heavy boxing.

### Named Rules

**The Single Cue Rule.** Cue orange carries a reason to act or orient; it is not a general decoration or a competing surface color.

**The Stock Means Selected Rule.** Warm stock signals the household program, a recovery panel, or a deliberate reading surface—not an arbitrary card fill.

## Typography

**Display Font:** Cloudframe Condensed / Archivo Narrow Variable (with Arial Narrow fallback)

**Body Font:** Cloudframe Sans / Instrument Sans Variable (with Segoe UI fallback)

**Character:** Condensed all-caps headings give the program its printed, cinematic authority; the sans remains calm and direct for source names, recovery language, and long-running household administration. Counts, timestamps, and status measures use tabular figures.

### Hierarchy

- **Display:** Uppercase, tightly led ledger titles, projection titles, state panels, and collection names.
- **Headline:** Large condensed program language that can hold the screen without adding visual noise.
- **Title:** Condensed section labels for rows, drawers, and cards where the item name is the primary read.
- **Body:** Plain sans explanation for provider state, root access, recovery direction, and form help.
- **Label:** Compact uppercase sans with tracking for rails, counts, and structural annotations.

### Named Rules

**The Ledger Read Rule.** Use the condensed face for what the room is screening; use the sans for what the household needs to understand and act on.

## Layout

Admin is a two-plane operating composition. Source connection and recovery-copy truth stay visible at the top; the source workbench then gives roughly two-thirds of its stage to live provider folders and one-third to the household program. The program is the consequence of browsing, not a disconnected settings list. Hairline seams, shared edges, and a short taskbar create the ledger without a stack of floating cards.

At narrower admin widths, the truth strip, figures, source planes, device ledger, and settings grid collapse to one readable sequence. The active source-health strip remains near the work without obscuring its contents. Standard admin controls maintain the touch-ready control height.

TV is laid out for the living room: safe inset gutters frame an oversized program projection, collection rows use generous gaps and remote-scale cards, and focus lifts one item without rearranging the row. The projection favors a broad visual field with a smaller program ledger alongside it; short screens reduce the stage and type together, while the largest displays expand safe insets and program scale.

## Elevation & Depth

Depth comes primarily from tonal planes, stock-versus-projection contrast, image opacity, and hairline registration frames. The admin ledger stays largely flat; its one deliberate lift is the cue-backed primary action. Television cards and drawers use deeper shadows because focus, remote movement, and fullscreen overlays need a clear foreground plane. Motion is short and one-axis: selected program rows cue in from the side, focused cards scale slightly, and video controls rise into view. Reduced-motion mode resolves these state changes immediately.

### Shadow Vocabulary

- **Cue action lift:** A restrained warm shadow under the primary admin action.
- **Focused TV card:** A deep black lift plus cue-colored focus halo makes the remote target unmistakable.
- **Drawer and modal lift:** Dense projection shadow separates temporary access and recovery surfaces from the current program.

### Named Rules

**The Plane Before Panel Rule.** Establish hierarchy with brightness, material, and depth before introducing another boxed container.

## Shapes

The system is square by default: ledger entries, inputs, controls, badges where practical, cue frames, and program rails rely on straight edges and hairlines. Admin panels may use only the small control and panel rounding already in the system; TV media cards are the intentional exception, with a restrained soft corner that helps remote focus read as a discrete target. Recurring geometry is functional—corner crops, crosshairs, registration frames, and rotated cue diamonds—never free-floating ornament.

## Components

### Buttons

- **Character:** Direct cue marks for committed actions; quiet outlined controls for navigation and secondary tasks.
- **Primary:** Cue orange fills the action while deep projection text keeps it crisp. TV enrollment and recovery actions use the taller remote-scale version; admin controls retain the compact touch-ready version.
- **Secondary / Ghost:** Projection or transparent backgrounds, stock text, and hairline borders let the primary cue remain rare.
- **Hover / Focus:** Keep the silhouette stable; visible focus uses the bright cue ring and a clear offset. Disabled actions dim without hiding their label.

### Cards / Containers

- **Character:** Shared-edge ledger rows in administration; discrete metal cards for television collections.
- **Admin:** Use hairline seams, flat dark panels, and zero-to-small rounding. The source workbench is a framed live stage rather than a conventional dashboard card.
- **TV:** Use the TV-card shape, subdued opacity at rest, and a bright cue focus treatment that adds depth without changing navigation order.

### Inputs / Fields

- **Character:** Warm stock reading surfaces on television, dark projection fields in administration.
- **Focus:** Bright cue focus remains exterior to the field, preserving the field's simple rectangular form.
- **Error / Disabled:** Failure copy and blocked state use the danger role; disabled controls recede but remain readable.

### Navigation

- **Admin:** Navigation is quiet and structural so source truth, live browsing, and the household program lead the page.
- **TV:** The compact header carries brand, breadcrumb, and source access; the source drawer switches to stock for a readable alternate plane. Remote focus, rather than persistent controls, signals the current action.

### Source Workbench

**Character:** A live provider stage and a fixed household program on one continuous ledger. Provider folders are browsed live on the dark stage; selected roots enter the stock program plane with their access state and television impact still attached. The header's horizontal rule, rotated cue diamond, and program count make the movement directional without simulating a dashboard job system.

### Program Projection

**Character:** The TV's oversized first read. Collection imagery or stock art fills the projection field while the adjacent program ledger names availability, count, and recovery. Ready, loading, provider-failed, storage-disabled, and revoked states remain visibly distinct; loading uses a pulsing cue, while blocked uses danger rather than a falsely empty collection.

## Do's and Don'ts

### Do:

- **Do** keep provider, root-access, and recovery-copy truth adjacent to the source or household program entry it describes.
- **Do** use the real program-stock material only as a purposeful selected or reading plane, with its cue geometry quiet enough for the information to lead.
- **Do** preserve the admin relationship of visible source truth, live provider stage, and household program.
- **Do** preserve television-scale type, safe insets, and an unmistakable focused card for remote operation.
- **Do** use reduced-motion fallbacks for all cue, focus, drawer, and status movement.

### Don't:

- **Don't** collapse provider-loading, provider-empty, provider-failed, storage-disabled, revoked, and healthy states into one generic empty presentation.
- **Don't** spend cue orange on inactive decoration, broad backgrounds, or multiple competing actions.
- **Don't** replace the program relationship with generic SaaS metrics, floating dashboard cards, or an unrelated streaming clone.
- **Don't** allow manual-only TV controls to take initial or automatic remote focus.
