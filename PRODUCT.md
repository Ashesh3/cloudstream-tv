# Product

<!-- impeccable:product-schema 1 -->

## Platform

Self-hosted web application delivered as a portable Docker image.

## Users

- One household administrator who claims the installation, connects sources, approves televisions, assigns roots, and reviews transcoder/storage truth.
- Family members who browse approved photos and videos from a directional remote, primarily on LG webOS televisions.

## Product purpose

Cloudframe is a private, single-household cloud-media browser. It provides read-only Google Drive and OneDrive access to selected roots without exposing provider credentials or unapproved content to a television.

## Current product model

- Encrypted local SQLite under `/data` is the authoritative control state.
- The generated master key, database, automatic schema backups, and reusable transcode cache all live in `/data`; operators protect them with an explicit backup.
- Provider folders are browsed live. There is no crawl, indexing workflow, refresh schedule, or provider-file catalog.
- Compatible media uses browser-side authenticated direct delivery from Google or Microsoft.
- Incompatible video uses FFmpeg demand-paged HLS with browser-safe H.264/AAC output.
- One active TV transcode is permitted. A second television receives an explicit busy response without blocking compatible direct media.
- Cached compatible HLS segments may remain under `/data/transcodes` until cache eviction.
- Local TV watch history is browser-only and continues to be optional.

## Privacy and trust

- Provider refresh tokens are server-only and encrypted at rest.
- The approved TV may hold a short-lived Google access token in memory for exact direct requests. It is never persisted in URLs, cookies, browser storage, logs, diagnostics, or error copy.
- Transcoding moves provider media through the self-hosted server and stores generated segments locally. Cloudframe therefore does not claim that all media bytes always bypass the server.
- Root removal, device revocation, credential rotation, and source removal stop subsequent protected requests; already-vended provider capabilities retain their provider-defined lifetime.

## Capabilities and constraints

- One household; multiple approved devices, sources, and roots.
- LG webOS 5+ / Chromium 68 compatibility with native controls when the packaged Video.js skin cannot initialize.
- Real Video.js 10 skin on supported browsers, native HLS where available, and hls.js otherwise.
- Mobile-first, keyboard/screen-reader-operable administration.
- Graceful container shutdown, transactional SQLite upgrades, bounded transcode jobs, and cache free-space protection.
- No multi-tenant scheduler, multiple simultaneous encoders, client-side FFmpeg, or server-synchronized watch history.

## Product principles

1. Household privacy and least-privilege access are non-negotiable.
2. TV interactions remain obvious, remote-operable, and readable at a distance.
3. Admin shows current source, access, local-storage, and transcoder truth without invented states.
4. Provider-empty, provider-failed, storage-disabled, revoked, transcoder-busy, and unsupported playback remain distinct.
5. Compatibility and state integrity take priority over decorative complexity.

## Evidence

- Runtime and security: `packages/server/`, `Dockerfile`, and `README.md`.
- Operations: `docs/operations/self-hosting.md`.
- Real television acceptance: `docs/operations/webos-acceptance.md`.
- Synthetic acceptance: `e2e/`.
