# Self-Hosted Cloudframe Transcoding Server Design

## Status

Approved architecture. This specification replaces Cloudframe's active Vercel runtime with a portable, single-container server and adds on-demand transcoding for media that the television cannot decode natively.

Implementation starts only after the user reviews this committed specification. Existing Vercel, Firebase, DNS, and hosting resources are not deleted by this work.

## Goal

Run Cloudframe as a long-lived Docker service on a host chosen by the operator. The service must:

- serve the TV application, admin application, API, and transcoded media from one origin;
- preserve read-only Google Drive and OneDrive browsing;
- use the actual Video.js 10 beta skin for supported browsers;
- play compatible provider media directly when possible;
- transcode incompatible video on demand to browser-safe HLS;
- optimize CPU scheduling for exactly one active transcoding television;
- persist application state and reusable transcode output under `/data`;
- start as a fresh installation with no Vercel control-plane import; and
- remain portable, with no Horizon, Nginx, Cloudflare, certificate, DNS, or other host-specific configuration in the image.

## Established facts

- The current production application is split into static TV/admin builds and a Web `Request`/`Response` API bundled as one Vercel function.
- The reusable server services already sit behind a platform-neutral `createControlApiApp` request handler.
- The active control plane currently depends on private Vercel Blob, Vercel Runtime Cache, a Firestore recovery mirror, and Vercel OIDC.
- Google and OneDrive OAuth scopes are read-only. The self-hosted design must not require permission to upload converted files beside originals.
- The live Video.js integration registers `video-player` and `media-container`, but deliberately omits the packaged Video.js skin. The visible controls are Cloudframe's custom overlay.
- A compatible H.264 MP4 loads and plays in the live browser. The reported `.MPG` files arrive successfully but fail decoding.
- The target Chromium runtime reports no `video/mpeg` support. A player library cannot add an MPEG decoder without a media engine or transcoder.
- The repository uses Node.js 24, whose runtime includes SQLite support.
- A CPU-only host with approximately four modern vCPUs is sufficient for the intended one-viewer profile. The image must not assume that exact host or require a GPU.

## Non-goals

- Multiple simultaneous transcodes or a multi-tenant scheduler.
- An adaptive multi-rendition encoding ladder.
- Uploading, renaming, replacing, or deleting provider files.
- Client-side FFmpeg or WebAssembly transcoding.
- Retaining the current Vercel deployment as an active fallback.
- Importing the existing encrypted Vercel control-plane state.
- Bundling a reverse proxy or terminating public TLS inside the container.
- Automatically deploying the image or changing DNS.
- Automatically deleting Vercel, Firebase, Blob, Firestore, or other external resources.

## Chosen architecture

Cloudframe becomes one Node.js 24 process managed by `tini` inside a Linux container. It serves the built applications and public API, owns local state, coordinates FFmpeg/FFprobe child processes, and streams provider input to the transcoder through a loopback-only capability endpoint.

```text
TV or admin browser
        |
        | same-origin HTTPS through operator's reverse proxy
        v
Cloudframe container :8080
  |-- static TV and admin applications
  |-- control, browse, and media APIs
  |-- Video.js/HLS session endpoints
  |-- SQLite control and cache metadata
  |-- one-transcoder coordinator
  |-- loopback-only provider source gateway
  `-- FFprobe / FFmpeg
        |
        | read-only OAuth or provider-signed retrieval
        v
