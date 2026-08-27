# Vercel Control Plane and Live Provider Browsing

**Status:** Approved architecture, written specification for final review
**Date:** 2026-08-27

## 1. Objective

Replace Cloudframe's Firestore-backed media index and request-time Firestore authorization with a small Vercel control plane.

Cloudframe is operated by one administrator and one television. Firestore must not be used as a media catalog, browsing database, session database, rate-limit database, or watch-history database. Continuous TV use must not cause Firestore traffic.

The target steady-state behavior is stricter than the requested 10-15 reads per day:

- ordinary TV startup, navigation, thumbnails, playback, and local resume history cause **zero Firestore reads and zero Firestore writes**;
- ordinary admin page loads cause **zero Firestore reads and zero Firestore writes**;
- enrollment, device edits, source edits, and refresh-token rotation update the active Vercel snapshot and write one compact Firestore recovery mirror without reading Firestore;
- Firestore is read only by an explicit, administrator-invoked recovery operation or a bounded one-time migration/session-upgrade path.

Media bytes continue to flow directly from Google Drive or OneDrive to the television. Vercel handles authentication, authorization, provider metadata requests, and temporary URL vending, but never proxies image or video bodies.

## 2. Approved product decisions

| Area | Decision |
| --- | --- |
| Deployment | Vercel remains the application and API platform. |
| Active control state | One encrypted private Vercel Blob snapshot, cached with Vercel Runtime Cache. |
| Firestore | One compact write-only recovery mirror containing authorized devices, provider credentials, approved roots, and household configuration. |
| Media index | Removed. Cloudframe stores no provider file or folder catalog. |
| Folder listing | Vercel requests the current folder live from Google Drive or OneDrive and returns sanitized metadata. |
| Provider credentials | Refresh tokens never leave Vercel. Access tokens are used server-side for listing and refresh. |
| Google playback | After authorization, Vercel returns a short-lived Google media URL containing the current Google access token; the TV streams directly from Google. |
| OneDrive playback | After authorization, Vercel returns Microsoft's temporary pre-authorized download URL; the TV streams directly from Microsoft. |
| Watch/resume history | Stored locally on the television in `localStorage`, never in Firestore or Vercel storage. |
| Sessions | Signed, sealed HTTP-only cookies; no Firestore session lookup on each request. |
| Authorization | Every metadata or URL-vending request checks the sealed session and the active Vercel control snapshot. |
| Rate limiting | Vercel platform protection plus a Vercel Runtime Cache limiter; no Firestore-backed counters. |
| Legacy data | Existing node, workflow, rate-limit, session, and watch-history collections are not automatically deleted. |

## 3. Explicit security trade-off for Google playback

Google Drive supports direct media download through `files.get?alt=media`. A normal HTML `<video>` element on the Chromium 68 target cannot attach an OAuth `Authorization` header. Cloudframe will therefore return a media URL whose query string contains the current Google access token.

This decision intentionally accepts the following boundary:

- anyone who extracts that access token from the approved TV can use it with the connected Google Drive API until the token expires;
- the token's `drive.readonly` scope may permit reads outside the roots assigned in Cloudframe;
- root assignment remains an application-level restriction for Cloudframe navigation, not a cryptographic restriction on the Google bearer token;
- revoking a TV in Cloudframe cannot invalidate an already-issued Google access token. Exposure lasts until Google expires or revokes that token, normally about one hour.

Mitigations remain mandatory:

- the refresh token is never returned to either browser;
- Google media URLs are returned only after current device and root authorization succeeds;
- media URL responses use `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`;
- the TV document sets a no-referrer policy;
- media URLs, OAuth codes, access tokens, refresh tokens, encrypted token material, and provider response bodies are never logged;
- the TV keeps media URLs only in memory and discards them when the viewer closes or the URL expires.

Google's direct download contract is documented in [Download and export files](https://developers.google.com/drive/api/guides/manage-downloads). OneDrive's existing adapter continues to use `@microsoft.graph.downloadUrl`.

## 4. Corrected architecture

