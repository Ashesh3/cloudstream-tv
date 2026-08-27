# Cloudframe

Cloudframe is a private household cloud-media browser built for televisions. The TV app is read-only and optimized for LG webOS 5+ (Chromium 68), while a separate mobile-first admin app controls enrollment, sources, roots, and household settings.

## What it does

- Connects Google Drive and OneDrive globally for one household without automatically indexing the whole drive.
- Browses provider folders live in the admin app through authenticated, no-store API responses, then indexes only the roots the administrator selects.
- Lets an administrator approve named TVs and assign specific selected roots.
- Browses the resulting indexed, folder-only TV library without provider round trips.
- Opens images and videos in one remote-controlled fullscreen viewer.
- Streams provider bytes directly to the browser; Vercel and Firebase never proxy media.
- Stores metadata, sessions, settings, roots, and watch history in Firestore.
- Uses secure rolling cookies only. The apps do not persist state in Web Storage, IndexedDB, Cache Storage, or service workers.

## Repository

```text
apps/tv/        Preact TV app and Chromium 68 legacy build
apps/admin/     React household admin app
packages/       Shared contracts, server domain, providers, indexer, TV core
api/            Same-origin Vercel Web API function
workflows/      Vercel Workflow entrypoints and durable steps
scripts/        Build, seed, migration, and compatibility tools
e2e/            Synthetic Playwright acceptance journeys and screenshots
```

## Local setup

Requirements: Node.js 22+ (Vercel currently uses Node 24), npm, Java 21+ for the Firestore emulator, and Firebase CLI.

```powershell
npm install
Copy-Item .env.example .env.local
firebase emulators:start --only firestore
npm run dev:tv
npm run dev:admin
```

Populate `.env.local` with development-only values. Never use a service-account key. For emulator work set `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`; for Vercel use OIDC Workload Identity Federation.

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

`build:vercel` assembles Build Output API v3 with both static SPAs, the API Web function, and transformed Workflow SDK flow/step/webhook functions. The exact generated workflow ID is injected into the API bundle from the manifest; it is never hand-maintained. `check:chromium68` caches official pinned Chromium snapshot revision `555668`, asserts the reported browser major is 68, executes the actual legacy TV entry through CDP, and verifies Promise, fetch, URL, and AbortController.

The E2E build enables synthetic APIs only when `CLOUDFRAME_E2E_BUILD=1`. Ordinary production builds replace the test injection branch with `false` and do not expose the hook.

## Development seed

`ADMIN_INITIAL_PASSPHRASE` must be a long, non-default value of at least 16 characters.

```powershell
node scripts/seed-dev.mjs --dry-run
node scripts/seed-dev.mjs
```

The seed is idempotent: it creates the household only when absent and verifies the supplied passphrase if the household already exists. The generated dev bootstrap passphrase is handed off outside git at `C:\Users\Ashesh\.cloudframe-tv-dev-bootstrap.txt`; sign in once, rotate it in **Settings**, then remove that local handoff file.

## Deployment

The checked-in Vercel cron is daily (`02:00 UTC`) because the current project is on Hobby. Manual **Sync now** remains available. The approved 15-minute reconciliation schedule requires Vercel Pro or an equivalent external scheduler.

Production cutover is blocked by `STAGING_BACKUP_RESTORE_PENDING`: Firestore scheduled backup and a full restore drill must be enabled and exercised in staging first. The current development project cannot complete that gate until an approved billing account is linked.

If a source reports **quota exhausted**, Cloudframe pauses indexing without hiding the failure. Reduce the selected library or obtain Firestore billing/quota headroom, then use **Sync now** to resume. The application limits indexing to selected roots, but it cannot enable billing or create Firestore capacity.

Detailed Firebase, WIF, OAuth, deployment, migration, rollback, and observability procedures are in [docs/operations/firebase-vercel-setup.md](docs/operations/firebase-vercel-setup.md). Real LG webOS acceptance is in [docs/operations/webos-acceptance.md](docs/operations/webos-acceptance.md).

## Security boundaries

- Firestore browser rules deny all reads and writes.
- Only the server talks to Firestore and provider APIs.
- Provider refresh/access tokens are AES-256-GCM encrypted at rest.
- Temporary provider URLs are no-store/no-referrer and never persisted or logged.
- TV authorization revalidates the session, device, assigned root, source, and current ancestry on every browse/media request.
- Vercel OIDC impersonates a dedicated least-privilege Google service account; no user-managed keys exist.
- Workflow SDK 4.8.5 is exact-pinned. Its stable 4.x runtime cannot safely use queue namespaces, so `WORKFLOW_QUEUE_NAMESPACE` must remain absent and the default `__wkf_*` topics are contract-tested.

## Migration

The legacy Vercel Blob migration is dry-run by default:

```powershell
node scripts/migrate-vercel-blob.mjs
node scripts/migrate-vercel-blob.mjs --apply
```

It reads legacy aggregate and split records, honors tombstones, prefers split token records, redacts all values, and never migrates browser sessions. Legacy sources have no verifiable stable provider account ID, so they are intentionally imported as `reauth-required` with disabled roots until a verified reconnect.

Older installations may also contain an enabled whole-drive root. Migrate it without interrupting televisions: reconnect the source if required, choose the desired replacement roots, and run **Sync now** if indexing does not start automatically. Reassign every affected TV to the selected roots and confirm content is available before removing the legacy whole-drive root.