Google Drive / OneDrive
```

Compatible media keeps the current efficient direct-provider path. Incompatible media uses an authenticated same-origin HLS path generated and cached by the container.

## Why demand-paged HLS

The transcoder produces H.264/AAC MPEG-TS segments behind a complete video-on-demand HLS playlist.

This is preferred over the alternatives because:

- a single fragmented-MP4 response has poor reconnect, cancellation, cache reuse, and arbitrary-seek behavior;
- a purely linear HLS job cannot seek beyond the portion encoded so far; and
- demand-paged HLS can start after one segment, seek to an unencoded part of the source, survive browser retries, and reuse completed work.

The playlist describes the complete probed duration. Segment URLs are stable even before their files exist. Requesting an absent segment asks the coordinator to generate the five-segment window containing it.

## Repository and runtime structure

### Self-hosted composition

A new self-hosted composition root replaces `deploy/api-entry.ts` for the active runtime. It creates:

- a local SQLite control store;
- process-local hot state and rate limiting;
- tracked deferred tasks that participate in graceful shutdown;
- the existing auth, enrollment, OAuth, provider-folder, browse, and direct-media services;
- the transcode catalog and coordinator;
- the public Node HTTP server; and
- the private loopback provider-source server.

The existing control services and mutation reducers remain authoritative where they are platform-independent. Vercel Blob, Runtime Cache, Firestore recovery, and request-scoped Vercel OIDC are not constructed.

### Public listener

The container exposes one HTTP listener, default port `8080`. It routes in this order:

1. liveness and readiness endpoints;
2. transcode manifests, segments, heartbeat, and release endpoints;
3. the existing `/api` control application;
4. immutable built assets; and
5. TV or admin SPA fallbacks.

The server constructs security decisions from configured `APP_ORIGIN`, not from arbitrary `Host` or forwarding headers. Public HTTPS termination is the operator's responsibility.

### Internal listener

A second listener binds only to `127.0.0.1` on an ephemeral port inside the container. It is never exposed or published. FFprobe and FFmpeg receive a short-lived opaque job capability pointing at this listener, never an OAuth bearer token or provider-signed URL.

## Persistent data

The image has one writable application volume:

```text
/data/
|-- cloudframe.sqlite
|-- secrets/
|   `-- master.key
|-- transcodes/
|-- staging/
`-- backups/
```

Everything outside `/data` may be mounted read-only. Ordinary temporary process files use a bounded container `/tmp` tmpfs when the operator enables read-only-root hardening.

### Master key and derived keys

On the first boot, Cloudframe generates a random 256-bit master key at `/data/secrets/master.key` using an atomic create operation. On Linux it requires owner-only file permissions.

Distinct application keys are derived with HKDF and domain-separated labels for:

- control-state encryption;
- provider-token encryption;
- session cookies;
- browse handles;
- stable opaque IDs;
- CSRF tokens;
- rate-limit hashing; and
- admin passphrase peppering.

No master encryption secret is required in the environment. Reusing `/data` preserves the installation; losing the master key makes encrypted provider and control state unrecoverable. Operational documentation therefore treats the whole `/data` volume, not only the SQLite file, as the backup unit.

### SQLite layout

SQLite runs in WAL mode with foreign keys enabled and a bounded busy timeout.

The compact control-plane document remains an encrypted, revisioned snapshot so the existing parser and reducers do not need to be rewritten into unrelated table-level business logic. A `control_state` table stores the active encrypted envelope and revision.

Separate tables store operational data that is not part of the control document:

- schema migration history;
- transcode asset identity and probe metadata;
- generated window and segment state;
- byte accounting and last-access timestamps; and
- bounded diagnostic summaries.

Secrets, cookies, provider URLs, OAuth credentials, FFmpeg arguments containing capabilities, and media bodies are never stored in diagnostic tables.

### Mutation semantics

The local control store implements the existing `ControlPlaneStore` interface.

- `load` decrypts, parses, and clones the active snapshot.
- `mutate` uses one `BEGIN IMMEDIATE` transaction, re-runs the existing reducer against the current revision, requires a one-step revision increment, encrypts the result, and commits atomically.
- The single-process runtime does not need a remote CAS loop, but revision checks remain as an invariant and protect future maintenance tools.
- A failed encryption, schema parse, or write rolls back the transaction and returns a stable control-plane error.

### Migrations and backups

Database migrations run transactionally before readiness.

Before a migration that changes durable schema, Cloudframe checkpoints WAL and creates a verified SQLite backup under `/data/backups`. It retains the latest five automatic migration backups. A failed migration leaves the prior database usable, records no successful migration, and keeps readiness false.

Backups inside `/data/backups` do not replace an external backup of the complete `/data` volume.

## Fresh first-run ownership

An empty `/data` volume enters an unconfigured state.

1. The server initializes SQLite and the master key.
2. It generates a high-entropy one-time setup code.
3. The plaintext code is printed once to container logs. Only a keyed digest is stored.
4. `/admin` presents a first-run claim screen.
5. The administrator submits the setup code and creates the permanent admin passphrase.
6. The claim transaction stores the passphrase hash, creates the initial control document, and permanently invalidates the setup code.
7. The administrator connects any desired Google and/or OneDrive accounts, selects approved roots, and pairs the TV through the existing approval flow.

The claim endpoint exists only while the installation is unconfigured, is rate-limited, compares the code in constant time, and never implements “first visitor automatically wins.” There is no remote factory-reset endpoint. Starting over requires an explicit operator action against `/data`.

## Configuration

Required deployment configuration is deliberately small:

```env
APP_ORIGIN=https://tv.example.com
PORT=8080

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

