# LG webOS acceptance

Automated compatibility proves the legacy bundle parses and stays within budgets; it is not real-TV proof. Production cutover remains blocked until a user performs this checklist on an LG webOS 5.0+ television.

## Before the run

1. Deploy the exact candidate commit to the dev preview.
2. Confirm `node scripts/check-tv-bundle.mjs` passes.
3. Confirm the TV has no previously approved Cloudframe cookie, or revoke the old device first.
4. Open the preview URL in the LG browser. Do not install a service worker or use Web Storage.

## Enrollment

- Enter a device name using the TV keyboard.
- Confirm the waiting screen remains stable for at least one poll cycle.
- On a phone, approve the request and assign one root.
- Confirm the TV becomes usable without a code, QR scan, or reload.
- Power-cycle/relaunch the browser and confirm the secure cookie restores access.

## Remote and focus

- Traverse every grid edge with Up/Down/Left/Right.
- Move across an incomplete final row and a pagination boundary.
- Open nested folders, go Back, and verify the exact item and scroll position restore.
- Open/close the hidden Sources drawer with Menu and Back; focus must not leak.
- Verify Home and breadcrumbs.

## Viewer

- Open an image, move Right to a video, and Left back to the image.
- Enter toggles image slideshow and video play/pause.
- Up opens details/filmstrip; Down closes it.
- Back returns to the exact grid card.
- Seek with the LG playback keys and verify resume after reopening.
- Confirm one failed/expired media URL is refreshed once, not looped.
- Confirm an unsupported codec shows a bounded error without crashing the shell.

## Security and revocation

- Reassign the device to a different root and confirm the removed root disappears on the next request.
- Revoke the TV and confirm its next authenticated request transitions to the revoked screen.
- Confirm provider URLs never appear in navigation history, referrers, application logs, or persisted browser storage.

## Performance record

Record TV model, webOS version, browser engine version, network, candidate commit, first focusable time, folder navigation latency, and any long input stalls. Target first focusable skeleton under 2 seconds warm and folder stability under 150 ms after indexed JSON arrives.

## Result

Mark **PASS** only when every item succeeds on the supported TV. Until then, report `REAL_WEBOS_ACCEPTANCE_PENDING`; desktop Chromium and synthetic Playwright evidence are not substitutes.