```text
Admin browser                       Television
      |                                 |
      | signed admin cookie             | signed device cookie
      v                                 v
             Vercel Web API in bom1
             - session verification
             - root authorization
             - live provider listing
             - credential refresh
             - temporary URL vending
                    |
          +---------+----------+
          |                    |
          v                    v
 Vercel Runtime Cache    Private Vercel Blob
   hot encrypted copy      active durable snapshot
          |                    |
          +---------+----------+
                    |
          write-only recovery mirror
                    v
              Cloud Firestore

Folder metadata: Provider -> Vercel -> browser
Media bytes:     Provider ----------------> TV
Watch history:                            localStorage
```

### 4.1 Active state ownership

The encrypted private Vercel Blob snapshot is the runtime source of truth. Vercel Runtime Cache is a hot copy of that snapshot. Public request handling never falls through to Firestore when the cache is empty:

1. Read and decrypt the Runtime Cache entry.
2. On a Runtime Cache miss, read and decrypt the private Blob snapshot.
3. On a missing, corrupt, or undecryptable Blob snapshot, fail closed with `CONTROL_PLANE_UNAVAILABLE`.
4. Do not automatically read Firestore from a public request.

This rule ensures that traffic volume, cold starts, cache eviction, deployments, provider errors, or malicious requests cannot amplify Firestore reads.

### 4.2 Firestore's role

Firestore stores one recovery document at:

```text
controlPlaneBackups/{householdId}
```

The application writes the complete compact control document after an actual control-state mutation. The application does not query collections to reconstruct normal request state.

Firestore reads are limited to:

- `scripts/migrate-vercel-control-plane.mjs --apply`, once during cutover;
- an administrator-only `scripts/restore-vercel-control-plane.mjs --apply`, used only when the private Blob snapshot is unavailable;
- the temporary legacy-cookie exchange during cutover, once per existing browser session.

The restore script reads exactly one `controlPlaneBackups/{householdId}` document. It is never exposed as a public HTTP endpoint.

### 4.3 Vercel storage layers

The active snapshot is stored at a deterministic private pathname:

```text
cloudframe/control-plane/{householdId}.json.enc
```

The snapshot is protected twice:

- Vercel Blob access is private and server-only;
- the JSON body is encrypted with AES-256-GCM using a dedicated versioned control-plane key.

Vercel Runtime Cache stores the same encrypted envelope under:

```text
cloudframe:control-plane:v2:{householdId}
```

The Runtime Cache entry has a five-minute TTL and the tag `cloudframe-control:{householdId}`. Its loss causes one private Blob read, never a Firestore read. The short TTL bounds any stale-cache exposure if invalidation or replacement fails. The project continues to run only in `bom1`, preventing cross-region replicas from producing inconsistent active state.

Vercel documents Runtime Cache as transient regional storage exposed through `@vercel/functions`; it is an optimization, not the durable source. The private Blob snapshot remains authoritative when Runtime Cache is empty.

## 5. Compact control document

The active Blob and Firestore recovery mirror represent the same logical document. Token fields remain encrypted inside the document, and the entire Blob copy is envelope-encrypted.

```ts
interface ControlPlaneDocumentV2 {
  schemaVersion: 2;
  householdId: string;
  revision: number;
  updatedAt: string;
  household: {
    adminPassphraseHash: string;
    adminPassphraseVersion: number;
    allowNewDeviceRequests: boolean;
    defaultMediaOrder: "name-asc" | "captured-asc" | "captured-desc";
    defaultSlideshowSeconds: number;
  };
  devices: Record<string, {
    id: string;
    name: string;
    enabled: boolean;
    assignedRootIds: string[];
    mediaOrder: "name-asc" | "captured-asc" | "captured-desc" | null;
    slideshowSeconds: number | null;
    sessionVersion: number;
    createdAt: string;
    revokedAt: string | null;
  }>;
  pendingDeviceRequests: Record<string, {
    id: string;
    requestedName: string;
    requestSecretHash: string;
    status: "pending" | "approved" | "denied" | "expired";
    createdAt: string;
    expiresAt: string;
  }>;
  sources: Record<string, {
    id: string;
    provider: "google" | "onedrive";
    providerAccountId: string;
    providerRootId: string;
    accountLabel: string;
    encryptedRefreshToken: EncryptedSecret;
    encryptedBootstrapAccessToken: EncryptedSecret | null;
    bootstrapAccessTokenExpiresAt: string | null;
    credentialVersion: number;
    status: "healthy" | "reauth-required" | "disabled";
    createdAt: string;
  }>;
  roots: Record<string, {
    id: string;
    sourceId: string;
    providerNodeId: string;
    displayName: string;
    ancestryProviderIds: string[];
    enabled: boolean;
    createdAt: string;
  }>;
}
```

