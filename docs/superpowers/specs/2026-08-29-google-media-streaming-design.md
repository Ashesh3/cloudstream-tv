# Google Media Streaming Design

## Goal

Restore Google Drive image, video, and thumbnail playback on LG webOS while preserving current device, root, source, and credential authorization.

## Root cause

Google Drive rejects `files.get?alt=media&access_token=...` downloads with HTTP 403. The same file and token return HTTP 206 when the token is sent in `Authorization: Bearer`. Chromium 68 media elements cannot attach that header, so the previous direct Google URL contract cannot work.

Google thumbnails also used the forbidden query-token URL. A provider error for one visible item currently rejects the entire thumbnail batch with HTTP 502.

## Architecture

- `POST /api/tv/media-url` keeps its existing contract. OneDrive still returns its provider-signed direct URL. Google returns a short-lived, same-origin URL containing only the sealed browse handle.
- `POST /api/tv/media-url` exchanges the 30-minute browse handle for a dedicated 12-hour media handle. `GET /api/tv/google-media/:handle` authenticates the TV cookie, revalidates that media handle against the current assigned root and source, obtains current credentials, and requests Google Drive with `Authorization: Bearer`.
- The route forwards only a single valid `Range` header and safe conditional media headers. It streams Google's response body without buffering, storage, or transcoding.
- Google thumbnail vending uses Drive's `thumbnailLink`, normalized to the requested bounded size. The access token is never placed in a URL.
- Thumbnail item failures are isolated. Missing or rejected thumbnails become `unavailable`; authentication/navigation failures still fail closed for the whole request.

## Security boundaries

- No access token, refresh token, provider ID, provider URL, or response body is logged or returned in JSON.
- The Google media URL is same-origin, sealed for a 12-hour playback window, device-bound, source-bound, root-bound, and credential-version-bound.
- Every range request repeats application authorization. Revocation or root removal blocks the next request.
- Only GET and HEAD are accepted. Request bodies are rejected by method routing.
- Upstream headers are allowlisted. Hop-by-hop, cookie, authorization, and Google diagnostic headers are never reflected.
- Responses use `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.

## Compatibility and operations

- Native `<img>` and `<video>` elements continue receiving ordinary same-origin HTTPS URLs, so Chromium 68 needs no custom header API.
- OneDrive's working direct playback path remains unchanged.
- Google media bytes now transit the Vercel function and count toward transfer/runtime limits. This is the unavoidable compatibility cost of Google's header-only download contract.
- Streaming uses a dedicated high-volume per-device limiter instead of the URL-vending budget. The Vercel function still has a 300-second maximum duration, so live webOS acceptance must verify that long playback continues through browser range re-requests.

## Verification

- Provider tests prove Google thumbnails use `thumbnailLink` and media URLs contain no access token.
- Direct-media and HTTP tests prove Google receives a same-origin proxy URL while OneDrive remains direct.
- Streaming tests prove Range forwarding, 206/status/header preservation, no buffering, credential refresh on 401, and safe error normalization.
- Full tests, typecheck, lint, Vercel build, Chromium 68, deployment, and live production playback are required.