ONEDRIVE_CLIENT_ID=
ONEDRIVE_CLIENT_SECRET=
ONEDRIVE_TENANT=common
```

Rules:

- `APP_ORIGIN` must be one exact HTTPS origin with no path, query, credentials, or fragment.
- A provider's client ID and client secret must be supplied together or omitted together.
- At least one provider can be connected after first run, but readiness does not require both providers.
- OAuth callback URLs are derived only from `APP_ORIGIN`.
- Cookies remain Secure, HttpOnly, and use the existing route-family SameSite policy.
- The server does not trust arbitrary forwarded hosts or origins.

Optional operational settings include:

```env
TRANSCODE_CACHE_MAX_BYTES=50GiB
TRANSCODE_CACHE_MIN_FREE_BYTES=5GiB
TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS=30
TRANSCODE_THREADS=auto
LOG_LEVEL=info
```

Defaults are safe for one viewer. Invalid values fail readiness rather than silently selecting an unsafe value.

## Container contract

The repository produces a multi-stage Linux image.

### Build stage

- Pin Node.js 24.
- Install the locked workspace dependencies.
- Build the TV and admin applications.
- Bundle the self-hosted server entry point.
- Run build-time asset and contract checks.

### Runtime stage

- Use a slim Node.js 24 base compatible with the build stage.
- Install FFmpeg/FFprobe, CA certificates, and `tini` from the image distribution.
- Copy only production server output, static applications, required native modules, and package metadata.
- Run as a dedicated unprivileged user.
- Use `tini` as PID 1.
- Expose port `8080` only.
- Declare `/data` as the persistent writable path.
- Do not include Nginx, TLS certificates, Cloudflare configuration, host SSH details, or provider credentials.

The Dockerfile must not hardcode Horizon or another deployment target. The mandatory verified image target is `linux/amd64`; the build must avoid unnecessary architecture assumptions so `linux/arm64` publication can be added after its native dependencies pass the same suite.

### Compose example

The repository includes a host-neutral example:

```yaml
services:
  cloudframe:
    image: ghcr.io/example/cloudframe:VERSION
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - .env
    volumes:
      - ./cloudframe-data:/data
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```

Documentation may also show `read_only: true` plus a `/tmp` tmpfs. It must make clear that the reverse proxy, certificate, DNS, registry, and final host remain operator choices.

## Media-source decision boundary

`POST /api/tv/media-url` remains the device, root, source, item, and revision authorization boundary. Its response becomes an explicit union.

```ts
type TvMediaSourceResponse =
  | {
      itemId: string;
      kind: "image" | "video";
      transport: "direct" | "google-bearer";
      url: string;
      authorization?: { scheme: "Bearer"; token: string };
      expiresAt: string;
      revision: string | null;
    }
  | {
      itemId: string;
      kind: "video";
      transport: "hls";
      playlistUrl: string;
      playbackSessionId: string;
      durationSeconds: number;
      profile: "h264-aac-1080p-v1";
      expiresAt: string;
      revision: string | null;
    };