Hard ceilings keep the document small and the product aligned with its actual use:

- 8 approved devices;
- 8 simultaneous pending requests;
- 4 provider sources;
- 32 approved roots;
- 64 ancestry entries per root;
- 120 characters per user-visible name.

The implementation rejects mutations beyond these limits. With these ceilings the document remains far below Firestore's 1 MiB document limit and is inexpensive to encrypt, cache, copy, and recover.

The document does **not** contain provider nodes, folder contents, thumbnails, media URLs, watch history, request counters, last-seen heartbeats, workflow state, delta cursors, crawl checkpoints, or synchronization status.

## 6. Control-state mutations and recovery mirroring

### 6.1 Normal mutation

Device approval, revocation, root assignment, household settings, OAuth connection, source removal, and refresh-token rotation use one compare-and-swap mutation path:

1. Load the active document from Runtime Cache or private Blob.
2. Validate the signed admin/device request and the expected document revision.
3. Apply one domain mutation in memory and increment `revision` exactly once.
4. Encrypt the new snapshot.
5. Overwrite the private Blob using its current ETag through Blob's `ifMatch` option.
6. Replace the Runtime Cache entry with the committed encrypted snapshot and immediately read it back to confirm the new revision.
7. Write the full logical document to `controlPlaneBackups/{householdId}` using Firestore `set`, without reading Firestore.

An ETag conflict reloads the Blob and retries the domain mutation up to three times. After three conflicts the API returns `CONTROL_PLANE_CONFLICT`; it does not overwrite concurrent work.

If Runtime Cache replacement or revision verification fails, the Blob mutation remains committed but the admin mutation response is `503 CONTROL_CACHE_REFRESH_REQUIRED`, not success. The API deletes/expires the cache key best-effort and the next request reloads the authoritative Blob. Security-sensitive mutations such as device revocation, root removal, source disable, and passphrase rotation therefore never report success while knowingly serving the prior cached authorization state. Any unknown stale entry expires within five minutes even if deletion fails.

### 6.2 Firestore mirror failure

The private Blob commit is authoritative. If its Firestore recovery mirror fails:

- the user-visible mutation remains committed;
- the API emits a secret-safe `control_plane_mirror_failed` event containing only request ID, household ID, revision, and normalized error code;
- `waitUntil()` retries the same idempotent full-document write up to three times;
- the next successful control mutation writes the entire latest snapshot again, repairing an older mirror without reading it;
- admin diagnostics show `Recovery copy delayed` using Runtime Cache status, without exposing credentials.

No request is rolled back after a successful Blob commit, and retrying a client mutation cannot duplicate a device or root because IDs and expected revisions are deterministic.

### 6.3 Explicit recovery

If the private Blob snapshot is lost or corrupt, the public API fails closed. Recovery is an operator action:

```powershell
node scripts/restore-vercel-control-plane.mjs
node scripts/restore-vercel-control-plane.mjs --apply
```

The dry run reads the one Firestore recovery document, validates schema and encryption metadata, and reports only counts and revision. Apply mode writes a new private Blob snapshot and Runtime Cache entry. It never prints tokens, hashes, encrypted payloads, provider IDs, or device secrets.

## 7. Session and enrollment model

### 7.1 Device sessions

Approved televisions receive a sealed HTTP-only cookie containing:

```ts
interface DeviceSessionClaims {
  version: 2;
  householdId: string;
  deviceId: string;
  sessionVersion: number;
  issuedAt: number;
  expiresAt: number;
}
```

The cookie is authenticated with a versioned server secret and uses `Secure`, `HttpOnly`, `SameSite=Lax`, and path `/`. It lasts one year. Each API request:

