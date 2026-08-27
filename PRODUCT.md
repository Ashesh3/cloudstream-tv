# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- A single household administrator who connects cloud accounts, approves televisions, assigns folder access, and maintains the household library.
- Family members who browse and view approved photos and videos primarily on LG webOS televisions.

## Product Purpose

Cloudframe is a private, single-household cloud-media system. It lets one administrator connect Google Drive and OneDrive, approve named televisions, and grant each TV read-only access to selected folders. Success means a family member can use a remote control to find and view permitted household media without seeing provider credentials, administration controls, or unapproved content.

## Positioning

Cloudframe separates a mobile-first household administration surface from a remote-first television experience. It builds a server-managed folder index for fast browsing, revalidates device and folder authorization on every request, and streams provider media directly rather than copying household media into Cloudframe infrastructure.

## Operating Context

- The administrator signs in on a phone or general browser, connects cloud providers, reviews device requests, chooses assignable folder roots, and manages devices, sources, and household defaults.
- A television requests access by name, waits for approval, and then presents only assigned roots and their indexed descendants.
- The television experience is read-only and designed for a directional remote, fullscreen viewing, and living-room viewing distances.
- Important cloud changes may require an explicit sync before newly indexed folders or media appear.

## Capabilities and Constraints

- One household with global Google Drive and OneDrive connections.
- Multiple provider accounts and multiple assignable roots are supported.
- Approved televisions receive granular root assignments and cannot browse outside current authorized ancestry.
- The TV app targets LG webOS 5+ and must remain compatible with Chromium 68.
- The admin app is mobile-first but must also work well on desktop browsers.
- Firestore is server-only; browser rules deny direct access.
- Provider tokens are encrypted at rest and media bytes are not proxied through Vercel or Firebase.
- Authentication uses secure rolling cookies. The apps do not persist state in Web Storage, IndexedDB, Cache Storage, or service workers.
- Administrators browse provider folders live; only selected roots and their descendants are indexed. The interface must distinguish an empty provider folder from index state.

## Brand Commitments

- Product name: Cloudframe.
- The product is a private household library, not a public media service or enterprise content-management system.
- Security and privacy claims must remain factual and must not imply that Cloudframe stores the household's media files.

## Evidence on Hand

- Product and security behavior: `README.md`.
- Firebase, OAuth, deployment, and operational constraints: `docs/operations/firebase-vercel-setup.md`.
- LG webOS acceptance requirements: `docs/operations/webos-acceptance.md`.
- Current admin and TV implementations: `apps/admin/` and `apps/tv/`.
- Synthetic end-to-end journeys and visual baselines: `e2e/`.
- No testimonials, customer metrics, or external product claims are available and none should be fabricated.

## Product Principles

1. Household privacy and least-privilege access are non-negotiable.
2. TV interactions must be obvious, remote-operable, and readable at a distance.
3. Administration should make device, source, indexing, and folder-access state immediately understandable.
4. Empty, loading, stale, incomplete, and failed states must never be visually conflated.
5. Provider compatibility and reliable access take priority over decorative complexity.

## Accessibility & Inclusion

- Preserve keyboard and screen-reader operation throughout the admin app.
- Maintain visible focus, explicit labels, accessible status/error announcements, and touch-friendly admin controls.
- TV focus order must remain predictable, and manual-only controls must not steal initial or automatic remote focus.
- Respect reduced-motion preferences and maintain readable contrast and text sizing.