```

- Images retain their current direct transport.
- Browser-compatible video retains direct OneDrive or Google bearer delivery.
- Known legacy types, initially `video/mpeg` and the existing `.mpg`, `.mpeg`, and `.dat` candidates, select HLS without first performing a doomed native attempt.
- A file that is expected to be compatible may try native playback once. A confirmed native decoder failure may request one HLS fallback descriptor.
- The TV never loops between direct and HLS sources.
- Response bodies remain private and no-store.

## Probe and cache identity

Before returning the first HLS descriptor for an asset, the server runs FFprobe through the internal source gateway.

FFprobe returns a strictly decoded bounded JSON result containing:

- duration;
- container name;
- video and audio codec names;
- dimensions and pixel format;
- frame-rate metadata when usable; and
- stream-presence flags.

Probe execution has a timeout, bounded stderr capture, output-size limit, and child-process cancellation. Unsupported, missing-video, encrypted, or pathological sources fail with a stable transcoder error.

The cache key is a cryptographic digest of:

- household identity;
- provider kind and source identity;
- provider item identity;
- provider content revision;
- normalized source size when present; and
- transcoding profile version.

Names and provider URLs are not used as filesystem paths. Replacing or revising a provider file creates a new cache identity and cannot replay stale segments.

## HLS output contract

### Encoding profile

The initial profile is intentionally singular:

```text
Profile ID: h264-aac-1080p-v1
Video codec: H.264/libx264
Pixel format: yuv420p
Rate control: CRF 22
Preset: veryfast
Maximum frame size: 1920x1080, preserve aspect ratio, never upscale
Audio codec: AAC-LC
Audio rate: 160 kbit/s
Audio channels: at most stereo
Segment container: MPEG-TS
Segment target: 4 seconds
Window size: 5 segments, approximately 20 seconds
```

If the source has no audio, output remains video-only. If it has no supported video stream, the request fails rather than manufacturing a misleading video.

FFmpeg is spawned directly with an argument array and no shell. File names, user text, URLs, cookies, and OAuth credentials never become shell syntax.

### Complete virtual playlist

After probing, the server can compute the complete duration and segment count. It returns a VOD media playlist containing:

- `#EXTM3U`;
- an HLS version compatible with MPEG-TS playback;
- `#EXT-X-PLAYLIST-TYPE:VOD`;
- `#EXT-X-TARGETDURATION:4`;
- `#EXT-X-MEDIA-SEQUENCE:0`;
- one stable URI for every segment across the duration;
- discontinuity markers at independently encoded window boundaries;
- a shortened final `EXTINF` when required; and
- `#EXT-X-ENDLIST`.

A one-rendition master playlist points to this media playlist and declares H.264/AAC codecs. The master shape leaves room for future profiles without building an adaptive ladder now.

### Window generation

When segment `N` is absent, the coordinator determines its five-segment window and starts or joins that window's job.

- Input seeking begins at the window start through the provider source gateway.
- FFmpeg accurately discards up to the requested start and encodes only the bounded window.
- Forced keyframes align output to the four-second segment cadence.
- FFmpeg uses temporary segment files so a segment is never visible while still being written.
- As each segment completes, Cloudframe validates its expected numeric identity and atomically promotes it from the job staging directory into the asset cache.
- A waiting HTTP request may serve the first completed segment immediately while FFmpeg continues the remaining window.
- Only after FFmpeg exits successfully does Cloudframe atomically write the window-complete marker and final window metadata.
- On cancellation or failure, completed promoted segments remain reusable, the window remains explicitly partial, and incomplete temporary files are deleted.
- A later request reruns only the missing portion or safely replaces the same deterministic segment files after validation.

This segment-level promotion is the consistency boundary: fast startup does not require falsely declaring an interrupted window complete.

### Segment requests

Each segment request:

1. authenticates the current device cookie;
2. validates the playback session and its device, root, source, item, and revision binding;
3. renews the one-TV lease;
4. serves an existing validated segment or waits for the coordinator;
5. stops waiting when the client disconnects; and
6. never starts duplicate work for the same window.

