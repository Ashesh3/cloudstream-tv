# Cloudframe Infinity Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce and deploy an immutable Cloudframe container at `https://tv.ashesh.dev` with the required signed-out Admin behavior, OAuth configuration errors, approved-registry clean build, persistent data safety, Cloudflare Tunnel routing, and live validation.

**Architecture:** Patch the current `origin/master` source in an isolated worktree with regression-first changes. Build one Linux container from the repository using only the approved Microsoft registry, transfer the immutable image to Infinity, run it on loopback with a root-owned environment file and persistent `/data`, and route the existing Cloudflare Tunnel hostname directly to the private listener.

**Tech Stack:** TypeScript, React, Vitest, Node.js 24, Docker, FFmpeg, SQLite, Cloudflare Tunnel.

**Spec:** User-provided deployment and validation contract in task `01a05c69-26f5-74f2-998f-b86aa1c5eefc`.

## Global Constraints

- Base source is `origin/master` at `c473abe`; do not assume warned fixes are committed.
- Never print or commit OAuth secrets, administrator credentials, cookies, tokens, provider URLs, or the master key.
- Use only `https://packagefeedproxy.microsoft.io/npm/` for the reproducible container dependency install.
- Deploy only production `build/self-hosted`, never E2E output.
- Preserve and back up the complete stopped production `/data`; never reinitialize or replace existing production data.
- Run Cloudframe as UID/GID `10001`, listening privately on `127.0.0.1:8080`.
- Retain the prior image and stopped-data backup for rollback; do not prune unrelated Docker resources.

---

### Task 1: Signed-out Admin bootstrap

**Files:**
- Modify: `apps/admin/src/app.tsx`
- Test: `apps/admin/src/app.test.tsx`

- [ ] Add a regression that returns `ADMIN_UNAUTHORIZED` from the initial configured-installation snapshot and expects the Household admin passphrase form without the installation-status error.
- [ ] Run the focused test and confirm it fails for the current bootstrap behavior.
- [ ] Treat initial snapshot 401 as the configured, signed-out state while preserving non-401 installation errors.
- [ ] Run the focused Admin tests and confirm they pass.

### Task 2: OAuth provider-not-configured contract

**Files:**
- Modify: `packages/server/src/services/control-oauth.ts`
- Modify: `packages/server/src/http/control-app.ts`
- Modify: `apps/admin/src/api/client.ts`
- Test: corresponding service, HTTP, and Admin client tests.

- [ ] Add failing tests for provider `PROVIDER_NOT_CONFIGURED` mapping to application code `OAUTH_PROVIDER_NOT_CONFIGURED`.
- [ ] Add failing HTTP coverage for status 503 and the server-safe message.
- [ ] Add failing Admin-client coverage for the actionable administrator message.
- [ ] Implement the minimal service, HTTP, and client mappings.
- [ ] Run the focused tests and confirm they pass.

### Task 3: Approved-registry container build

**Files:**
- Modify: `Dockerfile`
- Modify: `.dockerignore`
- Modify: `apps/tv/package.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/container-contract.test.ts` and workspace/dependency contract tests as applicable.

- [ ] Add failing contract checks for the theme manifest copy, registry selection, and `.docker-tls` exclusion.
- [ ] Pin `@videojs/html` to `10.0.0-beta.31`.
- [ ] Constrain the CSS syntax package to proxy-available `1.1.8` and regenerate the lockfile through the approved registry.
- [ ] Ensure every lockfile artifact used by the container resolves through the approved registry and `npm ci` succeeds from a clean context.
- [ ] Run a clean Docker build and container smoke test without public-npm fallback.

### Task 4: Immutable source and image verification

- [ ] Inspect the complete diff and confirm it contains only intended files.
- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:server`, `node scripts/check-tv-bundle.mjs`, `npm run check:chromium108`, `npm run docker:build`, and `npm run test:container`.
- [ ] Commit the verified source and tag the image with the full commit SHA.
- [ ] Record the image ID and content digest.

### Task 5: Production safety and deployment

- [ ] Inspect Infinity for any existing Cloudframe container, image, source checkout, credential file, and persistent `/data` mount.
- [ ] Verify complete Google and OneDrive OAuth pairs and exact callback registration without exposing values.
- [ ] Stop Cloudframe cleanly if present, create a complete stopped-data backup, verify ownership and backup contents, and retain the previous image.
- [ ] Transfer or build the immutable candidate, create root-only deployment configuration, and start one hardened container against the preserved `/data` mount.
- [ ] Wait for loopback health and readiness before routing public traffic.

### Task 6: Cloudflare Tunnel and live acceptance

- [ ] Configure `tv.ashesh.dev` on the installed Cloudflare Tunnel to `http://127.0.0.1:8080` without path rewrites.
- [ ] Verify public `/healthz` and `/readyz` return 200 with a trusted certificate.
- [ ] Verify a fresh browser shows Household admin and omits Installation status unavailable.
- [ ] Complete installation claim if this is a fresh `/data`, then verify administrator login and saved state.
- [ ] Verify Google Drive and OneDrive consent/callback/source creation, folder browsing, and root selection.
- [ ] Smoke-test direct media and HLS/transcoded media when available.
- [ ] Inspect application, connector, and edge responses for 404/502 failures and secret leakage.
- [ ] Report the deployed commit/image, backup location, commands, live results, and remaining issues with secrets redacted.