1. verifies the cookie cryptographically;
2. loads the active Vercel control document;
3. verifies that the device exists, is enabled, is not revoked, and has the same `sessionVersion`;
4. performs the requested root check.

Revocation increments `sessionVersion` and disables the device. No session collection or token-hash query exists in the steady-state path.

### 7.2 Admin sessions

Admin login verifies the passphrase hash from the active Vercel control document and issues a sealed admin cookie containing the household ID, session ID, passphrase version, issue time, and expiry. Passphrase rotation increments `adminPassphraseVersion`, invalidating every existing admin cookie without querying a session collection.

CSRF protection remains origin-bound and derives a CSRF token from the sealed session ID and `CSRF_SECRET`.

### 7.3 Enrollment requests

Pending enrollment requests live in the active control document for at most 30 minutes. Creating a request is a real control mutation; polling its status reads only Runtime Cache/private Blob. Approval atomically creates the device, marks the request approved, and issues the TV cookie on its next poll.

Expired requests are ignored on reads and pruned during the next control mutation. There is no scheduled cleanup job.

### 7.4 OAuth state

OAuth PKCE verifier and state are stored in a sealed, ten-minute, HTTP-only cookie bound to the current admin session. A short-lived Runtime Cache replay marker prevents reuse after a successful callback. OAuth state is not written to Firestore.

## 8. Live provider browsing

### 8.1 Home response

`GET /api/tv/home` reads the active control document and returns the enabled roots assigned to the current device. It performs no provider request and no Firestore operation.

Because there is no index, root cards cannot truthfully include descendant counts or precomputed folder mosaics. They use the root name, provider/account label, and neutral collection artwork. Counts are omitted rather than guessed.

### 8.2 Opaque browse handles

Provider IDs must not be accepted directly from the TV as authorization evidence. Vercel returns an encrypted and authenticated opaque handle for every root, folder, and media item. The sealed payload contains:

```ts
interface BrowseHandleV2 {
  version: 2;
  householdId: string;
  deviceId: string;
  sourceId: string;
  rootId: string;
  providerNodeId: string;
  parentProviderNodeId: string | null;
  kind: "folder" | "image" | "video";
  name: string;
  mimeType: string | null;
  credentialVersion: number;
  issuedAt: number;
  expiresAt: number;
}
```

Handles use AES-256-GCM with a versioned `BROWSE_HANDLE_KEY_V1`, expire after 30 minutes, and are renewed whenever a folder page is returned. A handle is useful only with the device cookie to which it is bound. Provider IDs and credential versions are not visible in the browser-readable handle.

Each returned DTO also has a stable, pseudonymous `id` computed as an HMAC of household, source, and provider node ID with `BROWSE_ID_SECRET`. This ID supports focus restoration and local watch-history matching without exposing the provider node ID. It is not accepted as authorization; every provider operation still requires the sealed handle.

For every browse or media request, Vercel verifies the handle and then checks the current active document:

- device ID and household match;
- device is enabled and its session version is current;
- root is enabled and assigned to that device;
- root belongs to the named source;
- source is enabled and its credential version matches.

A stale handle returns `NAVIGATION_EXPIRED`; the TV reloads home and preserves no provider cursor.

### 8.3 Folder request

`GET /api/tv/folders/{opaqueHandle}` performs one live provider folder-page request:

1. authorize the device and handle from Vercel state;
2. obtain usable provider credentials from the credential cache;
3. call Google Drive `files.list` or Microsoft Graph `children` for that folder;
4. retain folders and browser-supported image/video records;
5. sanitize provider metadata;
6. sign new handles for returned items;
7. return the current folder, immediate breadcrumbs held by the TV navigation stack, children, and a signed provider cursor.

The TV keeps its navigation stack in memory. Cloudframe does not reconstruct an arbitrary provider ancestry chain on every request. Admin root selection may still resolve ancestry live once before saving a root.

Provider cursors are sealed, bound to the device/folder/source, and expire after 30 minutes. The OneDrive adapter continues to reject a next-link whose origin or path does not match Microsoft Graph and the requested drive item.

### 8.4 Sorting and folder visuals

Each returned page is grouped with folders first and sorted according to the device's configured order. Pagination is provider-backed, so a globally perfect sort across unloaded pages is not promised. The UI appends pages and re-sorts the accumulated visible entries.

