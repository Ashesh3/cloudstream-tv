# Cloudframe

Cloudframe is a private household cloud-media browser for televisions. The TV app is read-only and optimized for LG webOS 5+ (Chromium 68); a separate mobile-first admin app controls enrollment, provider sources, approved roots, devices, and household settings.

## What it does

- Lists live Google Drive and OneDrive metadata through authenticated, no-store Vercel API responses.
- Lets the administrator select folder roots and assign them to named, approved TVs.
- Revalidates current device, root, source, and browse-handle authorization on every protected request.
- Sends OneDrive media directly from Microsoft and streams Google Drive media through an authenticated, no-store Vercel route that forwards range requests.
- Stores authoritative active control state as an encrypted private Vercel Blob snapshot.
- Uses Vercel Runtime Cache as a five-minute hot copy with Blob ETag revalidation on every protected request.
- Writes one compact Firestore recovery mirror after control mutations, while ordinary TV, admin, and provider traffic causes zero steady-state Firestore reads.
- Keeps local TV watch history in browser `localStorage`, capped at 500 entries. It clears with browser data and is disabled for the session if storage is unavailable.

This is live Google Drive and OneDrive metadata. Cloudframe stores no provider media catalog or media bodies; only Google playback transits Vercel because Drive requires an OAuth header that TV media elements cannot attach. There is no workflow runtime, refresh schedule/button, server watch history, or Firestore-backed rate counter in the active application.

## Repository

```text
apps/tv/        Preact TV app and Chromium 68 legacy build
apps/admin/     React household admin app
packages/       Shared contracts, server control plane, providers, and TV core
api/            Same-origin Vercel Web API function
scripts/        Build, seed, migration, recovery, and compatibility tools
e2e/            Synthetic Playwright acceptance journeys and screenshots
docs/operations Operations and real-TV acceptance runbooks
```

## Local setup

Requirements: Node.js 22+ (the Vercel build targets Node 24), npm, Java 21+ for the Firestore emulator, and Firebase CLI.

```powershell
npm install
Copy-Item .env.example .env.local
firebase emulators:start --only firestore
npm run dev:tv
npm run dev:admin
```

Populate `.env.local` with development-only values. Never commit secrets or use a user-managed service-account key for the Vercel runtime. For emulator work set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`; deployed Vercel functions use OIDC Workload Identity Federation.

## Build and test

```powershell
npm test
npm run typecheck
npm run lint
npm run build
node scripts/check-tv-bundle.mjs
npm run check:chromium68
npm run build:vercel
npx playwright test
```

`build:vercel` assembles Build Output API v3 with both static SPAs and exactly one API Web function in `bom1`. It performs a clean production rebuild before packaging, so stale E2E hooks or source maps cannot be reused. `check:chromium68` uses pinned Chromium snapshot revision `555668`, verifies browser major 68, runs the actual legacy TV entry through CDP, and checks required platform APIs.

Synthetic APIs and source maps are enabled only by `npm run build:e2e`. Do not use that build output as a deployment artifact.

## Development seed

`ADMIN_INITIAL_PASSPHRASE` must be a non-default value of at least 16 characters.

```powershell
node scripts/seed-dev.mjs --dry-run
node scripts/seed-dev.mjs
```

The seed creates the household only when absent and verifies the supplied passphrase for an existing household. Keep any bootstrap-passphrase handoff outside git, sign in once, rotate it in **Settings**, and remove the handoff file.

## Active control and recovery

The private Vercel Blob at `cloudframe/control-plane/{environment}/{householdId}.json.enc` is authoritative. It is encrypted with AES-256-GCM. Runtime Cache is transient and is never trusted without conditional Blob revalidation.

Firestore stores only `controlPlaneBackups/{householdId}` as a compact recovery copy. Normal requests never fall back to Firestore. A control mutation commits to Blob, refreshes cache, and queues a full-document write through `waitUntil()`. If that write is delayed, the active mutation remains committed and the admin reports **Recovery copy delayed**.

Migration and explicit recovery are dry-run-first:

```powershell
node --experimental-strip-types scripts/migrate-vercel-control-plane.ts
node --experimental-strip-types scripts/migrate-vercel-control-plane.ts --apply
node --experimental-strip-types scripts/restore-vercel-control-plane.ts
node --experimental-strip-types scripts/restore-vercel-control-plane.ts --apply
```

The migration reads only legacy household, request, device, source, and root records needed for the compact snapshot. Restore reads exactly one recovery document. Both commands emit only redacted counts, revision, and checksum. They require a separate operator credential file and must not use either runtime service account.

## Direct media security boundary

Provider refresh tokens and access tokens remain encrypted/server-only. Vercel obtains or refreshes access tokens to list metadata and authorize media.

Google playback uses a same-origin URL containing only the sealed, device-bound browse handle. Vercel revalidates the current device/root/source on every request, attaches `Authorization: Bearer` server-side, forwards range requests, and streams the response without caching or persistence. Revocation or root removal therefore blocks the next Google request, and the Google access token is never exposed to the TV URL.

OneDrive uses its temporary provider download URL and has the same direct-byte path without exposing the stored refresh token.

## Firestore identities after cutover

- The permanent runtime writer has only `datastore.entities.create` and `datastore.entities.update`, scoped to the exact recovery document where supported. It has no get/list permission.
- Migration and restore use a separate operator identity with temporary read/write access.
- The temporary legacy-cookie reader and compatibility exchange have been removed. Existing sealed version-2 sessions continue normally; an old legacy cookie is rejected and cleared by the final authentication path.

No migration, deployment, rollback, or recovery command deletes legacy Firestore documents or a Google Cloud/Firebase project. Any cleanup requires separate approval, an exact inventory, and a dry run.

Detailed setup, permissions, key rotation, deployment, migration, recovery, rollback, and observability procedures are in [docs/operations/firebase-vercel-setup.md](docs/operations/firebase-vercel-setup.md). Real LG webOS acceptance is in [docs/operations/webos-acceptance.md](docs/operations/webos-acceptance.md).
