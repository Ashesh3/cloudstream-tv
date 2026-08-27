# Cloudframe Screening Room Redesign

## Summary

Replace Cloudframe's current generic dashboard and folder modal with a unified **Screening Room Ledger** world across the mobile-first admin and remote-first TV apps. At the same time, repair the functional architecture that made Google Drive's populated **My Drive** appear empty: the admin folder browser will read provider folders live, while Cloudframe indexes only selected roots and exposes indexing/quota state explicitly.

## Root cause and scope

Production evidence shows the Google source's durable workflow failed with Firestore `RESOURCE_EXHAUSTED` after retries. Firestore is still free-tier with billing disabled. The existing folder picker reads only indexed metadata and maps an empty indexed child list to “No indexed folders are available,” so a failed or incomplete crawl looks identical to a genuinely empty provider folder.

The redesign therefore includes both:

1. a functional source-browsing and indexing repair; and
2. a complete replacement of admin and TV presentation.

It does not weaken authentication, provider-token encryption, server-only Firestore access, device/root authorization, or Chromium 68 compatibility.

## Product behavior

### Live provider folder browsing

- Add an authenticated admin endpoint that lists folders directly from Google Drive or OneDrive.
- The endpoint accepts a source ID, an optional provider folder ID, and an optional provider cursor.
- The server decrypts or refreshes credentials using the existing source service, then calls the provider adapter's bounded `listFolder` operation.
- The response includes a provider-root entry, current provider folder identity, folder children, and the next provider cursor.
- Provider media files are not returned in the selection browser; folder counts in this live view are not fabricated from incomplete metadata.
- Provider errors remain secret-safe and map to explicit retry, reconnect, or throttled states.

### Selected-root indexing

- Connecting a source stores the provider account and its provider root identity, but the provider root is not automatically enabled as a TV-assignable root.
- A source with no selected roots can be connected and browsed live without starting a full-drive crawl.
- Adding a root creates or re-enables the assigned-root document and starts an **initial** durable sync for that root.
- Removing a root removes it from devices immediately and future reconciliation makes metadata outside all enabled roots unavailable.
- Manual **Sync now** uses `initial` when the source has no completed index/delta cursor or has an unfinished initial checkpoint; otherwise it uses `delta`.
- Delta changes are retained only when the changed node belongs to an enabled root or its indexed ancestry. Whole-drive metadata must not reappear through delta sync.

### Index state contract

Expose one normalized source/index state to the admin UI:

- `unselected`: source connected; no folders chosen for indexing.
- `queued`: a root was selected and workflow launch is pending.
- `indexing`: initial crawl active, with processed count and pending folder count.
- `reconciling`: stale metadata is being marked unavailable.
- `healthy`: selected roots fully indexed; delta cursor established.
- `quota-exhausted`: Firestore returned `RESOURCE_EXHAUSTED`; explain billing/library-size recovery.
- `reauth-required`: provider authorization must be renewed.
- `provider-error`: provider call failed; show retry/reconnect according to code.

Provider-empty is a folder-browser result, never an index state. The message “This folder is empty” may appear only after a successful live provider response containing zero folders.

## Admin experience

### Global structure

- Replace the dashboard-card composition with a projection-booth ledger.
- A hairline-separated source/index truth strip remains visible above the current task.
- Primary navigation is compact and quiet; the current job occupies the visual stage.
- Destructive controls are isolated from routine actions.

### Source stage

- The Sources view presents each connected account as a reel with current provider and index truth.
- The primary action is **Browse & choose folders**, not “Manage folders.”
- The folder task is a full-height work surface on desktop and a full-screen route/sheet on mobile, not a cramped modal.
- The main stage browses provider folders live with breadcrumb navigation, pagination, provider-loading skeletons, and retry/reconnect states.
- A persistent **Household program** rail shows selected roots, index state, affected TVs, and remove actions.
- Selecting a folder moves it into the program with a cue-marked transition; reduced motion swaps state immediately.
- The interface never displays zero child/media counts unless those values are authoritative. Unknown counts use plain-language status instead.

### Device approval

- Approval focuses on device identity and the household program.
- Roots show provider, account, indexing readiness, and access impact.
- A root still indexing can be assigned, but the UI states that content will appear as indexing progresses.

### Other admin surfaces

- Requests, Devices, Settings, login, confirmation, loading, empty, and error states inherit the ledger world.
- The overview prioritizes actions needing attention, source/index health, and approved-device access rather than decorative metrics.

## TV experience

- Replace the generic dark media grid with a private screening-program composition.
- Approved roots are large program entries with real covers where available and typographic fallback where not.
- Focus is the brightest, most legible plane and never depends on hover.
- Navigation, source drawer, empty folders, viewer chrome, errors, and waiting/enrollment states use the same projection-black, program-stock, cue-orange language.
- Manual-only controls remain outside initial and automatic remote focus.
- TV code stays within Chromium 68 JavaScript/CSS constraints and existing compressed budgets.

## Visual direction contract

### Thesis

Cloud media is programmed like a private household screening: provider folders are available reels, selected roots are the program, and operational truth is written clearly in the margins. Refuse the generic SaaS dashboard and generic streaming clone.

### Own world

- Matte projection black, warm program stock, cue orange, and restrained ash/metal neutrals.
- Editorial grotesk for reading; condensed display lettering for titles; tabular figures only for time and index measurements.
- Hairline seams, cue marks, program strips, and selective depth. No nested-card wall, decorative blur, emoji icons, or fake film counts.

### Story

The administrator sees what is connected, browses the provider's actual folders, places chosen folders into the household program, and always knows whether indexing is queued, active, healthy, blocked, or failed. The family sees only that approved program on the TV.

### First viewport

Admin: a source/index truth strip at top; quiet navigation at left; the live provider folder stage occupying roughly two thirds; the household program rail occupying one third; sync history/recovery beneath. TV: one oversized current collection and a restrained row of approved programs, with focus dominating the room.

### Form

Screening Room Ledger, grounded direction 4, seed `b10bdc63`. Signature interaction: move a provider folder from the live stage into the program and attach its indexing status to the entry. Motion is one-axis stage-to-program movement and status reveal.

### Finish

unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Testing and verification

- Provider contract tests for live root/folder paging on Google Drive and OneDrive.
- Server API tests proving live browsing does not require indexed nodes.
- OAuth tests proving source connection no longer creates an enabled whole-drive root or launches full-drive indexing.
- Indexer tests proving selected-root crawl, root removal reconciliation, delta scope filtering, quota failure mapping, and resumability.
- Admin component tests for every index state and the distinction between provider-empty and incomplete/failed index.
- Playwright journeys for connection, live folder navigation, root selection, indexing state, approval, removal, desktop, and mobile.
- TV unit and E2E tests, Chromium 68 runtime execution, and compressed bundle budgets.
- Production verification requires a real provider folder listing and a completed selected-root sync. If Firestore free-tier remains exhausted, the UI must show `quota-exhausted`; a healthy full crawl cannot be claimed until billing or quota headroom exists.

## External constraint

The application can stop wasteful whole-drive indexing and make quota failure recoverable, but it cannot create Firestore capacity. The production project remains free-tier and billing-disabled; sustained indexing of the chosen library may still require an approved billing account or a deliberately smaller selected program.