The old three-image folder mosaics and indexed descendant counters are removed. Media items may show provider thumbnail URLs; folders use stable static artwork until opened. This avoids hidden recursive listing calls.

### 8.5 Thumbnails

Vercel obtains temporary thumbnail URLs from provider metadata APIs and returns those URLs to the TV. Thumbnail bytes go directly from the provider CDN to the TV. Vercel never downloads or stores thumbnail bodies.

Visible-item thumbnail requests accept only signed browse handles. They do not accept raw provider IDs and do not query Firestore.

## 9. Provider credential lifecycle

### 9.1 Durable credentials

The active snapshot and Firestore recovery mirror store encrypted refresh tokens. The access token returned at OAuth completion may be stored as `encryptedBootstrapAccessToken` so the first request after connection does not immediately refresh it. Routine refreshed access tokens are not persisted to Firestore.

### 9.2 Credential cache

Vercel Runtime Cache keeps an encrypted credential entry per source, keyed by source ID and `credentialVersion`, with TTL clamped to the provider token's expiry. On expiry:

1. decrypt the refresh token from the active Vercel snapshot;
2. request a new access token from the provider;
3. retry the failed provider request once;
4. cache the new access token in encrypted form;
5. update the active control document only if the provider rotated the refresh token;
6. mark the source `reauth-required` through a control mutation when refresh is definitively rejected.

Routine hourly access-token refresh therefore causes no Firestore read or write.

### 9.3 Media URL vending

`POST /api/tv/media-url` accepts a signed media handle. After current device/root/source authorization:

- Google returns `https://www.googleapis.com/drive/v3/files/{id}?alt=media&access_token=...&supportsAllDrives=true` with expiry equal to the access-token expiry;
- OneDrive returns the provider's temporary `@microsoft.graph.downloadUrl`;
- the response is no-store/no-referrer and never logged;
- the TV assigns the URL directly to the image/video element;
- all range requests, seeking, buffering, and media bytes bypass Vercel.

## 10. Local TV watch history

Server history endpoints and the `watchHistory` Firestore collection leave the active application.

The TV stores resume state under:

```text
cloudframe.tv.watch-history.v1:{deviceId}
```

The value is a JSON object capped at 500 entries. Each entry is keyed by the stable pseudonymous media `id` returned in live browse DTOs and contains position, duration, completion, and update time. Sealed browse handles, provider IDs, provider access tokens, and temporary URLs are never stored.

The viewer updates local history:

- no more often than every 15 seconds during playback;
- on pause;
- on ended;
- before changing viewer item;
- when closing the viewer.

Writes are coalesced and tolerate quota/security errors. If `localStorage` is unavailable, playback continues and resume history is disabled for that browser session. Clearing TV browser data permanently removes local history. History does not appear in the admin panel and does not synchronize between televisions.

## 11. Rate limiting without Firestore

All Firestore `rateLimits` transactions are removed. Protection consists of:

1. Vercel's platform DDoS and global request controls;
2. strict body-size, batch-size, page-size, handle-expiry, and method validation in the API;
3. a best-effort fixed-window limiter in Vercel Runtime Cache using an HMAC of the request subject rather than storing raw IP addresses;
4. a minimum response delay after failed admin passphrase verification;
5. hard concurrency and retry limits for provider calls.

Runtime Cache rate counters are intentionally ephemeral. They protect the small private deployment without turning unauthenticated traffic into database cost. Authentication and authorization never fail open because a rate-limit cache entry is missing.

## 12. API and user-interface changes

### 12.1 Removed API behavior

- indexed-node home/folder browsing;
- manual source sync;
- scheduled source sync and reconciliation;
- sync health, crawl checkpoints, delta cursors, quotas, and index counts;
- server watch-history GET/PUT routes;
- Firestore-backed heartbeat/last-seen writes;
- raw node-ID thumbnail/media requests.

### 12.2 Retained or replaced behavior