Manifests use `Cache-Control: private, no-store`. Immutable session-scoped segment bodies may use bounded private browser caching and include exact content length and MPEG-TS content type. They are never publicly cacheable.

## One-TV coordinator

Exactly one FFmpeg process may exist at a time. FFprobe is also serialized against FFmpeg when necessary to keep the CPU budget predictable.

### Lease

- The first HLS descriptor acquires a lease for its approved device.
- The viewer sends a heartbeat every 15 seconds while an HLS source is active.
- Manifest and segment activity also renew the lease.
- The lease expires after 45 seconds without heartbeat or media activity.
- Viewer close, item change, device revocation, source removal, or explicit release ends the session immediately when the request reaches the server.
- Expiry is the fallback when a browser or network disappears without releasing.

Another approved device requesting HLS while a different live device owns the lease receives `TRANSCODER_BUSY`. Direct images and compatible direct video are not blocked by that lease.

### Scheduling

Priority is:

1. an actively requested missing segment;
2. the next window for the current playback session; and
3. no work.

Requests for the active window share its process and completion notifications. A genuine seek causes the player to abandon old segment requests; once the obsolete job has no active waiter and is only speculative, the coordinator terminates it and starts the requested window. A next-window prefetch never delays a demanded seek.

Changing to another item on the same leased TV transfers the lease, cancels obsolete speculative work, and preserves already completed cache segments.

### Child-process lifecycle

- Child processes run in their own process group where supported.
- Cancellation sends graceful termination first and escalates after a bounded delay.
- Shutdown stops accepting new transcode work, terminates active FFmpeg/FFprobe processes, waits for tracked storage commits, closes SQLite, and exits.
- Startup removes abandoned temporary files and validates partial-cache metadata before readiness.

## Internal provider source gateway

The source gateway gives FFprobe and FFmpeg a seekable HTTP input without exposing provider secrets in process arguments.

For every job, the coordinator creates a random high-entropy capability bound to exactly:

- one provider source and item;
- the expected content revision;
- one process/job identity;
- allowed `GET` and `HEAD` methods;
- a short expiry; and
- a bounded number of active connections.

The gateway:

- accepts only loopback connections;
- validates the exact capability and method;
- accepts at most one syntactically valid byte range;
- obtains or refreshes provider credentials through the existing credential broker;
- attaches Google's bearer header server-side or follows OneDrive's validated temporary download capability;
- permits at most one credential refresh after an authorization failure;
- forwards only safe media request headers;
- streams provider responses without buffering the complete file;
- preserves safe `200`, `206`, and `416` range semantics; and
- exposes only the response headers FFmpeg needs.

It never accepts an arbitrary source URL from the TV, admin browser, query string, or FFmpeg. Provider redirects and final hosts are constrained by provider-specific validation. Capability values, provider URLs, and authorization headers are redacted from logs and diagnostics.

## Public transcode endpoints

The initial route family is:

```text
GET    /api/tv/transcodes/:session/master.m3u8
GET    /api/tv/transcodes/:session/stream.m3u8
GET    /api/tv/transcodes/:session/segments/:index.ts
POST   /api/tv/transcodes/:session/heartbeat
DELETE /api/tv/transcodes/:session
```

The session identifier is random and opaque, but is not sufficient authorization. Every route also requires the current approved device session and revalidates the stored binding. Numeric segment indices are strictly bounded by the probed duration; filesystem paths are derived from server-owned cache identities, never request path text.

Admin diagnostics receive a separate protected status view and cannot retrieve source capabilities or raw FFmpeg command lines.

## Player architecture

### Real Video.js 10 interface

The TV imports:

```ts
import "@videojs/html/video/player";
import "@videojs/html/video/skin";
```

Supported browsers render:

```html
<video-player>
  <video-skin>
    <video playsinline></video>
  </video-skin>
</video-player>
```

This replaces the misleading state-only wrapper with the packaged Video.js 10 beta skin and controls. The native `HTMLVideoElement` remains the source of truth for history, duration, buffering, seeking, renewal, and error handling.

