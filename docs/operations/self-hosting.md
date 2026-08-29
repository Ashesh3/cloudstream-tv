# Self-hosting Cloudframe

## 1. Prerequisites

- Docker with Compose support on a host capable of running `linux/amd64` images.
- An HTTPS reverse proxy. Cloudframe listens on one internal HTTP port; do not expose it directly to televisions or administrators.
- Google and/or Microsoft OAuth applications for the read-only Google Drive and OneDrive source you enable.
- Storage for a persistent `/data` volume and explicit backups.

## 2. Build or select an image

Build locally without prescribing a registry:

```sh
docker build --platform linux/amd64 -t cloudframe:local .
```

Alternatively set `CLOUDFRAME_IMAGE` when using `compose.example.yaml` to an immutable image tag that you control.

## 3. Environment and provider callbacks

Copy `.env.example` to `.env`. `APP_ORIGIN` must be the exact public HTTPS origin, with no path, query, or trailing slash beyond the origin.

Provider callback URLs are:

```text
Google:    ${APP_ORIGIN}/api/admin/sources/google/callback
OneDrive:  ${APP_ORIGIN}/api/admin/sources/onedrive/callback
```

Configure both the client ID and client secret for a provider or omit both. `ONEDRIVE_TENANT` defaults to `common`. Do not put the admin passphrase or generated master key in the environment.

## 4. `/data` ownership and permissions

The container runs as UID/GID `10001`. The mounted directory must be writable by that identity. `/data` contains:

- `cloudframe.sqlite` and its WAL state;
- `secrets/master.key`;
- transactional schema backups;
- transcode catalog data;
- generated HLS segments under `transcodes/`; and
- temporary in-progress files under `staging/`.

Treat the complete directory as sensitive household data.

## 5. First boot and installation claim

Start the service and inspect its logs:

```sh
docker compose -f compose.example.yaml up -d
docker compose -f compose.example.yaml logs cloudframe
```

An empty `/data` produces one `CLOUDFRAME_SETUP_CODE=...` line. Open `${APP_ORIGIN}/admin/`, enter that code, and choose a passphrase of at least 16 characters. The code becomes unusable after the transactional claim commits.

## 6. Connect providers and pair a TV

In Admin, connect Google Drive and/or OneDrive, choose read-only folder roots, and leave new device requests enabled while pairing. Open `${APP_ORIGIN}/` on the television, name it, approve the pending request in Admin, and assign roots. Disable new requests afterward if desired.

## 7. Health and readiness

- `GET /healthz` reports process health.
- `GET /readyz` returns success only after local storage, static assets, working `ffmpeg` and `ffprobe` executables, the loopback source gateway, and runtime composition are ready. It returns unavailable while draining or after startup failure.

Use readiness for orchestration. Do not send public traffic until it succeeds.

## 8. One-TV / one-FFmpeg behavior

Cloudframe allows one active TV transcode lease and one FFmpeg job. Reopening the same item on the same approved device reuses that lease. A different live device requesting HLS receives `TRANSCODER_BUSY` with a bounded retry hint. Compatible direct photos and videos do not consume the lease.

## 9. Cache policy and eviction

- `TRANSCODE_CACHE_MAX_BYTES` caps cataloged HLS data.
- `TRANSCODE_CACHE_MIN_FREE_BYTES` reserves host free space.
- `TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS` bounds the first demanded segment.
- `TRANSCODE_THREADS` is `auto` or a positive integer.

Before committing a segment, Cloudframe checks both limits and evicts least-recently-used unpinned assets. Active, generating, and currently served assets are protected. If no safe candidate exists, playback fails with `TRANSCODER_CACHE_FULL`; the reserved free-space floor is not consumed.

At startup, Cloudframe removes abandoned staging files, verifies cataloged segment paths and sizes, deletes incomplete assets, and removes promoted files that never reached their SQLite commit. SHA-256 verification is deferred to segment use so readiness does not reread the complete cache; a missing or corrupt segment is invalidated and regenerated on demand instead of being served from stale metadata.

## 10. Explicit backup and restore

Back up the complete stopped `/data` volume. Do not copy only `cloudframe.sqlite`, because the master key and WAL-consistent state are required.

```sh
docker compose -f compose.example.yaml stop cloudframe
# Copy the complete cloudframe-data directory to protected storage.
docker compose -f compose.example.yaml start cloudframe
```

To restore, stop the container, move the current directory aside, restore the complete backup at the same mount, verify UID/GID permissions, and start the service. Confirm `/readyz`, Admin login, provider access, and TV enrollment before deleting the moved-aside copy.

## 11. Transactional schema upgrades

Startup applies ordered SQLite migrations in `BEGIN IMMEDIATE` transactions. Before upgrading an existing schema, Cloudframe writes an automatic local backup under `/data/backups` and retains the newest bounded set. A failed migration rolls back and readiness fails; it does not silently continue on a partial schema.

Automatic migration backups supplement but do not replace an operator backup of the complete stopped `/data` volume.

## 12. Graceful upgrade and rollback

1. Build or pull an immutable candidate image tag.
2. Create a stopped-volume backup.
3. Stop the old container cleanly.
4. Start the candidate against the same `/data` mount.
5. Wait for `/readyz`, then verify Admin and one direct-media item before testing HLS.
6. For rollback, stop the candidate and restore the pre-upgrade `/data` backup before starting the previous immutable image. Do not run an older binary against a database already migrated beyond its supported schema.

SIGTERM begins drain, stops accepting new HTTP work, waits for active responses, and only then stops transcode work, terminates FFmpeg/FFprobe and the loopback gateway, waits for tracked commits, checkpoints SQLite, and exits. If the bounded HTTP drain expires, active request signals and sockets are closed and shutdown proceeds rather than waiting indefinitely for a cancellation-ignoring operation.

## 13. Reverse-proxy requirements

- Preserve the public `Host` and HTTPS origin expected by `APP_ORIGIN`.
- Forward request and response bodies as streams; do not buffer complete HLS segments.
- Permit long-lived segment responses and configure upstream timeouts above the transcode first-segment and demanded-window bounds.
- Preserve `Set-Cookie`, `Cookie`, `Range`, `Content-Range`, and private/no-store cache headers.
- Do not rewrite `/api`, `/admin`, HLS playlist/segment paths, or the root-scoped media service worker.
- Redirect HTTP to HTTPS and use a certificate trusted by the television.

Cloudframe deliberately does not trust forwarded client-IP headers without a separately designed trusted-proxy boundary. A local reverse proxy may therefore share a conservative rate-limit bucket.

## 14. Logs and diagnostics

Logs are JSON records plus the one-time setup-code line. They contain stable route templates, status codes, safe error codes, counts, and timings. Normal logs and the Admin transcoder panel omit cookies, OAuth tokens, provider URLs, provider node IDs, internal capabilities, media bodies, and raw FFmpeg stderr.

Admin Settings polls the protected transcoder status while visible. It reports active item name/provider/device/stage, progress, queue/busy counts, cache usage, and a stable last error.

## 15. Replacement and uninstall

Replacing a container or image does not remove `/data`. A complete uninstall requires separately stopping/removing the container and intentionally deleting the exact persistent data directory after verifying its path and any required backup. Never use a broad Docker prune as Cloudframe cleanup.

## 16. External platform cleanup

This repository no longer contains an active Vercel, Blob, Firestore, Firebase, or GCP runtime. Deleting old external projects, data, DNS records, service identities, or credentials is manual and outside this repository run. Inventory and approve that cleanup separately; Cloudframe build, migration, or uninstall commands do not perform it.
