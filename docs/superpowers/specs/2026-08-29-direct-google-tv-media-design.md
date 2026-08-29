# Direct Google TV Media Design

## Status

Approved direction. This specification replaces Google media relay through Vercel with a browser-side authenticated transport for approved televisions.

## Goal

Deliver full-size Google Drive images and videos directly from Google to the LG webOS television without sending media bytes through Vercel. Preserve native playback, seeking, URL renewal, local resume history, and the best available no-transcode path for legacy `.mpg` media such as `MOV00516.MPG`.

OneDrive media and provider thumbnail URLs remain direct as they are today.

## Established facts

- The current `/api/tv/google-media/:handle` URL is a sealed, device-bound media handle. Vercel opens it, reauthorizes the device and assigned root, adds Google's bearer header, forwards ranges, and relays the response body.
- Production evidence for the reported playback attempt shows `POST /api/tv/media-url` succeeded and the subsequent Google-media request returned HTTP `206`. The television raised media error code `4` after successful delivery.
- The prior direct Google query-token form returned HTTP `403`, while the same Drive request with `Authorization: Bearer` returned HTTP `206`. Returning `alt=media&access_token=...` is therefore not a viable fallback.
- Google's Drive endpoint accepts CORS preflight requests from `https://tv.ashesh.dev` containing `Authorization` and `Range`.
- A throwaway test on the repository's pinned Chromium 68 revision `555668` proved that a service worker can intercept a media element request, attach a bearer token, forward `Range: bytes=0-`, rebuild the response, and let the native media element load metadata successfully.
- Google's CORS preflight rejects `If-Range`. The direct bridge must not forward that header.
- LG's webOS 5 AV table lists `.mpg`, `.mpeg`, and `.dat` with MPEG-1 or MPEG-2 video and MPEG Layer I, II, or III audio. Exact encoder settings, audio codecs, and the browser media pipeline can still make an individual file unsupported.

## Chosen architecture

`POST /api/tv/media-url` remains the authorization boundary. For Google items it returns the validated raw Drive media URL and the current short-lived bearer credential. The approved TV installs a small classic service worker that owns Google media transport. The service worker adds the bearer header and fetches the bytes directly from Google; Vercel is not in the body path.

The normal Google playback source is the raw URL itself:

```text
https://www.googleapis.com/drive/v3/files/<provider-node-id>?alt=media&supportsAllDrives=true
```

The service worker intercepts that cross-origin request only after the page has registered an exact URL-to-credential grant. It reconstructs a response for the native `<img>` or `<video>` element using Google's stream and an allowlist of media headers.

For legacy MPEG candidates, a single compatibility retry may use a service-worker-only same-origin alias ending in the sanitized original filename, for example:

```text
https://tv.ashesh.dev/__cloudframe_media__/<session-id>/MOV00516.MPG
```

That alias never reaches the Vercel function. The worker maps it to the same raw Google URL and bearer credential. Its purpose is to give extension-sensitive LG media selection one native retry; it does not alter, buffer, remux, or transcode the file.

## Media descriptor contract

The shared media response becomes an explicit transport union.

```ts
type DirectMediaUrlResponse =
  | {
      itemId: string;
      kind: "image" | "video";
      transport: "direct";
      url: string;
      expiresAt: string;
      revision: string | null;
    }
  | {
      itemId: string;
      kind: "image" | "video";
      transport: "google-bearer";
      url: string;
      authorization: {
        scheme: "Bearer";
        token: string;
      };
      expiresAt: string;
      revision: string | null;
    };
```