### Legacy fallback

Video.js 10 does not officially support Chromium 68 or smart-TV browsers. Progressive enhancement therefore remains mandatory.

- The native video element renders from first paint.
- Native controls remain available until player and skin registration is confirmed.
- Import, registration, upgrade, or runtime failure leaves the same native element playable.
- Cloudframe's remote key handling remains independent of pointer-focused Video.js controls.
- The custom Cloudframe control overlay is retained only as the explicit native fallback, not layered over a working Video.js skin.

### Direct playback

Direct OneDrive and Google bearer descriptors keep the native media pipeline and existing Google service-worker bridge. This avoids sending already-compatible media bodies through the server.

When the source becomes ready, the viewer attempts unmuted `video.play()`. Opening the item is still a user action, but asynchronous URL vending may outlive browser activation. A rejected autoplay promise is not an error: the real Video.js play control remains visible and Enter/play-pause starts playback.

### HLS playback

The HLS descriptor always drives the same underlying native video element.

1. If the browser reports native HLS support, assign the authenticated same-origin playlist directly.
2. Otherwise instantiate the bundled `hls.js` engine against the native element.
3. HLS requests include same-origin credentials.
4. Destroy the HLS engine before replacing the item, returning to direct playback, closing the viewer, or unmounting.
5. Map fatal HLS network/media errors into the bounded Cloudframe error model; do not create an automatic restart loop.

The Vite legacy build must transpile the application integration for Chromium 68. If neither native HLS nor Media Source Extensions are usable, the TV reports that transcoded playback is unsupported on that browser.

### Remote and history behavior

The following behavior remains intact for both direct and HLS sources:

- Enter and media play/pause keys;
- dedicated play and pause keys;
- ten-second forward and backward seeking;
- Back to the collection;
- item-to-item viewer navigation;
- periodic local watch-history snapshots;
- resume from the saved timestamp;
- completion detection; and
- no automatic slideshow advancement until video playback ends.

## Cache management

Generated assets live under server-owned hashed directories in `/data/transcodes`.

### Accounting

SQLite records each segment's expected asset, profile, window, index, size, completion status, and last access. Filesystem and database updates are ordered so a crash yields either a reusable complete segment or a detectable orphan, never a trusted partial file.

Startup reconciliation removes abandoned `.tmp` files, drops metadata for missing files, and either adopts or removes valid unreferenced segment files according to a bounded scan policy.

### Eviction

Default limits are:

- maximum transcode cache: `50GiB`;
- minimum free filesystem space: `5GiB`.

Before starting work, the server evicts least-recently-used inactive assets until both constraints can be satisfied. It never evicts:

- an asset belonging to the active playback session;
- a segment being served;
- a window being generated; or
- a file with an in-flight atomic promotion.

If enough safe space cannot be reclaimed, the request fails with `TRANSCODER_CACHE_FULL`. The server does not consume the reserved free-space floor.

## Error model

Stable transcoder error codes are:

- `TRANSCODER_BUSY`;
- `TRANSCODER_SOURCE_UNAVAILABLE`;
- `TRANSCODER_UNSUPPORTED`;
- `TRANSCODER_FAILED`;
- `TRANSCODER_WINDOW_TIMEOUT`;
- `TRANSCODER_CACHE_FULL`; and
- `TRANSCODER_SESSION_EXPIRED`.

Rules:

- There is at most one direct-to-HLS fallback for an item.
- Provider input performs at most one credential refresh per failed retrieval attempt.
- The first demanded segment has a configurable generation timeout.
- A browser disconnect stops its wait and may make speculative work cancellable.
- Raw FFmpeg/FFprobe stderr is never returned to a client.
- A bounded, secret-filtered stderr tail may be retained for admin diagnostics.
- The TV distinguishes busy, source unavailable, unsupported source, conversion failure, timeout, full cache, and expired session with actionable copy.
- Failed HLS playback never falls back to the same known-unsupported direct MPEG source.

## Authorization and security invariants

