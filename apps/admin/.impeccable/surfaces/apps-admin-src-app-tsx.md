---
version: 1
slug: "apps-admin-src-app-tsx"
primary_target: "apps/admin/src/app.tsx"
related_targets: ["apps/admin/src/components/folder-picker.tsx","apps/admin/src/components/sources.tsx","apps/tv/src/app.tsx"]
---

# Cloudframe Admin and TV Replacement

## Scope and mode

- Mode: Operate.
- Primary target: `apps/admin/src/app.tsx`.
- Related targets: admin source/folder/access flows and the complete `apps/tv/` living-room surface.
- This is a replacement visual world, not a refinement of the current dashboard.

## Audience, job, and task

- A household administrator must connect cloud accounts, browse provider folders immediately, choose indexed roots, understand source/index health, approve TVs, and control folder access without interpreting infrastructure jargon.
- Family members must browse approved photos and videos on a remote-first LG webOS TV with minimal chrome and predictable focus.

## Product and functional constraints

- Folder selection browses Google Drive and OneDrive live; it must not depend on a completed metadata crawl.
- Only selected roots and their descendants are indexed.
- Provider-empty, index-not-started, indexing, quota-exhausted, provider-error, and healthy states are separate visible states with explicit recovery actions.
- Current authorization, cookie, encrypted-token, ancestry, read-only TV, and Chromium 68 boundaries remain intact.
- Firestore is currently free-tier and production has logged `RESOURCE_EXHAUSTED`; the UI must report that condition honestly, while implementation reduces write/read demand by indexing only selected roots.

## Chosen direction

**Screening Room Ledger** — a private screening program and projection-booth cue-sheet world.

- Matte projection black, warm program stock, one cue orange, and restrained metal/ash neutrals.
- Editorial grotesk for reading; condensed display lettering for titles and section names; tabular figures only for timestamps, counts, and indexing measurements.
- Admin composition: source/index truth at the top, live provider folder stage as the main work area, fixed television-access program alongside it, sync history and recovery beneath.
- TV composition: oversized approved collections and media; chrome recedes, focus is unmistakable, controls appear only when needed.
- Signature interaction: a folder moves from the live provider stage into the household program as a cue-marked selection; indexing status remains attached to that program entry.
- Motion grammar: stage-to-program movement and one-axis status reveals; reduced-motion falls back to immediate state changes.

## Raises kept from challengers

- Dark-first console: hairline state separation and isolated destructive actions.
- Mesophotic dive profile: indexing always names its exact stage, depth, failure, and recovery path.
- Cracktro queue: use depth and brightness before adding another container.

## What success looks like

- A first-time administrator can connect a source, see real provider folders, select a root, understand whether indexing is active or blocked, and approve TV access without guessing.
- “My Drive has no folders” is never shown when the provider contains folders but Cloudframe indexing is incomplete or failed.
- The admin and TV feel like one private household product rather than a generic SaaS dashboard plus a generic streaming clone.

## Unresolved external constraint

- Firestore billing remains disabled. The code can prevent unnecessary whole-drive indexing and expose quota recovery, but sustained indexing beyond free-tier limits still requires an approved billing account or reduced library size.
