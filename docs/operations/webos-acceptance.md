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
- Record first-page and nested-folder listing latency for each provider, including one page-boundary load.
- Traverse every grid edge with Up/Down/Left/Right, including an incomplete final row.
- Open nested folders, press Back, and verify the exact focused item and scroll position return.
- Open and close the Sources drawer with Menu and Back; focus must not leak or move to a manual-only control.
- Verify Home and breadcrumbs return to the expected collection and focus target.
- While a provider is unavailable, confirm a bounded provider error appears rather than a false empty folder.

## Direct provider media and viewer

Perform these checks once with Google Drive and once with OneDrive:

- Open an image, move Right to a video, and Left back to the image.
- Confirm the browser fetches media from the provider host rather than the Vercel application host.
- Play the video and seek forward/backward with LG playback keys; verify range seeking resumes playback at the selected position.
- Enter toggles image slideshow or video play/pause; Up opens details/filmstrip; Down closes it.
- Back returns focus to the exact grid card.
- Cause or wait for a media URL to expire, then confirm the TV requests one renewed URL and playback recovers without a loop.
- Confirm an unsupported codec produces a bounded error without crashing the shell.

Google's direct URL contains a short-lived access token as an accepted trade-off. Do not copy the URL into the acceptance record. Confirm Vercel application logs do not contain the URL, token, provider response body, or media bytes.

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