- OneDrive returns `transport: "direct"` and keeps its current provider-signed URL behavior.
- Google returns `transport: "google-bearer"`, the exact validated Drive `alt=media` URL, and the current access token.
- `expiresAt` is the access-token expiry, not an invented media-URL lifetime.
- Responses remain `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
- The TV decoder strictly validates the union, Google hostname, path, exact query keys, bearer scheme, bounded token text, expected item ID, expected media kind, and future expiry.
- Provider IDs and the bearer token are deliberately exposed to the approved TV under the user's stated trust model. They remain absent from logs, persistent storage, navigation history, error text, and telemetry.

## Service-worker bridge

The bridge is a standalone classic worker compiled for Chromium 68 and registered at root scope before Google media playback begins.

### Grant lifecycle

1. The viewer requests a media descriptor from the existing authenticated API.
2. For `google-bearer`, the page validates the descriptor and creates a random in-memory media-session ID.
3. The page posts an exact grant to the active worker: session ID, raw URL, bearer token, expiry, media kind, MIME type, and sanitized filename.
4. The worker validates the raw URL again, stores a bounded memory-only grant, and acknowledges it.
5. Only after the acknowledgement does the page set the `<img>` or `<video>` source.
6. Closing or replacing the media item revokes its grant. The worker also expires grants by time and caps the registry to the active item plus bounded adjacent prefetches.

Neither the page nor the worker writes bearer credentials to `localStorage`, IndexedDB, Cache Storage, cookies, URLs, or build assets.

### Worker restart recovery

Service workers may be terminated between range requests. If a fetch arrives without a grant, the worker broadcasts a bounded credential request containing only the media-session ID or exact URL fingerprint. A controlled Cloudframe client may re-send a still-live in-memory grant. The fetch waits for that response for a short bounded interval and otherwise fails closed.

This recovery permits a worker restart during playback without persisting the token. It cannot recover after the Cloudframe page itself has closed, which is acceptable because no active media element remains.

### Fetch behavior

The worker intercepts only:

- an exact registered `https://www.googleapis.com/drive/v3/files/<id>` URL whose query contains exactly `alt=media` and `supportsAllDrives=true`; or
- an exact registered `/__cloudframe_media__/<session-id>/<filename>` alias.

For an accepted request it:

- accepts only `GET` or `HEAD`;
- creates a new CORS request to the registered raw URL;
- adds exactly `Authorization: Bearer <token>`;
- forwards at most one syntactically valid single-byte `Range` header;
- deliberately drops `If-Range` because Google rejects that CORS preflight;
- does not forward cookies, referrers, arbitrary request headers, or credentials;
- follows Google's normal redirect behavior inside the browser fetch;
- reconstructs a new response using the upstream stream without reading it into memory;
- forwards only `Accept-Ranges`, `Content-Length`, `Content-Range`, `Content-Type`, `ETag`, and `Last-Modified` when CORS exposes them;
- preserves the safe upstream status, including `200`, `206`, and `416`;
- never caches, buffers, persists, transforms, remuxes, or transcodes the body.

Requests that do not exactly match a live grant pass through normally. Requests under the reserved same-origin alias without a live worker grant receive no media fallback from Vercel.

## Viewer integration

- Direct OneDrive sources continue to enter native image and video elements unchanged.
- Google sources are prepared through a `GoogleMediaBridge` before their source is assigned.
- Native `<video src>` remains the decoder. Video.js continues to provide the state/container boundary and Cloudframe keeps its own remote controls.
- The video element uses `Referrer-Policy: no-referrer`.
- Google full-size images use the same bridge. Google and OneDrive thumbnails keep their existing direct provider URLs and never use the worker bridge unless a future provider contract requires authorization.
- Existing URL expiry timers, one-renewal retry ledger, resume timestamp restoration, adjacent image prefetch, cancellation, and device-unauthorized behavior remain intact.

## Legacy MPEG compatibility

Cloudframe cannot manufacture decoder support by changing transport. The compatibility sequence is therefore bounded and evidence-driven:

1. Attempt the raw Google URL through the bearer bridge and native video element.
2. If the item is a legacy MPEG candidate (`video/mpeg` or `.mpg`, `.mpeg`, or `.dat`), the worker reported a successful `200` or `206`, and the media element still reports code `4`, retry exactly once through the filename-preserving worker alias.
3. If the alias also receives successful bytes but the media element still fails, classify the result as a genuine TV decoder/container/profile failure. Do not request another URL repeatedly.

The retry sends the identical bytes and MIME type. It exists only for extension-sensitive LG decoder selection. Client-side ffmpeg, WebAssembly transcoding, full-file blobs, and server-side transcoding are excluded because they are unsuitable for the target TV's CPU, memory, startup time, and seek behavior.

Real-device acceptance for `MOV00516.MPG` determines whether its exact MPEG video/audio profile is supported by the target LG browser. If both native attempts fail after confirmed `206` delivery, the constraints “browser only,” “original bytes,” and “must play this exact unsupported bitstream” cannot all be satisfied simultaneously; the accurate fallback is offline conversion or a packaged/native player, not hidden Vercel transcoding.

## Error classification and UI

HTML media error code `4` alone no longer means “unsupported codec.” The page correlates media-element failure with bridge evidence:

- no worker control or grant acknowledgement: **Direct Google playback is unavailable on this browser**;
- CORS, network, or non-success Google response: **The Google media link could not be opened**;
- `401` or `403`: request one fresh descriptor and resume once; if already renewed, report source authorization failure;
- worker-confirmed `200` or `206` followed by both failed MPEG native attempts: **This file reached the TV, but its video or audio format could not be decoded**;
- non-MPEG worker-confirmed delivery followed by code `4`: the same decoder-focused message without offering the filename retry.

Errors never display the token, provider node ID, raw URL, worker grant, or response body. “Try fresh URL” appears only when renewal can plausibly change the outcome; it is not offered for a confirmed decoder failure.

## Authorization trade-off

Vercel still authorizes the device, assigned root, source, and browse handle before vending a descriptor. After vending, the Google access token is held by the approved TV and authorizes Google requests until it expires.

Consequences accepted by this design:

- device revocation or root removal prevents new descriptors immediately but cannot revoke an already-vended Google access token;
- the token carries the connected source's Drive read-only scope rather than a file-only capability;
- a compromised approved TV session could extract that short-lived token.

The exposure window is bounded by Google's token expiry and memory-only handling. This weaker post-vending revocation boundary is the explicit cost of keeping private Google media bytes completely off Vercel.

## Removed server path

After the bridge is verified:

- remove `/api/tv/google-media/:handle` from the HTTP application and deployment contract;
- remove the dedicated Google streaming rate limiter;
- remove the 12-hour media-handle codec and its key usage if no other consumer remains;
- remove upstream body relay, range-response reconstruction, and proxy-specific tests from the server;
- stop accepting relative Google-media URLs in the TV API decoder;
- update product, design, operations, and webOS acceptance documentation to state that both providers deliver media bytes directly.

The control API continues vending metadata and credentials through small JSON responses. No Vercel redirect or rewrite carries media or image bodies.

## Verification

### Automated contracts

- Provider tests prove Google produces the exact authenticated Drive request and OneDrive remains unchanged.
- Direct-media tests prove authorization happens before the Google token is returned, the descriptor contains the validated raw URL, expiry is preserved, and no sealed Google media handle is created.
- HTTP tests prove the removed Google-media route is `404`, media descriptors are no-store, and tokens or provider URLs never enter telemetry or normalized errors.
- TV decoder tests strictly accept the new transport union and reject malformed URLs, extra query keys, bad schemes, control characters, expired tokens, unexpected item IDs, and unexpected kinds.
- Bridge unit tests cover grant validation, acknowledgement, bounded expiry, revocation, worker restart rehydration, URL matching, header filtering, range validation, status/header reconstruction, and secret-safe errors.
- Viewer tests cover raw Google playback, direct OneDrive playback, full-size Google images, one MPEG filename retry, renewal/resume, and correct transport-versus-decoder copy.
- End-to-end tests assert that no image or video request reaches `/api/tv/google-media/` and no provider body is fetched by application code outside the service worker.

### Chromium 68 proof

Extend the pinned Chromium 68 check with a local cross-origin media server. The test must prove:

- the service worker controls the page before source assignment;
- a native media element requests `Range: bytes=0-`;
- the worker intercepts the cross-origin raw media URL;
- the upstream receives the expected bearer token and range;
- the reconstructed `206` response loads native media metadata;
- the filename alias follows the same direct upstream path;
- no request under the alias reaches the application server.

### Repository verification

Run the focused suites followed by:

```text
npm test
npm run typecheck
npm run lint
npm run build:vercel
npm run check:chromium68
```

### Real LG acceptance

On the target approved LG webOS television:

- play and seek a known Google H.264/AAC MP4;
- open a full-size Google image;
- verify OneDrive image/video behavior is unchanged;
- play `MOV00516.MPG` and record whether the raw URL or filename alias succeeds;
- verify remote play, pause, seek, back, and local resume behavior;
- expire or renew one Google token and verify the single recovery path;
- confirm Vercel logs contain descriptor calls but no `/api/tv/google-media/` requests during playback;
- confirm Google media and full-image bytes do not contribute to Vercel transfer.

Production acceptance remains pending until the exact MPEG file plays on the real target or is conclusively identified as unsupported by that browser's decoder.

## Non-goals

- Server-side transcoding, remuxing, caching, or media storage.
- Client-side full-file download or WebAssembly transcoding.
- Returning the rejected `access_token` query form.
- Changing OneDrive direct downloads or current provider thumbnail delivery.
- Persisting provider credentials on the television.
- Guaranteeing playback for codecs or profiles the target LG browser cannot decode.