- Provider OAuth remains read-only and minimized.
- Every descriptor is authorized against the current approved device, assigned root, healthy source, sealed browse item, and credential version.
- Every manifest, segment, heartbeat, and release request requires the approved device cookie in addition to its opaque session ID.
- Device revocation, root removal, source removal, or credential-version change invalidates subsequent HLS requests and cancels matching active work.
- Transcode sessions and source capabilities are held in memory and expire.
- OAuth tokens, signed provider URLs, cookies, capabilities, decrypted control documents, and media response bodies are excluded from logs and client errors.
- Public endpoints never accept an arbitrary URL, local path, FFmpeg option, output name, or filter expression.
- Child processes are spawned without a shell under the unprivileged container user.
- The example container drops Linux capabilities and enables `no-new-privileges`.
- API, manifest, and media responses retain strict content types, no sniffing, no referrer leakage, and bounded cross-origin policy.

## Health, readiness, and diagnostics

### Liveness

`GET /healthz` reports only whether the Node process event loop can answer. It does not touch providers or mutate state.

### Readiness

`GET /readyz` succeeds only when:

- configuration is valid;
- `/data` and the master key are usable;
- SQLite is open and migrations are current;
- static application assets are present;
- FFmpeg and FFprobe executables pass their startup version probes;
- staging cleanup has completed; and
- the server is not draining for shutdown.

Provider availability is request-scoped and does not make the whole service unready.

### Logs and admin diagnostics

Structured JSON logs may contain:

- request and job IDs;
- route templates and safe status codes;
- asset/cache digests that cannot be reversed to provider IDs;
- probe and transcode durations;
- window and segment indices;
- FFmpeg progress, speed, exit reason, and bounded error code;
- cache bytes, evictions, and free-space decisions; and
- startup, migration, readiness, and shutdown events.

The protected admin diagnostics view shows the active item name, source provider, direct-versus-HLS decision, current window, progress, speed, queue rejection count, cache use, and last stable failure. It does not display OAuth tokens, raw URLs, source capabilities, cookies, or unfiltered process output.

## Graceful shutdown and crash recovery

On `SIGTERM` or `SIGINT`, the server:

1. marks readiness false;
2. stops accepting new first-run, mutation, and transcode work;
3. lets already available static responses and cached segment reads finish for a short drain interval;
4. terminates FFmpeg/FFprobe and the internal source gateway;
5. completes or rolls back SQLite transactions;
6. checkpoints WAL when safe;
7. closes listeners and SQLite; and
8. exits under `tini`.

After an unclean exit, SQLite WAL recovery restores committed state. Startup staging reconciliation removes incomplete files, preserves validated promoted segments, clears stale in-memory lease assumptions, and marks interrupted windows partial before readiness.

## Verification strategy

### Storage and first run

- Initialize from an empty `/data` volume.
- Prove the setup code is printed once, stored only as a digest, rate-limited, and permanently invalidated after claim.
- Verify master-key permissions, HKDF domain separation, encrypted provider state, WAL recovery, revision checks, transactional migrations, automatic backups, and restart persistence.
- Verify missing or mismatched provider credential pairs fail configuration validation.

### Authorization

- Bind HLS sessions to the current device, root, source, item, revision, and credential version.
- Reject cross-device reuse, stale sessions, expired sessions, revoked devices, removed roots, unhealthy sources, path traversal, negative/oversized segment indices, and arbitrary source injection.
- Prove admin diagnostics and logs contain no provider credential, signed URL, session cookie, source capability, or media body.

### Provider source gateway

- Exercise Google bearer and OneDrive signed retrieval with `GET`, `HEAD`, and byte ranges.
- Prove one credential refresh and no unbounded retry.
- Prove streaming backpressure without full-file buffering.
- Reject non-loopback callers, expired capabilities, wrong jobs, extra methods, multiple ranges, and unapproved redirect hosts.

### FFmpeg integration