- `/api/bootstrap` verifies a sealed device cookie against Vercel control state;
- `/api/tv/home` returns assigned root handles;
- `/api/tv/folders/{handle}` lists one provider folder page live;
- `/api/tv/thumbnail-urls` accepts signed handles and vends provider URLs;
- `/api/tv/media-url` accepts a signed handle and vends a direct provider URL;
- admin data loads through one `/api/admin/snapshot` response instead of three overlapping overview/settings/sources requests;
- admin source browsing remains live;
- choosing a root saves configuration immediately and does not launch indexing;
- source status is limited to connected, reauthorization required, disabled, or provider temporarily unavailable.

### 12.3 UI copy and states

Admin and TV copy must not mention indexing, syncing, reconciliation, storage quota, indexed items, or waiting for a collection to prepare.

The honest live states are:

- folder loading;
- empty provider folder;
- provider temporarily unavailable;
- provider throttled, with retry guidance;
- account reauthorization required;
- navigation expired, reload home;
- no roots assigned;
- local resume history unavailable.

## 13. Code and deployment changes

The implementation will:

- replace the broad Firestore repository with a focused control-plane mirror interface;
- add private Blob and Runtime Cache control stores;
- add sealed admin/device sessions, sealed browse handles/cursors, and stable pseudonymous item IDs;
- refactor browse/media services to consume live provider metadata;
- add a local TV history repository;
- remove `packages/indexer/`, `workflows/`, workflow build output, cron configuration, and workflow dependencies;
- remove node, watch-history, session, OAuth-state, and rate-limit collection code from active runtime;
- collapse Firestore indexes to an empty index set because the recovery document is accessed by exact path;
- update `PRODUCT.md`, `README.md`, `DESIGN.md`, and Firebase/Vercel operations documentation to state the corrected architecture;
- add `@vercel/functions` for Runtime Cache and `waitUntil()`;
- configure a private Vercel Blob store through OIDC/store ID or its server-only read-write token;
- add a versioned `CONTROL_PLANE_KEY_V1` secret separate from provider token keys.
- add a versioned `BROWSE_HANDLE_KEY_V1` and `BROWSE_ID_SECRET`, separate from cookie, CSRF, and control-plane keys.

The Vercel API remains pinned to `bom1`. Static TV/admin builds and Chromium 68 compatibility remain unchanged.

## 14. Migration and cutover

### 14.1 One-time migration

`scripts/migrate-vercel-control-plane.mjs` is dry-run by default. It reads only the current household, approved devices, pending requests, sources, and assigned roots needed for the compact document. It does not read the `nodes`, `watchHistory`, `rateLimits`, or workflow state collections.

Apply mode:

1. validates and converts the relevant current records;
2. excludes disabled legacy whole-drive roots unless they are explicitly enabled now;
3. writes the encrypted private Blob snapshot;
4. writes the one Firestore recovery document;
5. reads both copies back for checksum/revision verification;
6. prints only document revision and entity counts.

The production alias cannot move to the new API until migration apply has created and verified the private Blob snapshot. Preview/staging uses a separate household ID, Blob pathname, Runtime Cache key, encryption keys, and Firestore recovery document so a test deployment cannot overwrite production control state.

This one-time operation is allowed to exceed the steady-state daily read target because it is an explicit migration, not continuous product behavior.

### 14.2 Existing sessions

For a bounded cutover window, the API recognizes the legacy opaque cookie format. It performs the old Firestore session/device lookup once, issues a sealed version-2 cookie, and records no new legacy session state. Each current admin and TV browser pays this migration cost once. New sessions never use the compatibility path.

The compatibility path is removed after production verification confirms both active browsers hold version-2 cookies.

### 14.3 Legacy data retention

The deployment does not delete old collections or Google Cloud/Firebase projects. In particular, it leaves `nodes`, `watchHistory`, `rateLimits`, `adminSessions`, `deviceSessions`, `oauthStates`, source workflow fields, and workflow infrastructure data untouched.

After the new deployment is verified and backed up, deletion of legacy documents may be proposed as a separate, explicitly approved operation with an exact inventory and dry run.

## 15. Firestore budget contract

