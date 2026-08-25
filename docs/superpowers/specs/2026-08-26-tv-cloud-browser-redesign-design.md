# TV Cloud Browser Redesign

**Status:** Approved design

**Date:** 2026-08-26

## 1. Objective

Replace the current pairing-heavy TV video interface with a simple, permanent, single-household cloud media browser inspired by the visual polish of [pulsejet/memories](https://github.com/pulsejet/memories) and the navigation model of Google Drive.

The redesigned product has two surfaces:

- a read-only TV browser optimized first for LG webOS 5.0+;
- a mobile-first admin panel for devices, cloud sources, folder assignments, and settings.

The TV experience is folder-only. It does not include a timeline. It presents assigned Google Drive and OneDrive roots as one virtual drive, uses deterministic three-image folder mosaics, and opens images and videos in a unified full-screen viewer.

Memories is visual and interaction inspiration only. Its source is AGPL-licensed and must not be copied into this project.

## 2. Product decisions

| Area | Decision |
| --- | --- |
| Ownership | One private household and one administrator |
| Admin login | One long passphrase, with no username or email |
| Cloud connections | Connected globally once, then assigned per device by root folder |
| TV enrollment | Device name, pending request, admin approve or deny; no access or pairing code |
| TV persistence | Permanent renewable HTTP-only cookie until revocation or browser-data clearing |
| TV content model | Folder-only virtual drive |
| Folder navigation | Google Drive-style roots, breadcrumbs, Enter to open, Back to parent |
| Folder covers | Stable three-image mosaics |
| Open-folder layout | Uniform virtualized grid |
| Viewer | Unified images and videos; Left and Right traverse folder media |
| TV permissions | Strictly read-only |
| Admin layout | Mobile-first |
| Primary TV baseline | LG webOS 5.0+ / Chromium 68 |
| Other targets | Samsung Tizen, Android/Google TV, current desktop and mobile browsers |
| Cloud providers at launch | Google Drive and OneDrive |
| Library size | Under 10,000 indexed media items per household |
| Hosting and compute | Vercel |
| Durable data | Cloud Firestore |
| Thumbnail bytes | Provider CDN to browser; ordinary browser HTTP cache only |
| Media bytes | Provider CDN to browser; never proxy through Vercel or Firebase |

## 3. Scope

### 3.1 Included

- Permanent device enrollment and administration.
- Global Google Drive and OneDrive OAuth connections.
- Per-device root-folder assignments.
- Firestore-backed metadata index.
- Folder browsing with breadcrumbs and focus restoration.
- Three-image folder mosaics assembled in the browser.
- Image viewer, slideshow, video playback, seeking, and resume history.
- Browser-compatible direct media and thumbnail URLs.
- Source sync, reconciliation, health reporting, and manual sync.
- Responsive admin workflows for phone, tablet, and desktop.
- Automated tests and real-device acceptance on the supported TV baseline.

### 3.2 Excluded from the initial release

- Timeline, albums, search, favorites, face recognition, tagging, uploads, moves, renames, or deletes from the TV.
- Multi-user or multi-household tenancy.
- Video transcoding or codec conversion.
- Copying original media into Firebase or Vercel storage.
- Server-side thumbnail rendering or thumbnail object storage.
- Offline media playback.
- Native TV packages. The product remains a hosted web application.

## 4. System architecture

The repository becomes a workspace with independently built TV and admin applications plus shared server and contract packages.

```text
apps/
  tv/          Preact + Vite TV application
  admin/       React + Vite mobile-first admin application
api/           Vercel server functions and HTTP route handlers
packages/
  auth/        Session, passphrase, CSRF, and cookie contracts
  providers/   Google Drive and OneDrive adapters
  indexer/     Crawl, delta, reconciliation, and checkpoint logic
  shared/      Data contracts, validation, sorting, and IDs
  tv-core/     Focus graph, remote-key normalization, viewer state
```

### 4.1 TV application

- Preact and Vite are used to keep the bundle small.
- Production output is transpiled and polyfilled for Chromium 68.
- The TV does not import the Firebase client SDK.
- The TV calls same-origin Vercel APIs using credentials-included HTTP requests.
- It owns only transient UI state in memory: current folder, focus, scroll, viewer index, and playback controls.

### 4.2 Admin application

- React and Vite provide a modern mobile-first interface.
- The admin also avoids direct Firestore access. It calls same-origin Vercel APIs so all authorization and invariants remain server-controlled.
- OAuth starts and completes through Vercel endpoints.

### 4.3 Vercel responsibilities

- Serve both static applications: TV at `/` and admin at `/admin`.
- Authenticate admin and device cookies.
- Handle device requests, approvals, revocations, and assignments.
- Handle OAuth callbacks and refresh provider tokens.
- Read and write Firestore through trusted server code.
- Run bounded indexing and reconciliation batches.
- Run resumable source crawls and delta syncs through Vercel Workflows.
- Return short-lived provider media and thumbnail URLs.
- Never proxy image or video bytes.

### 4.4 Firebase responsibilities

The Firebase Blaze project supplies Cloud Firestore only. Firebase Authentication, Cloud Storage, Hosting, and Functions are not used.

Firestore is created in `asia-south1` (Mumbai) and is inaccessible directly from browsers. Security rules deny all client access. Trusted Vercel functions run in `bom1` (Mumbai). Production authenticates through Vercel OIDC, a Google Cloud Workload Identity Federation pool, and a dedicated least-privilege service account. Production does not use a downloaded long-lived service-account key.

### 4.5 Deployment requirement

Initial crawls and manual Sync now start Vercel Workflows directly and therefore do not depend on cron frequency. The approved 15-minute automatic reconciliation requires Vercel Pro or an equivalent external scheduler. Vercel Hobby only permits daily cron execution. If deployment remains on Hobby, automatic reconciliation is daily plus manual Sync now; the admin must report this reduced cadence accurately.

### 4.6 Environments

- Local development uses the Firestore emulator and secret-free provider fixtures by default.
- Staging uses a separate non-production Firebase project and separate Google/Microsoft OAuth applications.
- Production uses the new billing-enabled Firebase project in `asia-south1`.
- Preview deployments cannot read production Firestore or production OAuth secrets.
- Firebase resources are created during implementation only after this spec and its implementation plan are approved.

## 5. Data model

Firestore document identifiers use random opaque IDs. Provider identifiers are stored as fields and are never treated as authorization.

### 5.1 `households/{householdId}`

```ts
interface Household {
  createdAt: Timestamp;
  allowNewDeviceRequests: boolean;
  defaultMediaOrder: "captured-desc" | "captured-asc" | "name-asc";
  defaultSlideshowSeconds: number;
  adminPassphraseHash: string;
  adminPassphraseVersion: number;
}
```

There is exactly one household in the initial product.

### 5.2 `adminSessions/{sessionId}`

```ts
interface AdminSession {
  householdId: string;
  tokenHash: string;
  passphraseVersion: number;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
}
```

### 5.3 `deviceRequests/{requestId}`

```ts
interface DeviceRequest {
  householdId: string;
  requestSecretHash: string;
  requestedName: string;
  status: "pending" | "approved" | "denied" | "expired";
  createdAt: Timestamp;
  expiresAt: Timestamp;
  resolvedAt: Timestamp | null;
  approvedDeviceId: string | null;
  userAgentSummary: string;
}
```

### 5.4 `devices/{deviceId}`

```ts
interface Device {
  householdId: string;
  name: string;
  enabled: boolean;
  assignedRootIds: string[];
  mediaOrder: "captured-desc" | "captured-asc" | "name-asc" | null;
  slideshowSeconds: number | null;
  createdAt: Timestamp;
  approvedAt: Timestamp;
  lastSeenAt: Timestamp;
  revokedAt: Timestamp | null;
}
```

### 5.5 `deviceSessions/{sessionId}`

```ts
interface DeviceSession {
  householdId: string;
  deviceId: string;
  tokenHash: string;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
}
```

### 5.6 `sources/{sourceId}`

```ts
interface Source {
  householdId: string;
  provider: "google" | "onedrive";
  accountLabel: string;
  encryptedRefreshToken: string;
  accessTokenCiphertext: string | null;
  accessTokenExpiresAt: Timestamp | null;
  status: "healthy" | "syncing" | "reauth-required" | "error" | "disabled";
  deltaCursor: string | null;
  crawlCheckpoint: IndexCheckpoint | null;
  activeWorkflowRunId: string | null;
  syncGeneration: string | null;
  nextSyncAt: Timestamp | null;
  leaseOwner: string | null;
  leaseExpiresAt: Timestamp | null;
  lastSyncStartedAt: Timestamp | null;
  lastSyncCompletedAt: Timestamp | null;
  lastSyncErrorCode: string | null;
  createdAt: Timestamp;
}
```

```ts
interface IndexCheckpoint {
  mode: "initial" | "delta" | "reconcile";
  providerPageCursor: string | null;
  processedNodeCount: number;
  generation: string;
}
```

Refresh and access tokens are encrypted before Firestore persistence. The encryption key and OAuth client secrets stay in Vercel environment secrets. Refresh tokens and general-purpose provider credentials are never returned to either frontend. Google direct media and preview URLs may contain a short-lived, read-only access token because Google Drive does not supply a provider-signed download URL; those URLs are treated as bearer secrets and are never persisted or logged.

### 5.7 `roots/{rootId}`

```ts
interface AssignedRoot {
  householdId: string;
  sourceId: string;
  providerNodeId: string;
  displayName: string;
  ancestryProviderIds: string[];
  enabled: boolean;
  createdAt: Timestamp;
}
```

### 5.8 `nodes/{nodeId}`

```ts
interface MediaNode {
  householdId: string;
  sourceId: string;
  provider: "google" | "onedrive";
  providerNodeId: string;
  parentNodeId: string | null;
  ancestorNodeIds: string[];
  name: string;
  normalizedName: string;
  kind: "folder" | "image" | "video";
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: Timestamp | null;
  createdAtProvider: Timestamp | null;
  modifiedAtProvider: Timestamp | null;
  thumbnailRevision: string | null;
  folderCoverNodeIds: string[];
  childFolderCount: number;
  childMediaCount: number;
  available: boolean;
  indexedAt: Timestamp;
}
```

`folderCoverNodeIds` contains zero to three deterministic descendant image/video IDs. No mosaic bitmap is generated.

### 5.9 `watchHistory/{deviceId_nodeId}`

```ts
interface WatchHistory {
  householdId: string;
  deviceId: string;
  nodeId: string;
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
  updatedAt: Timestamp;
}
```

## 6. Authentication and device enrollment

### 6.1 Browser persistence rule

The application uses HTTP cookies as its only application-owned browser persistence.

The implementation must not use:

- `localStorage`;
- `sessionStorage`;
- IndexedDB;
- Cache Storage;
- service-worker application state.

Ordinary browser HTTP caching of static assets and provider thumbnails is allowed. Clearing browser data removes the cookie and requires device approval again.

### 6.2 Admin authentication

- `/admin/login` accepts the configured passphrase.
- The passphrase is hashed with Argon2id and a server-side pepper.
- Successful authentication creates an opaque random session token.
- Only the SHA-256 token hash is persisted.
- The `admin_session` cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`. Lax is required so the cookie returns on the top-level Google/Microsoft OAuth callback.
- The cookie uses a 365-day lifetime and is renewed at most once per day when fewer than 30 days remain.
- The corresponding session expiry rolls forward with the cookie and has no absolute lifetime ceiling. It remains valid indefinitely while renewed, until sign-out, passphrase rotation, or explicit revocation.
- Sign-out, passphrase rotation, or explicit revocation invalidates the session.
- Mutating admin requests require an origin check and CSRF token/header contract in addition to the SameSite cookie.

### 6.3 Device request

1. A TV without a valid device session shows a device-name form.
2. Submitting creates a pending `deviceRequest` only if `allowNewDeviceRequests` is true.
3. The TV receives a 30-minute `device_request` cookie containing an opaque request secret. It is `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
4. The waiting screen polls with bounded backoff and displays an optional QR linking to `/admin/requests/{requestId}`.
5. The QR is a convenience link only. It grants no device or admin authority.
6. Pending requests expire after 30 minutes.

### 6.4 Approval

The approval screen requires the admin to:

- confirm or edit the device name;
- select one or more globally connected roots;
- approve or deny.

Approval atomically creates the device and device session, writes root assignments, and marks the request approved. On its next status poll, the TV receives a server-set permanent device cookie and opens the virtual root immediately.

### 6.5 Permanent device sessions

- Device sessions automatically renew while the device remains enabled.
- The cookie and session record use the same rolling 365-day lifetime as admin sessions, with no absolute lifetime ceiling.
- The `device_session` cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, and `Path=/`.
- Admin revocation or disabling takes effect on the next API request.
- Cookies are opaque; JavaScript cannot read the session token.
- Session records store token hashes, not raw tokens.
- The device may not request roots outside its assignments.
- Every browse, URL-vending, history, and heartbeat endpoint validates both session and current device state.

## 7. Admin experience

The admin panel has four top-level sections.

### 7.1 Requests

- Pending requests appear newest first.
- Approve opens the required name-and-root assignment flow.
- Deny invalidates the request immediately.
- Empty, disabled-request, expired-request, and network-error states are explicit.

### 7.2 Devices

Each device exposes:

- name and enabled state;
- last-seen timestamp;
- assigned roots;
- media ordering override;
- slideshow interval override;
- rename, reassign, disable, or revoke actions.

Revoke requires confirmation and cannot be undone without a new request.

### 7.3 Sources

- Connect Google Drive or OneDrive globally.
- Show account label, health, last successful sync, and current index status.
- Browse the indexed provider folder tree to create or remove assignable roots.
- Reconnect when OAuth is invalid.
- Remove only after showing every affected root and device.
- Sync now starts or resumes a bounded job.

### 7.4 Settings

- Allow new requests toggle.
- Change admin passphrase.
- Default ordering and slideshow interval.
- Sync cadence status and deployment-tier warning.
- Index counts, last errors, and estimated Firestore usage.
- Sign out.

## 8. TV browsing experience

### 8.1 Virtual root

All roots assigned to the device appear together as one virtual drive. Root cards display their configured name and a subtle provider/account label. The hidden drawer, opened by Menu where available, lists the assigned roots and provides Home. It never exposes source or device management.

### 8.2 Folder navigation

- Enter opens the focused folder or media item.
- Back returns to the parent folder.
- Back at the virtual root follows the platform's normal exit/history behavior.
- Breadcrumbs show the current path and are focusable only when doing so improves navigation on the target device.
- When returning from a folder, the parent restores the exact focused child and scroll offset.
- When returning from the viewer, the folder restores the exact media item and scroll offset.

### 8.3 Grid

- The folder uses one uniform responsive grid.
- Folders always precede media and sort alphabetically.
- Media uses the device override or household default: captured newest, captured oldest, or name ascending.
- Missing captured dates fall back to provider-created time, then modified time.
- Windowed rendering retains enough overscan rows that D-pad movement never lands on an unmounted item.
- Loading placeholders occupy final card geometry so focus and scroll do not jump.

### 8.4 Cards and folder mosaics

- Folder cards use three browser-rendered image panes: one large pane and two stacked panes.
- The index stores the exact zero-to-three cover node IDs.
- Selection prefers the newest suitable descendant media with valid previews, excludes duplicate IDs, and uses provider ID as the final stable tie-breaker.
- A folder with two preview items repeats no image; it uses a two-pane layout.
- A folder with one item uses a single hero preview.
- Empty folders use a polished provider-neutral folder illustration.
- Media cards use consistent aspect ratio and tasteful `object-fit: cover`; full media remains uncropped in the viewer.
- A video badge and resume progress bar distinguish videos without visual clutter.

### 8.5 Focus and remote input

- Focus uses a high-contrast outline, small scale increase, and elevated shadow.
- Navigation is spatial and explicit rather than dependent on native tab order.
- Remote input normalizes Arrow, Enter/OK, Back/Escape/Backspace, Play/Pause, and platform key codes.
- Menu is used when the browser exposes a reliable Menu key. Long-press Back and a focusable on-screen Sources action provide fallbacks where it does not.
- Nothing requires hover, pointer, touch, or a platform-specific proprietary API.
- Motion respects reduced-motion preferences and has a low-motion fallback for constrained TVs.

## 9. Viewer and playback

### 9.1 Unified viewer

The viewer receives the ordered media sequence for the open folder and the selected index.

- Left and Right move to adjacent images or videos.
- Enter toggles video playback or starts/pauses the image slideshow.
- Up opens a filmstrip and details overlay.
- Down closes the overlay.
- Back closes the viewer and restores the grid state.
- Videos pause when deactivated; only the active item owns a media element.
- During a slideshow, images advance after the configured interval. Reaching a video pauses slide advancement, plays the video, and advances only after the video ends or the user presses Right.

### 9.2 Images

- The TV requests a provider thumbnail/preview URL for the active image and nearby items.
- The visible image progresses from card preview to screen-sized provider preview and, only when necessary and supported, to original media.
- Adjacent prefetch is capped to one item on each side on the webOS baseline.
- Failed previews show a retryable state without advancing the viewer.

### 9.3 Videos

- The existing custom TV playback behavior is retained and restyled: play/pause, seek, time, buffered state, auto-hidden controls, resume history, and Back.
- No transcoding is included. Unsupported codecs show the filename, MIME type, and a clear compatibility explanation.
- History saves periodically, on pause, on seek completion, on visibility loss where supported, and before closing.

### 9.4 Direct media delivery

Vercel authorizes access but does not carry media bytes.

1. TV requests `POST /api/tv/media-url` with an indexed node ID.
2. Vercel validates the device session, device state, root assignment, and node ancestry.
3. Vercel refreshes the provider OAuth access token if required.
4. It returns a short-lived direct URL and expiry:
   - Google Drive: `files/{id}?alt=media` using the current short-lived read-only access token in a browser-usable URL.
   - OneDrive: the pre-authenticated `@microsoft.graph.downloadUrl`.
5. The browser streams and seeks directly from Google or Microsoft.
6. If the URL expires or produces an authorization failure, the viewer requests one replacement URL and resumes at the previous timestamp.

The same principle applies to thumbnails: Vercel returns provider preview URLs; the browser fetches them directly and relies on ordinary HTTP caching. Both applications send `Referrer-Policy: no-referrer` so temporary provider URLs and embedded short-lived tokens are not disclosed through navigation referrers.

## 10. Provider adapters

Both providers implement a shared server-only contract.

```ts
interface ProviderAdapter {
  beginAuthorization(input: AuthorizationInput): Promise<AuthorizationStart>;
  completeAuthorization(input: AuthorizationCallback): Promise<ProviderAccount>;
  refreshCredentials(source: Source): Promise<RefreshedCredentials>;
  listFolder(input: ListFolderInput): Promise<Page<ProviderNode>>;
  getChanges(input: ChangesInput): Promise<ChangesPage>;
  getThumbnailUrl(input: ThumbnailUrlInput): Promise<TemporaryUrl | null>;
  getMediaUrl(input: MediaUrlInput): Promise<TemporaryUrl>;
}
```

Adapters normalize provider records into folders, images, and videos. Provider-specific pagination, delta tokens, timestamp quirks, thumbnail sizes, and retry headers remain encapsulated in the adapter.

## 11. Indexing and synchronization

### 11.1 Initial crawl

- Connecting a source creates it in `syncing` state.
- The source API starts a Vercel Workflow for that source and returns immediately.
- Each workflow step reads a fixed number of provider pages or nodes, writes them idempotently, stores the authoritative checkpoint in Firestore, and completes before the Vercel function deadline.
- Workflow steps retry transient failures and continue until the crawl checkpoint is complete. A redeploy or process crash resumes from durable workflow state plus the Firestore checkpoint.
- Manual Sync now starts or resumes the same source workflow safely.
- A node's identity is unique by `(sourceId, providerNodeId)`.

### 11.2 Incremental sync

- Google Drive Changes and OneDrive Delta cursors update moved, renamed, changed, and deleted items.
- Every 15 minutes on Vercel Pro, a cron endpoint leases due sources and starts their bounded delta workflows.
- On Vercel Hobby, cron runs daily; the admin prominently reports the reduced cadence.
- Admin Sync now is always available and rate-limited.

### 11.3 Correctness

- Every batch is idempotent.
- Per-source lease documents prevent overlapping jobs.
- Writes include a sync generation so reconciliation can mark unseen stale nodes unavailable without deleting history immediately.
- Provider throttling honors `Retry-After` and records the next eligible run.
- Invalid refresh tokens move the source to `reauth-required`; they do not delete metadata or break other sources.
- Folder counts and cover IDs are recomputed only for changed ancestry branches.

### 11.4 Thumbnail metadata

No server cache exists. The index stores only:

- whether a preview is expected;
- dimensions and orientation when available;
- `thumbnailRevision` derived from provider modification state;
- deterministic folder cover node IDs.

URL responses include the revision so browser cache keys change when provider media changes.

## 12. API boundaries

All endpoints return structured JSON errors with a stable `code`, safe `message`, and optional retry metadata. Secrets, raw provider responses, tokens, and Firestore internals never appear in client errors.

### 12.1 Public/device enrollment

- `GET /api/bootstrap`
- `POST /api/device-requests`
- `GET /api/device-requests/status`

### 12.2 TV-authenticated

- `GET /api/tv/home`
- `GET /api/tv/folders/{nodeId}`
- `POST /api/tv/thumbnail-urls`
- `POST /api/tv/media-url`
- `GET /api/tv/watch-history`
- `PUT /api/tv/watch-history/{nodeId}`
- `POST /api/tv/heartbeat`

### 12.3 Admin-authenticated

- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/requests`
- `POST /api/admin/requests/{requestId}/approve`
- `POST /api/admin/requests/{requestId}/deny`
- `GET|PATCH|DELETE /api/admin/devices/{deviceId}`
- `GET /api/admin/sources`
- `POST /api/admin/sources/{provider}/authorize`
- `GET /api/admin/oauth/{provider}/callback`
- `POST /api/admin/sources/{sourceId}/sync`
- `DELETE /api/admin/sources/{sourceId}`
- `GET|PATCH /api/admin/settings`

### 12.4 Internal scheduled

- `GET /api/internal/sync-due-sources`

The internal endpoint requires `CRON_SECRET`, leases work transactionally, and performs bounded batches.

## 13. Security

- Browsers have no direct Firestore authority.
- Device authorization is derived from current root assignments and node ancestry on every sensitive request.
- Admin and device session tokens are 256-bit random values stored only as hashes.
- Cookies are Secure and HttpOnly. The admin cookie is SameSite Lax for OAuth return navigation; device and request cookies are SameSite Strict. All use `Path=/`, distinct names, and server-side route-family enforcement.
- Login, request creation, polling, URL vending, and mutation endpoints are rate-limited.
- Admin mutations use origin validation and CSRF protection.
- OAuth state values are single-use, short-lived, and bound to an admin session.
- Provider OAuth scope is read-only and minimized.
- Refresh and cached access tokens are encrypted with AES-256-GCM at application level before Firestore storage. Each record stores an encryption-key version for rotation.
- Logs redact cookies, OAuth tokens, temporary URLs, authorization headers, and passphrases.
- Temporary media and thumbnail URLs are returned only after current authorization checks and are never written to Firestore, analytics, error payloads, or logs.

## 14. Error handling and recovery

### 14.1 TV states

- unsupported browser;
- requests disabled;
- pending approval;
- request denied or expired;
- device disabled or revoked;
- no assigned roots;
- source temporarily unavailable;
- folder empty;
- thumbnail unavailable;
- media URL refresh failed;
- codec unsupported;
- offline or retrying.

Each state offers one clear action suitable for a remote. Background retries use bounded exponential backoff and never steal focus.

### 14.2 Admin states

- bad passphrase and lockout delay;
- OAuth cancellation or callback error;
- reauthentication required;
- sync queued, active, throttled, interrupted, or failed;
- affected-device preview before source/root deletion;
- optimistic mutation rollback with an explicit message.

### 14.3 Data recovery

- Firestore scheduled backups are enabled before production cutover.
- Configuration documents and encrypted source records are covered by restore procedures.
- The media index is reproducible from providers and may be rebuilt source by source.
- Revocation records and passphrase version changes are treated as security state and verified after restoration.

## 15. Compatibility and performance

### 15.1 Browser baseline

- Guaranteed: LG webOS 5.x and newer, whose official engine baseline begins at Chromium 68.
- Progressive support: current Samsung Tizen, Android/Google TV, desktop, and mobile browsers.
- Older LG engines receive a lightweight unsupported-browser page rather than a broken application.

### 15.2 Build constraints

- TV JavaScript syntax target: Chromium 68.
- Required polyfills are explicit and tested; no runtime reliance on unsupported syntax or APIs.
- CSS avoids unsupported modern-only features unless a fallback is defined.
- The TV shell does not require service workers, Web Storage, pointer events, ResizeObserver, or modern image codecs.

### 15.3 Budgets

Initial budgets, measured on production builds:

- TV initial compressed JavaScript: at most 180 KiB.
- TV initial CSS: at most 45 KiB compressed.
- First focusable skeleton on a warm network: under 2 seconds on the webOS acceptance device.
- Folder navigation after indexed JSON arrives: under 150 ms to visible stable focus.
- At most two adjacent viewer previews prefetched on webOS.
- Grid maintains responsive D-pad movement without long tasks over 100 ms during ordinary traversal.

These budgets may change only through an explicit spec revision supported by measurements.

## 16. Testing

### 16.1 Unit tests

- Session hashing, expiry, renewal, revocation, and passphrase versioning.
- Root-ancestry authorization.
- Sort fallbacks and deterministic cover selection.
- Provider normalization and token refresh.
- Index checkpoints, leases, deltas, tombstones, and retry scheduling.
- Remote-key normalization and focus policy.
- Viewer reducer and exact focus restoration.

### 16.2 Contract tests

Recorded, secret-free Google Drive and OneDrive fixtures run through the same adapter contract for:

- folders, images, videos, and pagination;
- moves, renames, and deletes;
- expired credentials;
- throttling;
- temporary media and thumbnail URLs.

### 16.3 Component and accessibility tests

- Device name, waiting, denied, disabled, and unsupported screens.
- Virtual root, folder cards, one/two/three-image mosaics, empty folders, and failed previews.
- Uniform grid navigation at all edges and across virtualization boundaries.
- Viewer images, videos, overlays, slideshow, URL refresh, and codec errors.
- All admin request, device, source, and settings workflows at phone widths.

### 16.4 End-to-end tests

Playwright covers:

1. enable requests;
2. submit a TV name;
3. approve and assign roots;
4. receive device cookie;
5. browse virtual root and nested folders;
6. open viewer and move image to video;
7. save and restore playback position;
8. reassign roots;
9. revoke the device and observe immediate loss of access.

### 16.5 Compatibility tests

- CI parses and executes the TV build in a Chromium 68-compatible lane.
- Real-device acceptance is mandatory on LG webOS 5.0+ before production cutover.
- Samsung Tizen and Android/Google TV receive smoke coverage.
- Remote Back, Enter, directional keys, playback keys, and the Menu fallback path are tested explicitly.

## 17. Observability and cost controls

- Structured Vercel logs carry request IDs, safe error codes, source IDs, device IDs, and sync job IDs.
- Secrets and temporary URLs are redacted.
- Admin source cards expose last successful sync, current cursor/checkpoint state, and safe failure reason.
- Alerts cover repeated OAuth refresh failure, sync backlog, elevated URL-vending errors, Firestore quota use, and Vercel function errors.
- Firestore remains under its no-cost allowance where practical, but correctness is not sacrificed to avoid a small Blaze charge.
- Thumbnail storage cost is zero because the product owns no thumbnail objects.
- Browser/provider HTTP caching is opportunistic and disposable; cache misses are normal behavior.

## 18. Migration and cutover

The rewrite is developed alongside the current Next.js application until acceptance.

1. Establish the workspace, Firebase project, Firestore schema, and emulator environments.
2. Build auth, device enrollment, and admin device management.
3. Build provider adapters and attempt one-time migration of existing Google/OneDrive refresh tokens from Vercel Blob into encrypted Firestore source records.
4. If a migrated token cannot be validated or lacks the required scope, mark that source `reauth-required`; never silently discard it.
5. Build the indexer, virtual root, folder grid, and browser-rendered mosaics.
6. Build the unified viewer and direct URL-vending flow.
7. Validate staging with provider fixtures and a real webOS device.
8. Enroll a fresh TV device through the new approval process. Existing localStorage session IDs are intentionally not migrated because the new design forbids Web Storage and changes the authorization model.
9. Cut the production domain to the workspace build only after admin, enrollment, browsing, viewer, sync, revocation, and restoration tests pass.
10. Retain the previous deployment for bounded rollback until the new system has completed at least one full reconciliation cycle.

## 19. Acceptance criteria

The redesign is complete when all of the following are true:

- A new TV enters only a name, waits, and becomes usable immediately after phone approval and root assignment.
- The admin can disable new requests and rejected TVs cannot create pending entries.
- An approved TV survives reloads and restarts without codes, QR rescans, `localStorage`, or `sessionStorage`.
- Revocation prevents the next authenticated API request.
- Multiple global sources can be assigned independently per TV without reconnecting OAuth.
- The TV exposes only read-only folder browsing and viewing.
- The virtual root, breadcrumbs, uniform grid, focus restoration, and hidden drawer work with a remote.
- Folder cards use deterministic browser-composed mosaics with correct one/two/empty fallbacks.
- Images and videos traverse in one viewer sequence.
- Videos stream and seek directly from Google/Microsoft; Vercel and Firebase never carry media bytes.
- Browser thumbnail caching works without application-managed persistent storage or a server thumbnail cache.
- Indexed browse APIs continue to work during a temporary provider listing outage.
- Source reauthentication, throttling, interrupted batches, moves, and deletes recover without corrupting other sources.
- The TV production bundle passes the Chromium 68 lane and real LG webOS 5.0+ acceptance.
- Admin workflows pass at mobile width and expose source/index health clearly.
- Production backup and restore procedures have been exercised once in staging.

## 20. External constraints verified during design

- LG maps webOS 5.x to Chromium 68: <https://webostv.developer.lge.com/develop/specifications/web-api-and-web-engine>
- Google Drive supports direct file downloads through `alt=media`: <https://developers.google.com/drive/api/guides/manage-downloads>
- OneDrive supplies a pre-authenticated download URL: <https://learn.microsoft.com/en-us/graph/api/driveitem-get-content>
- Firestore no-cost quota is separate from Cloud Storage: <https://firebase.google.com/docs/firestore/quotas>
- Vercel Hobby cron is daily; Pro supports minute-level scheduling: <https://vercel.com/docs/cron-jobs/usage-and-pricing>
- Vercel OIDC supports Google Cloud Workload Identity Federation: <https://vercel.com/docs/oidc/gcp>
- Vercel Workflows provide durable steps and retries for indexing: <https://vercel.com/docs/workflows/concepts>