- Transcode a committed small MPEG fixture through the real loopback gateway.
- Verify output with FFprobe as H.264, AAC when audio exists, and `yuv420p` within the 1080p cap.
- Verify first-segment availability before window completion.
- Verify sequential playback, arbitrary forward seeking, discontinuity boundaries, shortened final segment, cancellation, partial-segment reuse, successful window completion, process cleanup, cache reuse, and revision invalidation.
- Verify exactly one FFmpeg process and deterministic `TRANSCODER_BUSY` behavior.
- Verify first-segment timeout, provider failure, unsupported input, FFmpeg failure, and cache-full handling.

### Player

- Assert the actual `video-player > video-skin > video` structure and packaged-skin registration.
- Verify the custom overlay appears only on native fallback.
- Verify the autoplay attempt and visible play fallback.
- Verify compatible direct MP4 playback.
- Verify known MPEG selects HLS without a doomed native attempt.
- Verify a confirmed unexpected direct decoder failure switches to HLS exactly once.
- Verify native HLS selection, `hls.js` MSE selection, engine teardown, remote keys, seeking, history, resume, navigation, and error copy.

### Chromium 68 and TV compatibility

- Extend the pinned Chromium 68 probe so Video.js import or skin failure never removes the native element.
- Exercise the bundled `hls.js` path against generated HLS.
- Prove a browser lacking both native HLS and usable MSE receives a stable unsupported message.
- Complete real LG webOS acceptance for direct MP4, transcoded MPEG, seeking to an ungenerated window, pause/resume, Back, and a container restart between sessions.

### Container

- Build the production image from a clean checkout.
- Start it with an empty mounted `/data`.
- Complete first-run ownership, restart, and prove state persists.
- Verify `/healthz`, `/readyz`, unprivileged execution, one public port, no embedded deployment credentials, read-only root operation, `/tmp` tmpfs operation, graceful termination, and orphaned-job cleanup.
- Inspect the final image for Vercel function artifacts and host-specific Horizon configuration.

### Full repository gates

- Focused tests run red before implementation and green afterward.
- Run the complete Vitest suite, TypeScript checks, ESLint, TV/admin production builds, Playwright journeys, Chromium 68 check, Docker build, and container smoke suite.

## Cutover

This is a fresh installation, not a data migration.

Implementation removes from the active application:

- the Vercel function composition and build contract;
- `vercel.json` and Vercel output generation;
- private Vercel Blob control storage;
- Vercel Runtime Cache;
- Firestore recovery-mirror runtime wiring;
- Vercel OIDC request-token plumbing; and
- documentation that describes Vercel as the active host or media boundary.

Platform-independent provider, auth, browse-handle, navigation, and UI logic is retained and adapted rather than rewritten without cause.

The repository deliverables are:

- the self-hosted Node server;
- SQLite state and first-run ownership;
- demand-paged FFmpeg HLS transcoding;
- the actual Video.js 10 beta skin with legacy fallback;
- Dockerfile and `.dockerignore`;
- a host-neutral Compose example;
- configuration and backup documentation;
- local container verification; and
- updated architecture and operational documentation.

The work stops before registry publication, host deployment, reverse-proxy installation, DNS changes, certificate issuance, or external-resource deletion unless the user separately requests those actions.

## Acceptance criteria

The design is successfully implemented when all of the following are true:

1. A clean `docker compose up` with an empty `/data` produces a claimable fresh installation.
2. Admin ownership, provider connections, approved roots, and TV pairing survive a container replacement that retains `/data`.
3. A compatible MP4 uses direct provider playback and the real Video.js 10 beta skin.
4. A legacy `.MPG` begins browser-safe HLS playback without a manual offline conversion.
5. The user can seek to an ungenerated point in that MPG and playback resumes after the demanded window is encoded.
6. Only one FFmpeg process runs, another device receives a bounded busy response, and direct browsing remains responsive.
7. Provider files remain unchanged and provider OAuth permissions remain read-only.
8. No Vercel, Firestore, Horizon, reverse-proxy, DNS, or TLS dependency exists in the running image.
9. All automated, legacy-browser, container, and real-TV acceptance gates pass.