| Activity | Firestore reads | Firestore writes |
| --- | ---: | ---: |
| TV bootstrap with version-2 cookie | 0 | 0 |
| Open home or any folder page | 0 | 0 |
| Request thumbnails | 0 | 0 |
| Start, seek, or watch media continuously | 0 | 0 |
| Save or load resume history | 0 | 0 |
| Open or refresh admin panel | 0 | 0 |
| Runtime Cache miss/cold deployment | 0 | 0 |
| Routine access-token refresh | 0 | 0 |
| Device/source/root/settings mutation | 0 | 1 recovery mirror write |
| Refresh-token rotation | 0 | 1 recovery mirror write |
| Explicit restore from Firestore | 1 | 0 |
| One-time legacy session exchange | bounded legacy reads once | 0 |
| One-time migration | bounded migration reads once | 1 compact mirror write |

Automated budget tests must simulate at least 10,000 folder/media requests over 24 hours and assert that the Firestore mirror's read method is never called. Public API composition tests must fail if any handler receives a Firestore read-capable repository.

Production structured logs include secret-safe counters for private Blob reads, Runtime Cache hits/misses, Firestore mirror writes, mirror failures, and explicit restore reads. They never include document bodies or credential material.

## 16. Testing and acceptance

### 16.1 Unit and contract tests

- AES-GCM control-envelope round trip, key rotation, tamper rejection, and redaction;
- Blob ETag compare-and-swap and three-attempt conflict handling;
- Runtime Cache hit/miss behavior with no Firestore fallback;
- write-only Firestore mirror composition;
- explicit one-document restore behavior;
- sealed admin/device cookie expiry and version invalidation;
- signed handle device/root/source binding, expiry, and tamper rejection;
- provider cursor binding and OneDrive next-link validation;
- access-token refresh without Firestore calls;
- rotated refresh-token persistence through a control mutation;
- local history cap, throttling, corruption recovery, and storage-denied behavior;
- secret-safe logging and serialization.

### 16.2 Integration tests

- one approved TV browses Google and OneDrive folder pages from synthetic provider APIs;
- unassigned roots, forged handles, stale handles, revoked devices, and disabled sources fail closed;
- Google media response points to Google and no Vercel media proxy route exists;
- OneDrive media response points to Microsoft's pre-authorized URL;
- admin folder selection is immediately visible on TV without indexing;
- admin snapshot uses the active Vercel control store;
- 10,000 browse/playback operations cause zero Firestore reads;
- control mutation produces one Firestore recovery write and no read;
- provider outage never triggers a Firestore fallback.

### 16.3 Compatibility and production acceptance

- all unit, type, lint, build, Vercel Build Output API, TV bundle, and Chromium 68 checks pass;
- Playwright covers enrollment, approval, live browsing, local resume, source reconnect, and revocation;
- authenticated production browser verification confirms TV and admin load through the Vercel snapshot;
- Vercel logs show provider metadata requests but no media-byte proxying;
- Google and OneDrive playback seek successfully on the real TV;
- Cloud Monitoring shows no Firestore reads during a continuous browse/playback observation window;
- an explicit recovery drill restores the Vercel snapshot from the one Firestore document in an isolated staging environment.

## 17. Non-goals

- server-side media proxying, transcoding, or caching;
- provider file indexing, search, timelines, global descendant counts, or folder mosaics;
- cross-device watch-history synchronization;
- hard cryptographic restriction of a Google bearer token to assigned roots;
- multi-household tenancy;
- automatic deletion of legacy Firestore data or any Google Cloud project;
- adding Redis, Postgres, Firebase Authentication, Firebase Functions, Firebase Hosting, or Firebase Storage.

## 18. Success criteria

The correction is complete when:

1. no active TV/admin request path can read Firestore;
2. steady-state Firestore reads remain zero regardless of how long the TV browses or plays media;
3. the active Firestore model reads and writes only one compact recovery document for authorized devices, provider credentials, approved roots, and household configuration; retained legacy documents remain inert until separately approved cleanup;
4. Vercel lists provider metadata live and enforces current device/root configuration;
5. refresh tokens remain server-only;
6. the accepted Google access-token trade-off is implemented without Vercel media proxying;
7. OneDrive media also bypasses Vercel;
8. watch history persists locally on the TV and nowhere else;
9. indexing, workflows, sync state, Firestore rate limits, and server watch history are absent from the active application;
10. migration and production verification complete without deleting legacy data or cloud projects.
