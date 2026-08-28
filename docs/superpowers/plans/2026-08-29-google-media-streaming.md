# Google Media Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace broken Google query-token URLs with authenticated same-origin streaming and resilient Google thumbnails.

**Architecture:** Keep OneDrive direct. Google media JSON responses point to a device-bound `/api/tv/google-media/:handle` route; that route reauthorizes and streams Drive with a bearer header and Range support. Google thumbnails use `thumbnailLink`, and per-item thumbnail failures degrade safely.

**Tech Stack:** TypeScript 5.9, Vercel Web Functions, Fetch streams, Preact/Vite, Vitest, Chromium 68.

**Spec:** `docs/superpowers/specs/2026-08-29-google-media-streaming-design.md`

## Global Constraints

- Preserve LG webOS 5+ / Chromium 68 compatibility.
- Preserve OneDrive direct playback.
- Never expose or log Google access tokens or provider IDs.
- Do not buffer, cache, persist, or transcode Google media.
- Reauthorize every Google media request against current device/root/source state.

---

### Task 1: Correct provider URL contracts

**Files:**
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/google-drive.ts`
- Test: `tests/provider-contract.test.ts`

- [ ] Write failing tests that Google thumbnails return a normalized `thumbnailLink` and Google media descriptors contain no query token.
- [ ] Run the focused provider tests and confirm the expected failures.
- [ ] Add a provider media descriptor that carries the authenticated Drive URL server-side and normalize Google `thumbnailLink` safely.
- [ ] Run the provider tests and typecheck.

### Task 2: Produce authorized proxy URLs and resilient thumbnail batches

**Files:**
- Modify: `packages/server/src/services/direct-media.ts`
- Test: `tests/direct-media.test.ts`

- [ ] Write failing tests for same-origin Google proxy URLs, unchanged OneDrive URLs, and per-item thumbnail failure isolation.
- [ ] Run the focused direct-media tests and confirm the failures.
- [ ] Build Google proxy URLs from the already-authorized sealed handle without exposing credentials.
- [ ] Catch non-auth provider thumbnail failures per item and return `unavailable`.
- [ ] Run the direct-media suite and typecheck.

### Task 3: Stream Google media through the authenticated HTTP boundary

**Files:**
- Modify: `packages/server/src/services/direct-media.ts`
- Modify: `packages/server/src/http/control-app.ts`
- Test: `tests/control-http-app.test.ts`

- [ ] Write failing HTTP tests for GET/HEAD, Range forwarding, 206/header/body streaming, invalid ranges, revocation, refresh-on-401, and secret-safe errors.
- [ ] Run the focused HTTP tests and confirm the failures.
- [ ] Add `/api/tv/google-media/:handle`, authorize the TV and handle, acquire credentials, and fetch Drive with a bearer header.
- [ ] Stream the body and allowlist response headers without exposing provider details.
- [ ] Run focused HTTP/direct-media tests and typecheck.

### Task 4: Update deployment contracts and documentation

**Files:**
- Modify: `README.md`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `docs/operations/firebase-vercel-setup.md`
- Modify: `docs/operations/webos-acceptance.md`
- Modify: `docs/superpowers/specs/2026-08-27-vercel-control-plane-design.md`
- Test: `tests/config.test.ts`
- Test: `tests/workspace.test.ts`

- [ ] Replace obsolete query-token/no-proxy claims with the bounded Google-only streaming contract.
- [ ] Assert the route remains inside the single Vercel API function and OneDrive stays direct.
- [ ] Run configuration, workspace, and operations tests.

### Task 5: Verify, merge, deploy, and live-test

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build:vercel`.
- [ ] Run `npm run check:chromium68`.
- [ ] Create and merge a PR after CI passes.
- [ ] Deploy production and verify Google image, video, Range seeking, thumbnails, and OneDrive regression behavior.
