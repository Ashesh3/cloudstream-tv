# Cloudframe

Cloudframe is a private, single-household media browser for televisions. It ships as a portable Docker image that serves the TV app, admin app, API, and demand-paged HLS from one origin. Control state is stored in encrypted local SQLite under `/data`.

## Runtime model

- Read-only Google Drive and OneDrive metadata is listed live; Cloudframe does not maintain a provider-file catalog.
- Compatible photos and videos use browser-side authenticated direct delivery. OneDrive uses its validated signed URL; Google uses an exact Drive URL plus an in-memory bearer grant in the TV service worker.
- Incompatible video such as legacy MPEG is read server-side through a loopback capability and converted by FFmpeg to H.264/AAC demand-paged HLS.
- Exactly one active TV transcode owns the encoder lease. Other HLS requests receive a bounded busy response; direct media remains available.
- Reusable transcoded segments may be cached under `/data/transcodes` within the configured size and free-space floors.
- Local TV watch history stays in browser `localStorage`, capped at 500 entries. It is not synchronized to the server or shown in Admin.

## Quick start

Requirements: Docker with Compose, an HTTPS reverse proxy, and OAuth applications for the providers you enable.

```powershell
npm run docker:build
Copy-Item .env.example .env
docker compose -f compose.example.yaml up -d
docker compose -f compose.example.yaml logs cloudframe
```

Set `APP_ORIGIN` to the exact public HTTPS origin. On first boot, copy the one-time `CLOUDFRAME_SETUP_CODE` from the container logs, open `/admin/`, claim the installation, and choose the administrator passphrase. The passphrase and generated master key are never environment variables.

The example Compose file binds only `127.0.0.1:8080`; publish it through an HTTPS reverse proxy. Persist the complete `/data` mount and give the container user UID/GID `10001` read/write access.

See [self-hosting operations](docs/operations/self-hosting.md) for provider callback URLs, reverse-proxy requirements, explicit backup/restore, upgrades, cache policy, diagnostics, and uninstall behavior.

## Build and verify

```powershell
npm install
npm test
npm run typecheck
npm run lint
npm run build:server
node scripts/check-tv-bundle.mjs
npm run check:chromium108
npx playwright test
npm run docker:build
npm run test:container
```

`build/self-hosted` contains one bundled server entry and the production public tree. Synthetic browser APIs and source maps exist only in `npm run build:e2e` output and must not be deployed.

The real container smoke build is compile-time gated. Ordinary production builds contain no fixture route, fixture adapter, test marker, or media fixture.

## Repository

```text
apps/tv/        React TV app for webOS TV 24 / Chromium 108
apps/admin/     React household admin app
packages/       Shared contracts, server runtime, providers, and TV core
deploy/         Self-hosted Node server entry
scripts/        Build, container-smoke, and compatibility tools
e2e/            Synthetic Playwright acceptance journeys and screenshots
docs/operations Self-hosting and real-TV runbooks
```

## Security boundary

Provider refresh tokens and the control document are encrypted at rest with keys derived from the generated `/data/secrets/master.key`. Approved devices use sealed cookies and opaque browse handles. Every protected request revalidates the current device, source, root, revision, and credential version.

Bearer tokens, provider download capabilities, internal source-gateway capabilities, session IDs, and FFmpeg stderr are not exposed by Admin diagnostics or normal logs. Back up `/data` explicitly while the container is stopped; a container or image is replaceable, but `/data` is the durable household state.
