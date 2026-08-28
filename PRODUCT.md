# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- One household administrator who connects cloud accounts, approves televisions, assigns folder roots, and maintains household settings.
- Family members who browse approved photos and videos from a directional remote, primarily on LG webOS televisions.

## Product Purpose

Cloudframe is a private, single-household cloud-media browser. The administrator connects Google Drive and OneDrive and grants each approved television read-only access to selected folder roots. Family members can browse and view permitted media without seeing provider credentials, administration controls, or unapproved content.

## Current Product Model

- Google Drive and OneDrive folders and media metadata are listed live through Vercel; Cloudframe does not build or maintain a provider-file catalog.
- The encrypted private Vercel Blob snapshot is authoritative active control state. Vercel Runtime Cache is a five-minute hot copy and every protected request conditionally revalidates its Blob ETag.
- Firestore contains one compact write-only recovery mirror. Ordinary TV, admin, and provider traffic performs zero steady-state Firestore reads.
- Approved TVs receive signed, sealed sessions and opaque browse handles. Current device, root, and source authorization is revalidated before live provider operations.
- OneDrive media bytes go directly from Microsoft. Google Drive media is streamed through a same-origin authenticated Vercel route because Chromium 68 media elements cannot attach Google's required OAuth header.
- Google access tokens remain server-only. The Google route revalidates device/root/source authorization, forwards range requests, and never caches, persists, or transcodes media.
- Local TV watch history is stored in browser `localStorage`, capped at 500 entries, and removed when browser data is cleared. Playback continues without resume history when storage is unavailable.

## Operating Context

- The administrator signs in on a phone or general browser, connects providers, reviews enrollment requests, browses provider folders live, selects approved roots, and manages devices and defaults.
- A television requests access by name, waits for approval, and then presents only its currently assigned roots.
- Folder contents reflect the provider's current metadata when the TV or administrator opens them; there is no crawl, schedule, or manual refresh job.
- Control mutations commit to private Blob first, refresh Runtime Cache, and queue one full-document Firestore recovery write. A delayed mirror is visible as **Recovery copy delayed** without rolling back the committed change.
- If the active Blob is unavailable or corrupt, public requests fail closed until an operator performs explicit recovery from the one Firestore document.

## Capabilities and Constraints

- One household with multiple Google Drive and OneDrive accounts and multiple assignable roots.
- The TV app targets LG webOS 5+ and remains compatible with Chromium 68.
- The admin app is mobile-first and keyboard/screen-reader operable.
- Firestore browser rules deny direct access. The permanent runtime identity has exact write-only recovery permission and no read/list permission.
- Provider refresh tokens stay server-side and are encrypted at rest. Routine access-token refresh uses Runtime Cache and does not touch Firestore unless the provider rotates the refresh token.
- The active product has no provider-file catalog, workflow runtime, refresh schedule or button, server watch history, or Firestore request counters.
- Migration and restore are dry-run-first operator actions. Existing legacy documents and Google Cloud/Firebase projects remain untouched until a separately approved cleanup.

## Brand Commitments

- Product name: Cloudframe.
- Cloudframe is a private household library, not a public media service or enterprise content-management system.
- Privacy claims must remain factual: Cloudframe stores encrypted control data and local resume history, not household media files.

## Evidence on Hand

- Runtime and security behavior: `README.md` and `packages/server/`.
- Firebase, Vercel, migration, recovery, and observability: `docs/operations/firebase-vercel-setup.md`.
- LG webOS acceptance: `docs/operations/webos-acceptance.md`.
- Current admin and TV implementations: `apps/admin/` and `apps/tv/`.
- Synthetic end-to-end journeys and visual baselines: `e2e/`.

## Product Principles

1. Household privacy and least-privilege access are non-negotiable.
2. TV interactions must be obvious, remote-operable, and readable at a distance.
3. Administration must show device, source, root-access, and recovery-copy truth without invented operational states.
4. Provider-empty, provider-failed, storage-disabled, revoked, and recovery-delayed states must remain distinct.
5. Provider compatibility and reliable access take priority over decorative complexity.

## Accessibility & Inclusion

- Preserve keyboard and screen-reader operation throughout administration.
- Maintain visible focus, explicit labels, accessible status/error announcements, and touch-friendly controls.
- Keep TV focus order predictable; manual-only controls must not take initial or automatic remote focus.
- Respect reduced-motion preferences and maintain readable contrast and text sizing.
