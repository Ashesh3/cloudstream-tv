# LG webOS TV 24 acceptance

Automated tests, the pinned Chromium 108 probe, and desktop Playwright are not real-TV proof. Mark acceptance complete only after a user performs this checklist on the configured household webOS TV 24 television with the exact candidate image.

## Record the candidate

- Image digest/tag, commit, TV model, webOS/browser version, network, public URL, and UTC start time.
- Passing `npm test`, `npm run typecheck`, `node scripts/check-tv-bundle.mjs`, `npm run check:chromium108`, and container smoke evidence.

## Fresh installation

- Start from an empty `/data`; obtain `CLOUDFRAME_SETUP_CODE` from logs and claim Admin.
- Connect or reconnect read-only Google Drive and OneDrive sources.
- Choose representative roots containing an image, H.264/AAC MP4, known MPEG such as `MOV00516.MPG`, and a long incompatible video.
- Pair the TV, approve it, assign both roots, and verify relaunch restores its sealed session.

## Browse and focus

- Browse both providers live, including a nested folder and a page boundary.
- Verify provider thumbnails, stable focus while pages extend, every grid edge, Back restoration, Home/breadcrumbs, and the Sources drawer.
- Manual-only controls must not receive initial or automatic remote focus.
- Provider failure must remain distinct from a genuinely empty folder.

## Direct playback and the real Video.js skin

- Open a Google/OneDrive image and a known H.264/AAC MP4.
- Confirm the supported TV shows the real Video.js `video-player` / `video-skin` controls and remote play/pause works.
- Confirm direct media and Range seeking use validated Google or Microsoft delivery rather than an HLS transcode.
- If the packaged skin cannot initialize, confirm the same native video has visible native controls and still supports play, pause, seek, resume, Back, and error feedback.

## MPEG and demand-paged HLS

- Open `MOV00516.MPG` or another known legacy MPEG source. Confirm the descriptor is HLS and playback begins as H.264/AAC.
- On a long incompatible source, seek at least 60 seconds beyond media already generated. Confirm a later segment window is requested and playback resumes at the target without downloading the whole file first.
- Pause, resume, and press Back. Confirm the HLS session is released and subsequent segment requests stop.
- Reopen the item and confirm cached complete segments can be reused.

## One-TV lease and direct-media independence

- While TV A owns an HLS transcode, use a second approved browser/device session to request a different incompatible video. Confirm it receives the explicit busy state.
- During the busy interval, verify compatible direct images and MP4 remain available as designed.
- Release/Back on TV A and confirm TV B can subsequently acquire the transcoder.

## Local history and restart

- Play past the resume threshold, Back, reopen, and confirm local TV watch history resumes.
- Complete a video and confirm reopening starts at the beginning.
- Restart the container between sessions. Confirm configuration, provider connections, device approval, and reusable cache remain available from `/data`.
- Clear TV site data and confirm local history disappears; re-enrollment may be required because cookies also clear.

## Revocation and source changes

- Remove an assigned root or source and confirm the next protected request stops new direct/HLS access.
- Revoke the television and confirm its next request transitions to the revoked screen.
- Confirm no further HLS heartbeat or segment request succeeds after the authorization change.

## Security and logs

- Inspect TV/Admin UI, browser storage, navigation history, and JSON logs.
- Confirm no OAuth token, provider URL, provider node ID, sealed handle, cookie, source capability, media body, or raw FFmpeg stderr appears.
- Admin diagnostics may show safe item/provider/device/stage/progress/cache/error truth only.

## Result

Mark **PASS** only when every applicable step succeeds and attach secret-safe timestamps plus aggregate request/status evidence. Otherwise report `REAL_WEBOS_ACCEPTANCE_PENDING` with the exact failed step.
