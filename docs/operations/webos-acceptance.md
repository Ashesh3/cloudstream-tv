# LG webOS acceptance

Automated compatibility proves that the legacy bundle parses and stays within budgets; it is not real-TV proof. Mark production acceptance complete only after a user performs this checklist on a supported LG webOS 5.0+ television.

## Before the run

1. Deploy the exact candidate commit to an isolated preview using production build output, not an E2E build.
2. Confirm `node scripts/check-tv-bundle.mjs` passes.
3. Confirm `npm run check:chromium68` runs the legacy entry in pinned Chromium 68 snapshot revision `555668`.
4. Connect one Google Drive source and one OneDrive source, each with a small approved folder containing an image and seekable video.
5. Confirm the TV has no approved cookie, or revoke its old device first.
6. Record the test TV model, webOS/browser version, network, commit, deployment URL, and UTC start time.

## Enrollment and session

- Enter a device name using the TV keyboard.
- Confirm the waiting screen remains stable for at least one poll cycle.
- On a phone, approve the request and assign both provider roots.
- Confirm the TV becomes usable without a code, QR scan, or manual reload.
- Relaunch the browser and confirm the sealed cookie restores access.

## Live folder browsing, remote, and focus

- Open the Google root and the OneDrive root and confirm their current provider contents appear without a background refresh job.
- Confirm representative folder thumbnails appear where each provider supplies one; folders without a provider preview must keep the Cloudframe collection artwork.
- On a folder longer than one screen, begin scrolling immediately and confirm thumbnails are already present rather than appearing only after each row enters view.
- Pause before the first page boundary and confirm the next page arrives without moving the currently focused card. Continue to a later boundary and confirm proximity prefetch still avoids duplicate requests.
- Record first-page and nested-folder listing latency for each provider, including one page-boundary load.
- Traverse every grid edge with Up/Down/Left/Right, including an incomplete final row.
- Open nested folders, press Back, and verify the exact focused item and scroll position return.
- Open and close the Sources drawer with Menu and Back; focus must not leak or move to a manual-only control.
- Verify Home and breadcrumbs return to the expected collection and focus target.
- While a provider is unavailable, confirm a bounded provider error appears rather than a false empty folder.

## Direct provider media and viewer

Perform these checks on the exact candidate, recording secret-safe timestamps and outcomes:

- Open a full-size Google image, move Right to a known H.264/AAC MP4, and Left back to the image. Confirm both bodies come from `https://www.googleapis.com/drive/v3/files/...`, not Vercel.
- Confirm normal Google playback uses the exact raw Drive URL. For the legacy MPEG retry only, confirm the browser may use `/__cloudframe_media__/<session-id>/<sanitized-filename>` and that this alias is handled by the service worker rather than reaching Vercel.
- In the Google/network evidence, confirm playback and seeking receive successful HTTP `206` responses and that Range seeking resumes at the selected position.
- Open representative OneDrive image and video items and confirm their provider-signed Microsoft URLs, playback, seeking, and thumbnails remain unchanged.
- Confirm the Video.js 10 state/container wrapper initializes on the TV. If it cannot initialize, confirm the same native video still plays, pauses, seeks, resumes, and reports errors through Cloudframe controls.
- Enter toggles image slideshow or video play/pause; Up opens details/filmstrip; Down closes it.
- Back returns focus to the exact grid card.
- Cause or wait for one Google token to expire, then confirm the TV makes one new `/api/tv/media-url` descriptor request, renews the in-memory grant once, and restores playback and the prior resume position without a loop.
- Close and reopen the known MP4 after passing the resume threshold and confirm local resume still works after direct delivery.
- In Vercel logs, confirm descriptor calls to `/api/tv/media-url` and confirm there are no requests to `/api/tv/google-media/`. Logs must not contain the Google token, raw provider URL, provider ID, worker grant, or response body.

### Exact `MOV00516.MPG` result

- Play `MOV00516.MPG` and record separately whether the raw Google URL attempt succeeds and whether the one filename-alias attempt is used or succeeds.
- Confirm the filename attempt happens at most once and sends identical provider bytes and MIME type. It must not trigger remuxing, transcoding, caching, full-file buffering, or a Vercel media route.
- If either attempt fails before successful Google bytes arrive, record the precise worker, CORS, authorization, network, or HTTP transport failure.
- If both attempts receive successful `200` or `206` bytes and the native media element still fails to decode, record **exact decoder/container/profile limitation on this TV** rather than a transport failure. Do not claim that Cloudframe can make that exact bitstream playable without offline conversion or a native player.

## Local TV watch history

- Play a video beyond the resume threshold, close it, reopen it, and confirm the local resume position.
- Reload/relaunch the TV browser and confirm the same device resumes locally.
- Complete a video and confirm reopening starts from the beginning rather than the stored completed position.
- Clear the LG browser's site data, reopen Cloudframe, and confirm no prior watch history remains. Re-enrollment may be required because cookies are cleared too.
- Confirm history is not visible in the admin app and is not transferred to another TV.

## Storage-denied fallback on Chromium 68

Using a reproducible browser/site setting or a diagnostic preview that denies `localStorage`:

- Launch the actual legacy bundle in Chromium 68-compatible mode.
- Confirm browsing and playback continue.
- Confirm the UI reports local resume history unavailable without repeated prompts or crashes.
- Reload and confirm no resume position is expected or recovered.
- Restore normal storage before continuing the production candidate run.

## Security, assignment, and revocation

- Remove one assigned root and confirm it disappears on the TV's next protected request.
- Reassign a root and confirm it returns without re-enrollment.
- Revoke the TV and confirm its next authenticated request transitions to the revoked screen.
- Confirm provider URLs do not appear in navigation history, referrers sent to unrelated origins, Vercel application logs, or persisted browser storage. The active media element may temporarily hold the direct URL in memory.

## Performance and Firestore record

Record first-focusable time, Google/OneDrive folder latency, page-boundary latency, media-start latency, seeking behavior, expired-URL recovery, and any long input stalls. Target a first focusable skeleton under two seconds on a warm launch; provider folder latency depends on the provider/network and must be recorded rather than compared with old cached-metadata targets.

During a continuous browse/playback window after session migration, confirm Cloud Monitoring shows zero Firestore document reads. Do not perform admin mutations during that measurement; document any separately observed recovery mirror write.

## Result

Mark **PASS** only when every applicable item succeeds on the supported TV and attach secret-safe timestamps plus aggregate evidence. Otherwise report `REAL_WEBOS_ACCEPTANCE_PENDING` with the failed step. Desktop Chromium and synthetic Playwright results are not substitutes for the real-TV run.
