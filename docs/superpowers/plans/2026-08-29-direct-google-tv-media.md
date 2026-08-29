# Direct Google TV Media Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send Google Drive image and video bytes directly from Google to an approved LG webOS television, preserve native Range playback and resume behavior, and give legacy MPEG files one filename-sensitive native retry without Vercel proxying or transcoding.

**Architecture:** `POST /api/tv/media-url` returns either an unchanged direct provider URL or a validated Google Drive URL plus its short-lived bearer token. A fixed-name, root-scoped classic service worker attaches the token and forwards media Range requests from the television directly to Google, while a page-side bridge owns grants and credentials only in memory. The viewer receives only prepared source URLs and delivery evidence, uses the raw Google URL first, and retries a confirmed-delivered legacy MPEG exactly once through a same-origin filename alias handled entirely by the worker.

**Tech Stack:** TypeScript 5.9, Preact 10, Vite 8, esbuild 0.28, Fetch/Service Worker APIs, Video.js 10 state/container elements, Vitest 4, Playwright 1.62, Vercel Web Functions, pinned Chromium 68 revision `555668`.

**Spec:** `docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md` (approved content is the blob at commit `3267e54`; current `master` commit `54621ee` reverted that file, so Task 1 restores the exact approved blob without reverting unrelated history).

## Global Constraints

- Execute in an isolated worktree created from the intended integration base; do not implement directly in a dirty shared checkout.
- Preserve LG webOS 5+ and Chromium 68 compatibility. The worker must be a classic script with no syntax newer than Chromium 68.
- Google full-size image and video response bodies must travel Google → TV. Vercel may return only bounded JSON control data.
- Never use `access_token` in the Google media query string; the observed query-token request returned `403`.
- Never proxy, cache, buffer, persist, remux, or transcode provider media bodies.
- Preserve OneDrive direct media URLs and existing direct provider thumbnail URLs.
- Keep Google bearer tokens out of URLs, DOM attributes, reducer state, localStorage, IndexedDB, Cache Storage, cookies, logs, telemetry, exceptions, and error copy.
- The approved TV may hold the short-lived Google access token in page and service-worker memory. This is the explicit authorization trade-off approved in the spec.
- Forward only `Authorization` and one valid single-byte `Range` header to Google. Drop `If-Range`; Google's CORS preflight rejects it.
- Keep manual-only controls out of initial and automatic TV focus.
- Preserve URL renewal, local resume history, remote play/pause/seek/back behavior, slideshow behavior, and adjacent image prefetch.
- A confirmed decoder failure must not offer a useless “Try fresh URL” action.
- Preserve all unrelated untracked `.agents`, `.codex`, and `.impeccable` content.

## File Structure

### New files

- `docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md` — restored approved architecture and acceptance contract.
- `apps/tv/src/api/media-response.ts` — strict decoder for the direct versus Google-bearer response union.
- `apps/tv/src/api/media-response.test.ts` — adversarial descriptor decoding tests.
- `apps/tv/src/media/google-media-protocol.ts` — message types, exact URL validation, fingerprinting, Range validation, filename sanitization, and alias construction shared by page and worker code.
- `apps/tv/src/media/google-media-protocol.test.ts` — pure protocol validation tests.
- `apps/tv/src/media/google-media-worker-runtime.ts` — testable service-worker grant registry and fetch interception runtime.
- `apps/tv/src/media/google-media-worker-runtime.test.ts` — worker grant, restart, Range, response reconstruction, and secret-safety tests.
- `apps/tv/src/media/google-media-worker.ts` — minimal classic-worker entrypoint.
- `apps/tv/src/media/google-media-bridge.ts` — page-side lazy registration, grant lifecycle, evidence registry, rehydration, and release API.
- `apps/tv/src/media/google-media-bridge.test.ts` — fake ServiceWorkerContainer tests for the page bridge.
- `scripts/build-tv-media-worker.mjs` — esbuild step producing `/cloudframe-media-sw.js` as a fixed-name Chromium 68 classic worker.

### Modified files

- `packages/shared/src/api.ts` — explicit `DirectMediaUrlResponse` transport union.
- `packages/server/src/services/direct-media.ts` — vend Google bearer descriptors and remove Google body relay.
- `packages/server/src/http/control-app.ts` — remove `/api/tv/google-media/:handle` and the `media-stream` limiter.
- `packages/server/src/index.ts` — stop exporting the media-handle codec.
- `deploy/api-entry.ts` — stop constructing media handles and stop injecting provider fetch into direct media.
- `apps/tv/src/api/client.ts` — delegate media decoding to `media-response.ts`.
- `apps/tv/src/main.tsx` — construct the production bridge and inject it into `TvApp`.
- `apps/tv/src/app.tsx` — pass the bridge through the ready browser shell to `Viewer`.
- `packages/tv-core/src/viewer.ts` — track prepared source kind and one compatibility-source substitution without storing credentials.
- `apps/tv/src/components/viewer.tsx` — prepare/release Google grants, correlate bridge evidence, preserve renewal/resume, and drive the MPEG alias retry.
- `apps/tv/src/components/video-player.tsx` — apply `Referrer-Policy: no-referrer` to native video and reload prepared sources cleanly.
- `apps/tv/src/components/image-viewer.tsx` — continue using the prepared source and report bridge-aware failures.
- `apps/tv/package.json` — run the fixed worker build after the Vite build.
- `scripts/check-tv-bundle.mjs` — parse and budget the classic worker.
- `scripts/check-chromium68.mjs` — exercise the real built worker with a cross-origin authenticated Range server.
- `deploy/vercel-build-contract.json` — apply a revalidating browser cache policy to the fixed service-worker filename before the SPA fallback.
- `tests/provider-contract.test.ts` — retain exact Google bearer request and direct OneDrive contracts.
- `tests/direct-media.test.ts` — assert Google token descriptor vending and no media-handle minting.
- `tests/control-http-app.test.ts` — assert the proxy route is absent and only URL vending is rate-limited.
- `tests/helpers/api.ts` — remove media-handle construction and relay-only provider-fetch plumbing.
- `apps/tv/src/app.test.tsx` — update API fixtures and TV-app dependency injection.
- `apps/tv/src/components/viewer.test.tsx` — cover bridge preparation, release, renewal, images, video, MPEG retry, and error copy.
- `e2e/fixtures.ts` — add `transport: "direct"` to the synthetic provider descriptors.
- `e2e/browse-viewer.spec.ts` — assert playback never requests `/api/tv/google-media/`.
- `tests/config.test.ts` — assert the worker is included in Vercel static output.
- `tests/workspace.test.ts` — assert the relay and media-handle runtime are absent and the approved spec is present.
- `tests/design-materials.test.ts` — require browser-side authenticated direct delivery language instead of Vercel authenticated streaming.
- `README.md`, `PRODUCT.md`, `DESIGN.md`, `docs/operations/firebase-vercel-setup.md`, and `docs/operations/webos-acceptance.md` — document the active direct-delivery contract and its authorization trade-off.
- `docs/superpowers/specs/2026-08-27-vercel-control-plane-design.md` — update the control-plane media boundary.
- `docs/superpowers/specs/2026-08-29-google-media-streaming-design.md` and `docs/superpowers/plans/2026-08-29-google-media-streaming.md` — mark the Vercel-relay design and plan superseded.

### Deleted files

- `packages/server/src/auth/media-handles.ts` — relay-only 12-hour media handle.
- `tests/media-handles.test.ts` — relay-only codec tests.

---

### Task 1: Restore the approved design source

**Files:**
- Create: `docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md`
- Modify: `tests/workspace.test.ts`

**Interfaces:**
- Consumes: approved Git blob `3267e54:docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md`.
- Produces: the on-branch spec path referenced by every later task and final documentation tests.

- [ ] **Step 1: Write the failing workspace test**

Add this test to `tests/workspace.test.ts`:

```ts
it("keeps the approved direct Google TV media design in the repository", async () => {
  const spec = await readFile(
    "docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md",
    "utf8",
  );

  expect(spec).toContain("directly from Google to the LG webOS television");
  expect(spec).toContain("service worker");
  expect(spec).toContain("MOV00516.MPG");
  expect(spec).not.toContain("alt=media&access_token=");
});
```

- [ ] **Step 2: Run the test and verify the missing-spec failure**

Run:

```powershell
npx vitest run tests/workspace.test.ts
```

Expected: FAIL with `ENOENT` for `docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md`.

- [ ] **Step 3: Restore the exact approved blob without reverting history**

Read the immutable source:

```powershell
git show 3267e54:docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md
```

Use `apply_patch` to add that exact 238-line blob at the same path. Do not run `git revert 54621ee`, cherry-pick the old commit, or modify any unrelated file from the old branch.

- [ ] **Step 4: Run the focused test**

Run:

```powershell
npx vitest run tests/workspace.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md tests/workspace.test.ts
git commit -m "Restore direct Google TV media design"
```

---

### Task 2: Define and vend the explicit media transport union

**Files:**
- Modify: `packages/shared/src/api.ts:104-110`
- Modify: `packages/server/src/services/direct-media.ts:42-82,535-632`
- Modify: `apps/tv/src/api/client.ts:1-18,158-167,398-407`
- Create: `apps/tv/src/api/media-response.ts`
- Create: `apps/tv/src/api/media-response.test.ts`
- Modify: `tests/direct-media.test.ts:33-98,380-396`
- Modify: `tests/provider-contract.test.ts:298-339,791-840`
- Modify: `apps/tv/src/app.test.tsx:850-940`
- Modify: `apps/tv/src/components/viewer.test.tsx:697-760`
- Modify: `e2e/fixtures.ts:65-100`

**Interfaces:**
- Consumes: provider `TemporaryUrl | AuthenticatedMediaRequest` and already-authorized `AuthorizedBrowseItem`.
- Produces: `DirectProviderMediaUrlResponse`, `GoogleBearerMediaUrlResponse`, `DirectMediaUrlResponse`, and `decodeDirectMediaUrlResponse(value, expected)`.

- [ ] **Step 1: Write failing shared/server/client contract tests**

In `tests/direct-media.test.ts`, replace the Google proxy expectation with:

```ts
it("returns the validated raw Google URL and short-lived bearer credential", async () => {
  const harness = createHarness();
  const result = await harness.media.media(
    harness.auth(),
    harness.handle("source-google", "root-google", "google-video", "video"),
  );

  expect(result).toMatchObject({
    itemId: harness.itemId("source-google", "google-video"),
    kind: "video",
    transport: "google-bearer",
    url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
    authorization: { scheme: "Bearer", token: "access-token" },
    expiresAt: harness.expiry.toISOString(),
    revision: null,
  });
  expect(result.url).not.toContain("access_token");
});
```

Keep the OneDrive test explicit:

```ts
expect(result).toMatchObject({
  transport: "direct",
  url: "https://public.dm.files.1drv.com/download?capability=1",
});
expect(result).not.toHaveProperty("authorization");
```

Create `apps/tv/src/api/media-response.test.ts` with these cases:

```ts
import { describe, expect, it } from "vitest";
import { decodeDirectMediaUrlResponse } from "./media-response";

const expiresAt = new Date(Date.now() + 60_000).toISOString();

describe("TV media response decoder", () => {
  it("accepts an exact Google bearer descriptor", () => {
    expect(decodeDirectMediaUrlResponse({
      itemId: "item_video",
      kind: "video",
      transport: "google-bearer",
      url: "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
      authorization: { scheme: "Bearer", token: "ya29.test-token" },
      expiresAt,
      revision: null,
    }, { itemId: "item_video", kind: "video" })).not.toBeNull();
  });

  it.each([
    ["token query", "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true&access_token=secret"],
    ["wrong host", "https://drive.google.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true"],
    ["extra query", "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true&x=1"],
  ])("rejects a Google descriptor with %s", (_label, url) => {
    expect(decodeDirectMediaUrlResponse({
      itemId: "item_video",
      kind: "video",
      transport: "google-bearer",
      url,
      authorization: { scheme: "Bearer", token: "ya29.test-token" },
      expiresAt,
      revision: null,
    }, { itemId: "item_video", kind: "video" })).toBeNull();
  });

  it("rejects expired, malformed, mismatched, or extra credential fields", () => {
    const base = {
      itemId: "item_video",
      kind: "video",
      transport: "google-bearer",
      url: "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
      authorization: { scheme: "Bearer", token: "ya29.test-token", extra: true },
      expiresAt: new Date(Date.now() - 1).toISOString(),
      revision: null,
    };
    expect(decodeDirectMediaUrlResponse(base, { itemId: "item_other", kind: "video" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused tests and verify contract failures**

Run:

```powershell
npx vitest run tests/direct-media.test.ts tests/provider-contract.test.ts apps/tv/src/api/media-response.test.ts apps/tv/src/app.test.tsx
```

Expected: FAIL because the shared union, `transport`, `authorization`, and decoder do not exist.

- [ ] **Step 3: Add the shared response union**

Replace `DirectMediaUrlResponse` in `packages/shared/src/api.ts` with:

```ts
export interface DirectMediaResponseBase {
  itemId: string;
  kind: "image" | "video";
  url: string;
  expiresAt: string;
  revision: string | null;
}

export interface DirectProviderMediaUrlResponse extends DirectMediaResponseBase {
  transport: "direct";
}

export interface GoogleBearerMediaUrlResponse extends DirectMediaResponseBase {
  transport: "google-bearer";
  authorization: {
    scheme: "Bearer";
    token: string;
  };
}

export type DirectMediaUrlResponse =
  | DirectProviderMediaUrlResponse
  | GoogleBearerMediaUrlResponse;
```

- [ ] **Step 4: Serialize Google credentials only after existing server validation**

In `packages/server/src/services/direct-media.ts`:

```ts
export type DirectMediaResponse = DirectMediaUrlResponse & {
  responseHeaders: typeof RESPONSE_HEADERS;
};
```

After `validTemporaryUrl(...)` succeeds, return Google as:

```ts
if (item.source.provider === "google") {
  if (!("headers" in safe)) throw directMediaError("INVALID_PROVIDER_URL");
  return {
    itemId: item.id,
    kind: item.claims.kind,
    transport: "google-bearer",
    url: safe.url,
    authorization: { scheme: "Bearer", token: credentials!.accessToken },
    expiresAt: safe.expiresAt.toISOString(),
    revision: null,
    responseHeaders: RESPONSE_HEADERS,
  };
}
```

Return OneDrive as:

```ts
return {
  itemId: item.id,
  kind: item.claims.kind,
  transport: "direct",
  url: safe.url,
  expiresAt: safe.expiresAt.toISOString(),
  revision: null,
  responseHeaders: RESPONSE_HEADERS,
};
```

Do not remove the dormant relay method in this task; Task 3 removes it with its route and tests in one reviewable deletion.

- [ ] **Step 5: Implement strict client decoding in a focused module**

Create `apps/tv/src/api/media-response.ts` exporting:

```ts
export function decodeDirectMediaUrlResponse(
  value: unknown,
  expected?: { itemId: string; kind: "image" | "video" },
): DirectMediaUrlResponse | null;
```

The implementation must:

```ts
const GOOGLE_ORIGIN = "https://www.googleapis.com";

function validGoogleMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 8192) return null;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    return url.origin === GOOGLE_ORIGIN &&
      /^\/drive\/v3\/files\/[^/]{1,1024}$/u.test(url.pathname) &&
      keys.length === 2 && new Set(keys).size === 2 &&
      url.searchParams.getAll("alt").length === 1 &&
      url.searchParams.get("alt") === "media" &&
      url.searchParams.getAll("supportsAllDrives").length === 1 &&
      url.searchParams.get("supportsAllDrives") === "true" &&
      url.username === "" && url.password === "" && url.hash === ""
      ? value
      : null;
  } catch {
    return null;
  }
}
```

Require exact object keys for each union member. Bound the token to `1..8192` printable non-whitespace characters, require `scheme === "Bearer"`, require a future canonical timestamp, and enforce the expected item ID and kind. Import this decoder into `client.ts` and remove the relative `/api/tv/google-media/` exception from the old `validHttpsUrl` helper.

- [ ] **Step 6: Update every synthetic descriptor explicitly**

Add `transport: "direct"` to existing OneDrive/provider/example results in:

- `apps/tv/src/app.test.tsx`
- `apps/tv/src/components/viewer.test.tsx`
- `e2e/fixtures.ts`

Do not add dummy authorization objects to direct results.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```powershell
npx vitest run tests/direct-media.test.ts tests/provider-contract.test.ts apps/tv/src/api/media-response.test.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add packages/shared/src/api.ts packages/server/src/services/direct-media.ts apps/tv/src/api/client.ts apps/tv/src/api/media-response.ts apps/tv/src/api/media-response.test.ts tests/direct-media.test.ts tests/provider-contract.test.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx e2e/fixtures.ts
git commit -m "Vend direct Google media credentials"
```

---

### Task 3: Remove the Vercel Google media relay

**Files:**
- Modify: `packages/server/src/services/direct-media.ts:1-82,634-790`
- Modify: `packages/server/src/services/live-browse.ts:49-62,500-522,692`
- Modify: `packages/server/src/http/control-app.ts:131-138,223-330,1195-1214,1960-2005`
- Modify: `packages/server/src/index.ts`
- Modify: `deploy/api-entry.ts:3-29,117-190`
- Modify: `tests/control-http-app.test.ts:12-206`
- Modify: `tests/helpers/api.ts:180-320`
- Modify: `tests/direct-media.test.ts:190-379,1240-1400`
- Modify: `tests/workspace.test.ts`
- Delete: `packages/server/src/auth/media-handles.ts`
- Delete: `tests/media-handles.test.ts`

**Interfaces:**
- Consumes: the transport union from Task 2.
- Produces: `DirectMediaService` with only `thumbnails(...)` and `media(...)`; `CreateDirectMediaServiceOptions` with `browse: Pick<LiveBrowseService, "authorizeHandle">`, `credentialBroker`, `providers`, and optional `now`; `LiveBrowseService` without the relay-only `authorizeClaims` method.

- [ ] **Step 1: Write failing route-removal and composition tests**

Replace the relay tests at the top of `tests/control-http-app.test.ts` with:

```ts
it("does not expose a Vercel Google media byte route", async () => {
  const harness = await createControlApiHarness();
  const response = await harness.app(new Request(
    `${harness.origin}/api/tv/google-media/retired-handle`,
    { headers: harness.deviceHeaders({ range: "bytes=0-0" }) },
  ));

  expect(response.status).toBe(404);
  expect(harness.provider.mediaUrlCalls).toBe(0);
  expect(harness.rateLimiter.calls.map(call => call.bucket)).not.toContain("media-stream");
});

it("rate limits descriptor vending without a high-volume stream bucket", async () => {
  const harness = await createControlApiHarness();
  const response = await harness.app(harness.mediaRequest());
  expect(response.status).toBe(200);
  expect(harness.rateLimiter.calls.map(call => call.bucket)).toEqual(["url-vending"]);
});
```

Add to `tests/workspace.test.ts`:

```ts
const server = await readFile("packages/server/src/http/control-app.ts", "utf8");
const composition = await readFile("deploy/api-entry.ts", "utf8");
expect(server).not.toContain("/api/tv/google-media/:handle");
expect(server).not.toContain('"media-stream"');
expect(composition).not.toContain("createMediaHandleCodec");
await expect(access("packages/server/src/auth/media-handles.ts"))
  .rejects.toMatchObject({ code: "ENOENT" });
```

- [ ] **Step 2: Run focused tests and verify the old route is still present**

Run:

```powershell
npx vitest run tests/control-http-app.test.ts tests/workspace.test.ts tests/direct-media.test.ts tests/media-handles.test.ts
```

Expected: FAIL because the relay route, stream limiter, media codec, and tests still exist.

- [ ] **Step 3: Remove relay-only service code**

In `packages/server/src/services/direct-media.ts`:

- remove `MediaHandleClaims`, `MediaHandleCodec`, `MEDIA_HANDLE_LIFETIME_MS`, and `SealedValueError` imports;
- remove `googleMedia(...)` from `DirectMediaService`;
- delete `GoogleMediaRequest`;
- narrow `browse` to `authorizeHandle`;
- remove `mediaHandles` and `fetch` from options;
- delete `brokerGet`, Range/If-Range validators, response reconstruction, body cancellation, credential refresh on upstream `401`, and every relay-only helper.

In `packages/server/src/services/live-browse.ts`, delete `authorizeClaims` from the public interface, implementation, and returned service object. `authorizeHandle` remains the sole media authorization entry point.

The returned service must be exactly:

```ts
return { thumbnails, media };
```

- [ ] **Step 4: Remove the HTTP route and stream limiter**

In `packages/server/src/http/control-app.ts`:

- delete the dynamic `/api/tv/google-media/:handle` branch;
- delete `googleMedia(...)`;
- delete `"media-stream"` from `DEFAULT_RATE_LIMITS`;
- delete its route-template classifier branch;
- retain `url-vending` for `/api/tv/media-url` and thumbnails.

The unmatched retired path must flow through the existing `404` response.

- [ ] **Step 5: Remove codec construction and exports**

In `deploy/api-entry.ts`, remove:

```ts
createMediaHandleCodec,
```

and remove both `mediaHandles` and `fetch` from `createDirectMediaService(...)`.

Delete `packages/server/src/auth/media-handles.ts`, delete `tests/media-handles.test.ts`, and remove the media-handle export from `packages/server/src/index.ts`.

Update `tests/helpers/api.ts` so its direct media service construction is:

```ts
const directMedia = createDirectMediaService({
  browse,
  credentialBroker: broker,
  providers,
  now: () => new Date(now),
});
```

- [ ] **Step 6: Remove relay-only tests while retaining descriptor validation**

Delete tests that call `directMedia.googleMedia`, inspect Range forwarding, or mint/open a media handle. Keep and strengthen tests that prove:

- authorization happens before credential/provider access;
- Google descriptors contain only the validated raw URL and current access token;
- provider getters cannot mutate the returned snapshot;
- OneDrive remains direct;
- token/provider URL content never appears in logger events.

- [ ] **Step 7: Run server, workspace, and type verification**

Run:

```powershell
npx vitest run tests/control-http-app.test.ts tests/direct-media.test.ts tests/workspace.test.ts tests/provider-contract.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add -u packages/server deploy tests
git add packages/server/src/services/direct-media.ts packages/server/src/services/live-browse.ts packages/server/src/http/control-app.ts packages/server/src/index.ts deploy/api-entry.ts tests/control-http-app.test.ts tests/helpers/api.ts tests/direct-media.test.ts tests/workspace.test.ts
git commit -m "Remove Vercel Google media relay"
```

---

### Task 4: Build the classic service-worker protocol and runtime

**Files:**
- Create: `apps/tv/src/media/google-media-protocol.ts`
- Create: `apps/tv/src/media/google-media-protocol.test.ts`
- Create: `apps/tv/src/media/google-media-worker-runtime.ts`
- Create: `apps/tv/src/media/google-media-worker-runtime.test.ts`
- Create: `apps/tv/src/media/google-media-worker.ts`
- Create: `scripts/build-tv-media-worker.mjs`
- Modify: `apps/tv/package.json`
- Modify: `scripts/check-tv-bundle.mjs`

**Interfaces:**
- Consumes: browser `Request`, `Response`, `fetch`, `crypto.subtle`, `TextEncoder`, and service-worker event primitives through small test doubles.
- Produces: `GoogleMediaGrant`, `GoogleMediaPageMessage`, `GoogleMediaWorkerMessage`, `googleMediaFingerprint`, `isExactGoogleMediaUrl`, `validSingleRange`, `sanitizeMediaFilename`, `googleMediaAlias`, and `installGoogleMediaWorker(scope, dependencies)`.

- [ ] **Step 1: Write failing protocol tests**

Create `apps/tv/src/media/google-media-protocol.test.ts` covering:

```ts
expect(isExactGoogleMediaUrl(
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
)).toBe(true);

expect(isExactGoogleMediaUrl(
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true&access_token=secret",
)).toBe(false);

expect(validSingleRange("bytes=0-")).toEqual({
  header: "bytes=0-", start: 0, end: null, suffixLength: null,
});
expect(validSingleRange("bytes=10-20")).toEqual({
  header: "bytes=10-20", start: 10, end: 20, suffixLength: null,
});
expect(validSingleRange("bytes=-25")).toEqual({
  header: "bytes=-25", start: null, end: null, suffixLength: 25,
});
expect(validSingleRange("bytes=0-1,10-20")).toBeNull();
expect(validSingleRange("items=0-1")).toBeNull();

expect(sanitizeMediaFilename("../MOV00516.MPG")).toBe("MOV00516.MPG");
expect(googleMediaAlias("session_abc", "MOV00516.MPG"))
  .toBe("/__cloudframe_media__/session_abc/MOV00516.MPG");

const first = await googleMediaFingerprint(
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
);
const again = await googleMediaFingerprint(
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true",
);
const other = await googleMediaFingerprint(
  "https://www.googleapis.com/drive/v3/files/file_456?alt=media&supportsAllDrives=true",
);
expect(first).toBe(again);
expect(first).not.toBe(other);
expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
expect(first).not.toContain("file_123");
```

- [ ] **Step 2: Write failing worker-runtime tests**

Create a fake scope that captures `install`, `activate`, `message`, and `fetch` listeners. Cover:

Define these test helpers in `google-media-worker-runtime.test.ts`:

```ts
const RAW_URL =
  "https://www.googleapis.com/drive/v3/files/file_123?alt=media&supportsAllDrives=true";

function grantMessage(requestId = "request_test"): GoogleMediaPageMessage {
  return {
    type: "cloudframe-media-grant",
    requestId,
    grant: {
      sessionId: "session_test",
      rawUrl: RAW_URL,
      fingerprint: TEST_FINGERPRINT,
      token: "ya29.test-token",
      expiresAtEpoch: TEST_NOW + 60_000,
      kind: "video",
      mimeType: "video/mpeg",
      filename: "MOV00516.MPG",
      size: 100,
    },
  };
}

function rawRequest(headers: Record<string, string> = {}): Request {
  return new Request(RAW_URL, { method: "GET", headers });
}

function workerHarness(options?: { upstream?: Response; fetchError?: Error }): {
  providerFetch: ReturnType<typeof vi.fn>;
  clientMessages: GoogleMediaWorkerMessage[];
  dispatchMessage(message: GoogleMediaPageMessage, source: { id: string }): Promise<void>;
  dispatchFetch(request: Request, clientId: string): Promise<Response>;
};
```

`workerHarness` installs the runtime with `isAllowedMediaUrl: isExactGoogleMediaUrl`, `fingerprint: async () => TEST_FINGERPRINT`, captures messages sent to the source client, and defaults provider fetch to a one-byte `206` response. `dispatchFetch` throws if the runtime does not call `respondWith`, making accidental pass-through visible.

```ts
it("adds only bearer authorization and one Range header", async () => {
  const { dispatchMessage, dispatchFetch, providerFetch } = workerHarness();
  await dispatchMessage(grantMessage(), { id: "client_tv" });
  const response = await dispatchFetch(rawRequest({
    range: "bytes=0-",
    "if-range": '"retired-etag"',
  }), "client_tv");

  expect(response.status).toBe(206);
  const headers = new Headers(providerFetch.mock.calls[0]![1]!.headers);
  expect(headers.get("authorization")).toBe("Bearer ya29.test-token");
  expect(headers.get("range")).toBe("bytes=0-");
  expect(headers.has("if-range")).toBe(false);
  expect([...headers.keys()]).toEqual(["authorization", "range"]);
});

it("reconstructs a same-origin 206 stream from the CORS response", async () => {
  const upstream = new Response(new Uint8Array([1]), {
    status: 206,
    headers: {
      "content-type": "video/mpeg",
      "content-range": "bytes 0-0/100",
      "accept-ranges": "bytes",
      "content-length": "1",
      "x-google-debug": "secret-detail",
    },
  });
  const { dispatchMessage, dispatchFetch } = workerHarness({ upstream });
  await dispatchMessage(grantMessage(), { id: "client_tv" });
  const response = await dispatchFetch(rawRequest({ range: "bytes=0-0" }), "client_tv");
  expect(response.status).toBe(206);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1]));
  expect(Object.fromEntries(response.headers)).toEqual({
    "accept-ranges": "bytes",
    "content-length": "1",
    "content-range": "bytes 0-0/100",
    "content-type": "video/mpeg",
  });
  expect(response.headers.has("x-google-debug")).toBe(false);
});

it("synthesizes CORS-hidden range headers from the validated file size", async () => {
  const upstream = new Response(new Uint8Array(11), {
    status: 206,
    headers: { "content-type": "video/mpeg" },
  });
  const { dispatchMessage, dispatchFetch } = workerHarness({ upstream });
  await dispatchMessage(grantMessage(), { id: "client_tv" });
  const response = await dispatchFetch(rawRequest({ range: "bytes=10-20" }), "client_tv");
  expect(response.headers.get("content-range")).toBe("bytes 10-20/100");
  expect(response.headers.get("content-length")).toBe("11");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
});

it("requests memory rehydration by fingerprint after a worker restart", async () => {
  const { dispatchMessage, dispatchFetch, clientMessages } = workerHarness();
  const pending = dispatchFetch(rawRequest({ range: "bytes=0-" }), "client_tv");
  await Promise.resolve();
  expect(clientMessages).toContainEqual(expect.objectContaining({
    type: "cloudframe-media-grant-request",
    lookup: {
      kind: "fingerprint",
      value: await googleMediaFingerprint(RAW_URL),
    },
  }));
  const requestId = clientMessages[0]!.requestId;
  await dispatchMessage(grantMessage(requestId), { id: "client_tv" });
  await expect(pending).resolves.toMatchObject({ status: 206 });
});

it("fails an ungranted reserved alias without going to the application origin", async () => {
  const { dispatchFetch, providerFetch } = workerHarness();
  const response = await dispatchFetch(
    new Request("https://tv.test/__cloudframe_media__/session_test/MOV00516.MPG"),
    "client_tv",
  );
  expect(response.type).toBe("error");
  expect(providerFetch).not.toHaveBeenCalled();
});
```

Add an `it.each` matrix for expired grants, mismatched client IDs, `POST`, multi-range headers, `401`, `403`, `416`, and rejected provider fetches. For every emitted worker result, assert:

```ts
expect(JSON.stringify(clientMessages)).not.toContain("ya29.test-token");
expect(JSON.stringify(clientMessages)).not.toContain("www.googleapis.com");
```

Add one release test proving the exact session stops intercepting, and one registry-cap test proving a fifth grant evicts the oldest grant while leaving the four newest usable.

- [ ] **Step 3: Run the new tests and verify missing-module failures**

Run:

```powershell
npx vitest run apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/media/google-media-worker-runtime.test.ts
```

Expected: FAIL because the protocol and runtime files do not exist.

- [ ] **Step 4: Define the exact message protocol**

Create these public shapes in `google-media-protocol.ts`:

```ts
export interface GoogleMediaGrant {
  sessionId: string;
  rawUrl: string;
  fingerprint: string;
  token: string;
  expiresAtEpoch: number;
  kind: "image" | "video";
  mimeType: string;
  filename: string;
  size: number | null;
}

export type GoogleMediaPageMessage =
  | { type: "cloudframe-media-grant"; requestId: string; grant: GoogleMediaGrant }
  | { type: "cloudframe-media-revoke"; sessionId: string };

export type GoogleMediaWorkerMessage =
  | { type: "cloudframe-media-grant-ack"; requestId: string; sessionId: string }
  | {
      type: "cloudframe-media-grant-request";
      requestId: string;
      lookup:
        | { kind: "fingerprint"; value: string }
        | { kind: "session"; value: string };
    }
  | {
      type: "cloudframe-media-result";
      sessionId: string;
      attempt: "google-raw" | "google-filename";
      outcome: "response" | "network-error" | "bridge-error";
      status?: number;
    };
```

Validators must clone accepted values into ordinary objects and reject prototypes, extra keys, expired times, control characters, invalid MIME prefixes, invalid session/request IDs, mismatched fingerprints, invalid non-negative safe-integer sizes, and raw URLs outside the exact Drive boundary.

The worker binds each accepted grant to `messageEvent.source.id`; the page cannot supply or override client identity. Raw Google URLs and filename aliases are served only when `fetchEvent.clientId` matches the bound client. Ordinary media subresource fetches with an empty or different client ID fail closed. After a worker restart, an ungranted raw URL requests rehydration by URL fingerprint, while an ungranted reserved alias requests rehydration by the session ID parsed from its path. Send the request only to `scope.clients.get(fetchEvent.clientId)`, never to every controlled client.

- [ ] **Step 5: Implement the worker runtime with dependency-injected primitives**

Export:

```ts
export function installGoogleMediaWorker(
  scope: GoogleMediaWorkerScope,
  dependencies: {
    fetch: typeof globalThis.fetch;
    now: () => number;
    fingerprint: (url: string) => Promise<string>;
    isAllowedMediaUrl: (url: string) => boolean;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  },
): void;
```

Use a maximum of four live grants. On an accepted fetch:

```ts
const headers = new Headers();
headers.set("authorization", `Bearer ${grant.token}`);
const range = validSingleRange(event.request.headers.get("range"));
if (range) headers.set("range", range.header);

const upstream = await dependencies.fetch(grant.rawUrl, {
  method: event.request.method,
  mode: "cors",
  credentials: "omit",
  cache: "no-store",
  redirect: "follow",
  headers,
});
```

Represent a parsed range as:

```ts
export interface ParsedSingleRange {
  header: string;
  start: number | null;
  end: number | null;
  suffixLength: number | null;
}
```

`validSingleRange` returns this object, rejects multiple ranges and unsafe integers, and preserves the exact validated header for Google. When the upstream response is `206` but CORS hides `Content-Range` or `Content-Length`, calculate the concrete interval from the parsed range plus `grant.size`. Examples: `bytes=0-` with size `100` becomes `bytes 0-99/100` and length `100`; `bytes=10-20` becomes `bytes 10-20/100` and length `11`; `bytes=-25` becomes `bytes 75-99/100` and length `25`. If size is `null`, the range is unsatisfiable, or both headers cannot be constructed exactly, return a bridge error instead of a malformed `206`.

Rebuild the response from `upstream.body` and only these headers:

```ts
const RESPONSE_HEADERS = [
  "accept-ranges",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;
```

Post evidence containing only session ID, attempt, outcome, and status. Never include token, raw URL, provider ID, response body, or upstream error text.

The production entry injects `isExactGoogleMediaUrl` as `isAllowedMediaUrl`. Unit tests and the Chromium 68 harness inject an exact local-origin validator, keeping test-only origins out of the shipped Google boundary.

- [ ] **Step 6: Add the classic entry and fixed-name build**

`apps/tv/src/media/google-media-worker.ts` must contain only:

```ts
declare const __CLOUDFRAME_MEDIA_PROBE_ORIGIN__: string | null;

import { googleMediaFingerprint, isExactGoogleMediaUrl } from "./google-media-protocol";
import { installGoogleMediaWorker } from "./google-media-worker-runtime";

const isAllowedMediaUrl = __CLOUDFRAME_MEDIA_PROBE_ORIGIN__ === null
  ? isExactGoogleMediaUrl
  : (value: string) => {
      try {
        const url = new URL(value);
        return url.origin === __CLOUDFRAME_MEDIA_PROBE_ORIGIN__ &&
          url.pathname === "/sample.wav" && url.search === "" && url.hash === "";
      } catch {
        return false;
      }
    };

installGoogleMediaWorker(self as unknown as Parameters<typeof installGoogleMediaWorker>[0], {
  fetch: globalThis.fetch.bind(globalThis),
  now: () => Date.now(),
  fingerprint: googleMediaFingerprint,
  isAllowedMediaUrl,
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});
```

Create `scripts/build-tv-media-worker.mjs`. It accepts optional `--outfile <absolute-path>` and `--probe-origin <exact-http-origin>` arguments for the pinned Chromium harness. The default output is the production worker and the default probe origin is `null`:

```js
import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const outfile = args.get("--outfile") ??
  resolve(root, "apps/tv/dist/cloudframe-media-sw.js");
const probeOrigin = args.get("--probe-origin") ?? null;
if (probeOrigin !== null && new URL(probeOrigin).origin !== probeOrigin) {
  throw new Error("Probe origin must be one exact origin");
}
await build({
  entryPoints: [resolve(root, "apps/tv/src/media/google-media-worker.ts")],
  outfile,
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome68"],
  minify: true,
  legalComments: "none",
  sourcemap: false,
  define: {
    __CLOUDFRAME_MEDIA_PROBE_ORIGIN__: JSON.stringify(probeOrigin),
  },
});
```

The production npm build invokes the script without arguments, so esbuild folds the probe branch away and the shipped worker accepts only `isExactGoogleMediaUrl`.

Change `apps/tv/package.json`:

```json
"build": "vite build && node ../../scripts/build-tv-media-worker.mjs"
```

- [ ] **Step 7: Extend the bundle gate**

In `scripts/check-tv-bundle.mjs`, read `apps/tv/dist/cloudframe-media-sw.js`, parse it with `node:vm` `Script`, reject `?.` and `??`, require its gzip size to remain at or below `24 * 1024`, and print its size beside the existing legacy JS/CSS totals.

- [ ] **Step 8: Run worker unit and build verification**

Run:

```powershell
npx vitest run apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/media/google-media-worker-runtime.test.ts
npm run build -w @cloudframe/tv
node scripts/check-tv-bundle.mjs
npm run typecheck
```

Expected: PASS and `apps/tv/dist/cloudframe-media-sw.js` exists.

- [ ] **Step 9: Commit**

```powershell
git add apps/tv/src/media/google-media-protocol.ts apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/media/google-media-worker-runtime.ts apps/tv/src/media/google-media-worker-runtime.test.ts apps/tv/src/media/google-media-worker.ts scripts/build-tv-media-worker.mjs apps/tv/package.json scripts/check-tv-bundle.mjs
git commit -m "Add direct Google media worker"
```

---

### Task 5: Implement the page-side Google media bridge

**Files:**
- Create: `apps/tv/src/media/google-media-bridge.ts`
- Create: `apps/tv/src/media/google-media-bridge.test.ts`

**Interfaces:**
- Consumes: `GoogleBearerMediaUrlResponse` and protocol messages from Task 4.
- Produces: `GoogleMediaBridge`, `PreparedGoogleMediaSource`, `GoogleMediaDeliveryEvidence`, `GoogleMediaBridgeError`, `createGoogleMediaBridge`, and `unavailableGoogleMediaBridge`.

- [ ] **Step 1: Write failing bridge tests**

Create a fake `ServiceWorkerContainer` and controller. Cover:

Define `descriptor()` as an exact `GoogleBearerMediaUrlResponse` for `MOV00516.MPG`, define `mediaItem()` as `{ name: "MOV00516.MPG", kind: "video", mimeType: "video/mpeg", size: 100 }`, and define `bridgeHarness(options?)` to return `{ bridge, fake }`, where `fake` contains `register`, `ready`, `controller.postMessage`, `emitMessage`, and `emitControllerChange`. `prepareAndAck()` starts `prepare`, reads the posted request/session IDs, emits the matching acknowledgement, and returns `{ bridge, fake, prepared }`.

```ts
it("registers lazily and resolves prepare only after a matching grant ack", async () => {
  const { bridge, fake } = bridgeHarness();
  const pending = bridge.prepare(descriptor(), mediaItem(), new AbortController().signal);
  expect(fake.register).toHaveBeenCalledWith("/cloudframe-media-sw.js", { scope: "/" });
  expect(fake.controller.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "cloudframe-media-grant",
  }));
  fake.emitMessage({ type: "cloudframe-media-grant-ack", requestId: postedRequestId(), sessionId: postedSessionId() });
  await expect(pending).resolves.toMatchObject({
    sourceUrl: descriptor().url,
    sourceKind: "google-raw",
  });
});

it("keeps the token only in its private live-grant map", async () => {
  const { prepared } = await prepareAndAck();
  expect(JSON.stringify(prepared)).not.toContain("ya29.test-token");
  expect(document.documentElement.outerHTML).not.toContain("ya29.test-token");
});

it("regrants a live credential when the restarted worker requests its fingerprint", async () => {
  const { prepared, fake } = await prepareAndAck();
  fake.emitMessage({
    type: "cloudframe-media-grant-request",
    requestId: "worker_request_1",
    fingerprint: prepared.fingerprint,
  });
  expect(fake.controller.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    type: "cloudframe-media-grant",
    requestId: "worker_request_1",
  }));
});

it("fails with a stable error when service workers are unavailable", async () => {
  const { bridge } = bridgeHarness({ serviceWorker: undefined });
  await expect(bridge.prepare(descriptor(), mediaItem()))
    .rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_UNAVAILABLE" });
});

it("times out and cancels pending preparation without leaking credentials", async () => {
  const { bridge, fake } = bridgeHarness();
  const controller = new AbortController();
  const timedOut = bridge.prepare(descriptor(), mediaItem());
  await vi.advanceTimersByTimeAsync(5_001);
  await expect(timedOut).rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_TIMEOUT" });

  const cancelled = bridge.prepare(descriptor(), mediaItem(), controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "GOOGLE_MEDIA_BRIDGE_CANCELLED" });
  expect(document.documentElement.outerHTML).not.toContain("ya29.test-token");
});

it("records bounded delivery evidence and revokes the exact session", async () => {
  const { bridge, fake, prepared } = await prepareAndAck();
  fake.emitMessage({
    type: "cloudframe-media-result",
    sessionId: prepared.sessionId,
    attempt: "google-raw",
    outcome: "response",
    status: 206,
  });
  expect(bridge.evidence(prepared.sessionId)).toEqual({
    attempt: "google-raw", outcome: "response", status: 206,
  });
  await expect(bridge.waitForEvidence(prepared.sessionId, 300)).resolves.toEqual({
    attempt: "google-raw", outcome: "response", status: 206,
  });
  expect(bridge.filenameSource(prepared.sessionId)?.sourceUrl)
    .toBe(`/__cloudframe_media__/${prepared.sessionId}/MOV00516.MPG`);
  bridge.release(prepared.sessionId);
  expect(fake.controller.postMessage).toHaveBeenLastCalledWith({
    type: "cloudframe-media-revoke", sessionId: prepared.sessionId,
  });
});
```

Add separate exact tests for waiting through one `controllerchange`, rejecting an already-expired descriptor, and ignoring unknown or mismatched acknowledgement/result messages.

Add one delayed-evidence test: call `waitForEvidence(sessionId, 300)` while evidence is `none`, emit a matching result before advancing 300 ms, and assert it resolves to that result. Add one timeout test that advances 301 ms without a result and resolves to `{ attempt: "google-raw", outcome: "none" }`.

- [ ] **Step 2: Run the test and verify the missing module**

Run:

```powershell
npx vitest run apps/tv/src/media/google-media-bridge.test.ts
```

Expected: FAIL because `google-media-bridge.ts` does not exist.

- [ ] **Step 3: Define the bridge API**

```ts
export type GoogleMediaSourceKind = "google-raw" | "google-filename";

export interface PreparedGoogleMediaSource {
  sourceUrl: string;
  sourceKind: GoogleMediaSourceKind;
  sessionId: string;
  fingerprint: string;
}

export type GoogleMediaDeliveryEvidence =
  | { outcome: "none"; attempt: GoogleMediaSourceKind }
  | { outcome: "response"; attempt: GoogleMediaSourceKind; status: number }
  | { outcome: "network-error" | "bridge-error"; attempt: GoogleMediaSourceKind };

export interface GoogleMediaBridge {
  prepare(
    descriptor: GoogleBearerMediaUrlResponse,
    item: { name: string; kind: "image" | "video"; mimeType: string; size: number | null },
    signal?: AbortSignal,
  ): Promise<PreparedGoogleMediaSource>;
  filenameSource(sessionId: string): PreparedGoogleMediaSource | null;
  evidence(sessionId: string): GoogleMediaDeliveryEvidence;
  waitForEvidence(sessionId: string, timeoutMs?: number): Promise<GoogleMediaDeliveryEvidence>;
  release(sessionId: string): void;
}
```

- [ ] **Step 4: Implement lazy registration and memory-only grants**

`createGoogleMediaBridge` must accept injectable `serviceWorker`, `crypto`, `now`, `setTimeout`, and `clearTimeout` dependencies for tests. Production defaults use `navigator.serviceWorker`, `globalThis.crypto`, and browser timers. The page does not invent or send a service-worker client ID; the worker derives that binding from `messageEvent.source.id`.

`prepare` must:

1. revalidate the exact Google URL and future expiry;
2. lazily call `register("/cloudframe-media-sw.js", { scope: "/" })` once;
3. await `navigator.serviceWorker.ready` and a controlling worker;
4. generate `session_<base64url>` and `request_<base64url>` identifiers with `crypto.getRandomValues`;
5. calculate `googleMediaFingerprint(descriptor.url)`;
6. store the full grant, including the browse DTO's validated file size, only in a closure-owned `Map`;
7. post the grant;
8. resolve only after its exact acknowledgement;
9. reject after a 5,000 ms acknowledgement timeout with a stable `GoogleMediaBridgeError` code and no secret-bearing message on timeout or cancellation.

`filenameSource(sessionId)` returns the same session with `googleMediaAlias(sessionId, filename)` and `sourceKind: "google-filename"`. `release` deletes the local grant and posts a revoke message. Worker-result messages update only the bounded evidence map. `waitForEvidence` resolves immediately when evidence is already non-`none`; otherwise it waits up to the supplied timeout (default 300 ms) for one result message, then returns the current `none` value. Release resolves pending evidence waiters with `none` before deleting the session.

- [ ] **Step 5: Implement worker restart rehydration**

On `cloudframe-media-grant-request`, find one non-expired live grant by the exact lookup kind: fingerprint for raw URLs, session ID for aliases. Post it with the worker's request ID. If no exact grant exists, send nothing. Never enumerate grants or respond with a raw URL in the rehydration request.

- [ ] **Step 6: Run bridge, protocol, and type verification**

Run:

```powershell
npx vitest run apps/tv/src/media/google-media-bridge.test.ts apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/media/google-media-worker-runtime.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/tv/src/media/google-media-bridge.ts apps/tv/src/media/google-media-bridge.test.ts
git commit -m "Add Google media page bridge"
```

---

### Task 6: Route Google images and videos through prepared TV sources

**Files:**
- Modify: `apps/tv/src/main.tsx`
- Modify: `apps/tv/src/app.tsx:48-95,539-557`
- Modify: `packages/tv-core/src/viewer.ts:9-66,142-174,234-255`
- Modify: `tests/viewer-state.test.ts`
- Modify: `apps/tv/src/components/viewer.tsx:1-230,330-405`
- Modify: `apps/tv/src/components/video-player.tsx:29-60`
- Modify: `apps/tv/src/components/image-viewer.tsx`
- Modify: `apps/tv/src/app.test.tsx`
- Modify: `apps/tv/src/components/viewer.test.tsx`

**Interfaces:**
- Consumes: `GoogleMediaBridge` from Task 5 and the transport union from Task 2.
- Produces: `ViewerMediaSourceKind = "direct" | "google-raw" | "google-filename"`; ready viewer entries containing only source URL/kind plus existing expiry/revision data.

- [ ] **Step 1: Write failing viewer integration tests**

Add a fake bridge helper to `viewer.test.tsx` and cover:

```ts
it("prepares Google video before assigning the raw Drive URL", async () => {
  const bridge = fakeGoogleMediaBridge();
  const api = viewerApi();
  vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_video_1", "video"));

  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={items} selectedItemId="item_video_1" slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);

  expect(await screen.findByLabelText("Playing Clip.mp4"))
    .toHaveAttribute("src", googleDescriptor("item_video_1", "video").url);
  expect(bridge.prepare).toHaveBeenCalledTimes(1);
  expect(document.body.innerHTML).not.toContain("ya29.test-token");
});

it("prepares a full-size Google image through the same bridge", async () => {
  const bridge = fakeGoogleMediaBridge();
  const api = viewerApi();
  const preparation = deferred<PreparedGoogleMediaSource>();
  bridge.prepare.mockReturnValue(preparation.promise);
  vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_image_1", "image"));
  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={items} selectedItemId="item_image_1" slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  expect(screen.queryByRole("img", { name: "First.jpg" })).not.toBeInTheDocument();
  preparation.resolve(preparedGoogle("item_image_1", "google-raw"));
  expect(await screen.findByRole("img", { name: "First.jpg" }))
    .toHaveAttribute("src", googleDescriptor("item_image_1", "image").url);
});

it("keeps OneDrive direct and never calls the Google bridge", async () => {
  const bridge = fakeGoogleMediaBridge();
  const api = viewerApi();
  vi.mocked(api.mediaUrl).mockResolvedValue(directDescriptor("item_video_1", "video"));
  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={items} selectedItemId="item_video_1" slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  expect(await screen.findByLabelText("Playing Clip.mp4"))
    .toHaveAttribute("src", directDescriptor("item_video_1", "video").url);
  expect(bridge.prepare).not.toHaveBeenCalled();
});

it("releases grants on renewal, navigation, close, and unmount", async () => {
  const bridge = fakeGoogleMediaBridge();
  bridge.prepare
    .mockResolvedValueOnce(preparedGoogle("item_video_1-first", "google-raw"))
    .mockResolvedValueOnce(preparedGoogle("item_video_1-second", "google-raw"));
  const api = viewerApi();
  vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_video_1", "video"));
  const rendered = render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  const first = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
  Object.defineProperty(first, "currentTime", { configurable: true, value: 12 });
  fireEvent.error(first);
  fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
  await waitFor(() => expect(bridge.release).toHaveBeenCalledWith("session_item_video_1-first"));
  rendered.unmount();
  expect(bridge.release).toHaveBeenCalledWith("session_item_video_1-second");
  expect(new Set(bridge.release.mock.calls.map(call => call[0])).size)
    .toBe(bridge.release.mock.calls.length);
});
```

Define `googleDescriptor`, `directDescriptor`, `preparedGoogle`, and `deferred` in the test file with exact return types. Keep the existing stale-completion and adjacent-prefetch tests; extend them to assert obsolete prepared sessions are released when their node leaves the URL window.

- [ ] **Step 2: Run viewer tests and verify missing bridge plumbing**

Run:

```powershell
npx vitest run apps/tv/src/components/viewer.test.tsx apps/tv/src/app.test.tsx
```

Expected: FAIL because `TvApp` and `Viewer` do not accept `googleMedia` and URL entries do not track source kind.

- [ ] **Step 3: Inject the production bridge at the app boundary**

In `main.tsx`:

```ts
import { createGoogleMediaBridge } from "./media/google-media-bridge";

const googleMedia = createGoogleMediaBridge();
render(<TvApp api={injectedApi} googleMedia={googleMedia} />, document.getElementById("app")!);
```

Add an optional `googleMedia: GoogleMediaBridge = unavailableGoogleMediaBridge` prop to `TvApp`, then pass the resolved bridge through `ReadyBrowserShell`, `BrowserShell`, and `Viewer` as a required prop. Existing tests may keep rendering `TvApp` without a bridge and receive the unavailable implementation; bridge-specific tests pass a fake bridge explicitly. Do not create a real service worker inside unit tests.

- [ ] **Step 4: Track prepared source kind without credentials**

In `packages/tv-core/src/viewer.ts`:

```ts
export type ViewerMediaSourceKind = "direct" | "google-raw" | "google-filename";

export interface ViewerUrlState {
  status: ViewerUrlStatus;
  requestId: number;
  url?: string;
  expiresAtEpoch?: number;
  revision: string | null;
  refreshUsed: boolean;
  resumeSeconds: number;
  errorKind?: ViewerMediaErrorKind;
  sourceKind?: ViewerMediaSourceKind;
}
```

Extend `url-ready` with `sourceKind: ViewerMediaSourceKind` and write it into the ready entry. Do not add token, authorization, raw descriptor, or bridge grant fields to the reducer.

Update `tests/viewer-state.test.ts` so every `url-ready` action supplies `sourceKind`. Add one assertion that a ready Google entry stores `google-raw` while `JSON.stringify(state)` contains neither `authorization` nor a bearer token.

- [ ] **Step 5: Prepare descriptors before dispatching `url-ready`**

In the URL-vending promise:

```ts
const prepared = result.transport === "google-bearer"
  ? await googleMedia.prepare(result, {
      name: expected.name,
      kind: expected.kind,
      mimeType: expected.mimeType!,
      size: expected.size,
    }, controller.signal)
  : { sourceUrl: result.url, sourceKind: "direct" as const, sessionId: null };
```

Keep a closure-owned `preparedSessions.current: Record<string, string>` in `Viewer`. Release an older node session before replacing it, release sessions whose node leaves `state.urls`, and release everything on close, navigation invalidation, device unauthorized, and unmount.

Dispatch only:

```ts
dispatch({
  type: "url-ready",
  nodeId,
  requestId: entry.requestId,
  url: prepared.sourceUrl,
  sourceKind: prepared.sourceKind,
  expiresAtEpoch: Date.parse(result.expiresAt),
  revision: result.revision,
});
```

Map `GoogleMediaBridgeError` to `url-failed` kind `bridge`; keep device and navigation errors on their existing paths. Extend `ViewerMediaErrorKind` with `bridge` in this task so integration compiles; Task 7 adds `transport` and `decoder` and removes the old `codec` classification.

- [ ] **Step 6: Keep native media elements and referrer protection**

Continue assigning the prepared URL to the native `<img>` and `<video>` elements. Add:

```tsx
referrerPolicy="no-referrer"
```

to `<video>`. Preserve Video.js custom elements, preload metadata, playsInline, remote controls, and existing callbacks.

- [ ] **Step 7: Run integration and regression tests**

Run:

```powershell
npx vitest run apps/tv/src/components/viewer.test.tsx apps/tv/src/app.test.tsx tests/viewer-state.test.ts
npm run typecheck
```

Expected: PASS, including existing renewal/resume/history tests.

- [ ] **Step 8: Commit**

```powershell
git add apps/tv/src/main.tsx apps/tv/src/app.tsx packages/tv-core/src/viewer.ts tests/viewer-state.test.ts apps/tv/src/components/viewer.tsx apps/tv/src/components/video-player.tsx apps/tv/src/components/image-viewer.tsx apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx
git commit -m "Use direct Google media on TV"
```

---

### Task 7: Add one MPEG filename retry and evidence-based errors

**Files:**
- Modify: `apps/tv/src/media/google-media-protocol.ts`
- Modify: `apps/tv/src/media/google-media-protocol.test.ts`
- Modify: `packages/tv-core/src/viewer.ts:9-66,142-216`
- Modify: `tests/viewer-state.test.ts`
- Modify: `apps/tv/src/components/viewer.tsx:320-410`
- Modify: `apps/tv/src/components/viewer.test.tsx:260-315,381-396`

**Interfaces:**
- Consumes: bridge evidence and `filenameSource(sessionId)`.
- Produces: `isLegacyMpeg(item)`, `ViewerMediaErrorKind = "authorization" | "bridge" | "transport" | "decoder" | "generic"`, and `compatibility-source` reducer action.

- [ ] **Step 1: Write failing MPEG and error-classification tests**

Add protocol tests:

```ts
expect(isLegacyMpeg({ name: "MOV00516.MPG", mimeType: "video/mpeg" })).toBe(true);
expect(isLegacyMpeg({ name: "archive.MPEG", mimeType: "application/octet-stream" })).toBe(true);
expect(isLegacyMpeg({ name: "movie.mp4", mimeType: "video/mp4" })).toBe(false);
```

Add viewer tests:

```ts
it("retries a delivered legacy MPEG once through its filename alias", async () => {
  const { bridge, api } = deliveredMpegHarness();
  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
  Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });
  fireEvent.error(raw);
  expect(bridge.filenameSource).toHaveBeenCalledWith("session_mpeg");
  const alias = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
  expect(alias).toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG");
  expect(api.mediaUrl).toHaveBeenCalledTimes(1);
  bridge.evidence.mockReturnValue({
    attempt: "google-filename", outcome: "response", status: 206,
  });
  Object.defineProperty(alias, "error", { configurable: true, value: { code: 4 } });
  fireEvent.error(alias);
  expect(screen.getByRole("heading", { name: "This file reached the TV, but could not be decoded" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
});

it("renews once when worker evidence reports 401 or 403", async () => {
  const { bridge, api } = deliveredMpegHarness();
  bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "response", status: 401 });
  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
  Object.defineProperty(video, "currentTime", { configurable: true, value: 37 });
  fireEvent.error(video);
  await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Resuming at 0:37")).toBeVisible();
});

it.each([
  ["bridge-error", "Direct Google playback is unavailable on this browser"],
  ["network-error", "The Google media link could not be opened"],
])("shows secret-safe %s copy", async (outcome, expectedCopy) => {
  const { bridge, api } = deliveredMpegHarness();
  bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome });
  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
  fireEvent.error(video);
  expect(screen.getByText(expectedCopy)).toBeVisible();
  expect(document.body.innerHTML).not.toContain("ya29.test-token");
  expect(document.body.innerHTML).not.toContain("www.googleapis.com");
  expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
});

it("does not call code 4 a codec failure without successful delivery evidence", async () => {
  const { bridge, api } = deliveredMpegHarness();
  bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "none" });
  render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
    items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
    previews={{}} onClose={() => undefined} />);
  const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
  Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
  fireEvent.error(video);
  expect(screen.getByRole("heading", { name: "This media could not be opened" })).toBeVisible();
  expect(screen.queryByText("could not be decoded")).not.toBeInTheDocument();
});
```

Define `mpegItem` and `deliveredMpegHarness()` beside the existing viewer fixtures. The harness returns a single prepared session, exact `206` raw evidence by default, a filename source for the same session, and a typed mocked `TvApi`.

- [ ] **Step 2: Run focused tests and verify current code misclassifies code 4**

Run:

```powershell
npx vitest run apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/components/viewer.test.tsx
```

Expected: FAIL because code `4` is currently always mapped to `codec` and there is no compatibility-source action.

- [ ] **Step 3: Add the pure legacy MPEG detector**

Export:

```ts
export function isLegacyMpeg(item: { name: string; mimeType: string | null }): boolean {
  return item.mimeType?.toLowerCase() === "video/mpeg" || /\.(?:mpg|mpeg|dat)$/iu.test(item.name);
}
```

- [ ] **Step 4: Replace codec error state with evidence-based kinds**

In `packages/tv-core/src/viewer.ts`:

```ts
export type ViewerMediaErrorKind =
  | "authorization"
  | "bridge"
  | "transport"
  | "decoder"
  | "generic";
```

Add:

```ts
| {
    type: "compatibility-source";
    nodeId: string;
    url: string;
    sourceKind: "google-filename";
    resumeSeconds: number;
  }
```

The reducer accepts it only for the active ready `google-raw` node, replaces its URL/source kind without consuming `retryLedger`, stores the resume position, and clears the active media error.

Add reducer tests in `tests/viewer-state.test.ts` proving `compatibility-source` changes only the active `google-raw` entry, preserves `requestId`, expiry, revision, and retry-ledger `used`, stores the supplied resume position, and ignores direct, inactive, loading, and already-`google-filename` entries.

- [ ] **Step 5: Correlate native media failure with bridge evidence**

In `onMediaError`:

1. save video history and current time exactly as today;
2. if source is not Google, keep the generic provider error path;
3. obtain the active bridge session and await `googleMedia.waitForEvidence(sessionId, 300)`; after it resolves, re-check that the component is mounted and the same item/session is still active before dispatching;
4. map `401`/`403` to the existing one-time `authorization-expired` action;
5. map `bridge-error` to `bridge` and `network-error` or non-success HTTP to `transport`;
6. for successful `200`/`206` plus native code `4`, run the filename retry only when `sourceKind === "google-raw"` and `isLegacyMpeg(active)`;
7. successful delivery after the alias, or successful non-MPEG delivery with code `4`, becomes `decoder`;
8. absent evidence remains `generic`.

Before the filename substitution, preserve the current timestamp in `latestResumeOverrides` and `resumeOverrides`, then dispatch `compatibility-source`. Do not call `/api/tv/media-url` for this retry.

- [ ] **Step 6: Make error actions truthful**

Render these exact outcomes:

```ts
bridge: {
  title: "Direct Google playback is unavailable on this browser",
  body: "This TV could not start the direct Google media bridge.",
  retry: false,
}
transport: {
  title: "The Google media link could not be opened",
  body: "The TV could not read this file directly from Google.",
  retry: false,
}
decoder: {
  title: "This file reached the TV, but could not be decoded",
  body: active.kind === "video"
    ? "The TV browser could not decode this file's video or audio format."
    : "The TV browser could not decode this image format.",
  retry: false,
}
```

Change `ViewerError` to accept optional `onRetry`. Render “Try fresh URL” only for the generic first-failure path where `refreshUsed` is false. A confirmed decoder, bridge, transport, or exhausted authorization failure has no button.

- [ ] **Step 7: Run focused and viewer-state regressions**

Run:

```powershell
npx vitest run apps/tv/src/media/google-media-protocol.test.ts apps/tv/src/components/viewer.test.tsx tests/viewer-state.test.ts
npm run typecheck
```

Expected: PASS, including resume-at-same-timestamp and single-renewal tests.

- [ ] **Step 8: Commit**

```powershell
git add apps/tv/src/media/google-media-protocol.ts apps/tv/src/media/google-media-protocol.test.ts packages/tv-core/src/viewer.ts tests/viewer-state.test.ts apps/tv/src/components/viewer.tsx apps/tv/src/components/viewer.test.tsx
git commit -m "Retry legacy MPEG playback natively"
```

---

### Task 8: Prove the built worker on Chromium 68 and in deployment output

**Files:**
- Modify: `scripts/check-chromium68.mjs`
- Modify: `tests/config.test.ts`
- Modify: `tests/workspace.test.ts`
- Modify: `deploy/vercel-build-contract.json`
- Modify: `e2e/fixtures.ts`
- Modify: `e2e/browse-viewer.spec.ts`

**Interfaces:**
- Consumes: `/cloudframe-media-sw.js` and the exact Task 4 message protocol.
- Produces: deterministic proof that Chromium 68 performs cross-origin bearer + Range playback without a Vercel media route.

- [ ] **Step 1: Write failing static-output and E2E assertions**

In `tests/config.test.ts`, add the worker to the existing Vercel build assertions:

```ts
await Promise.all([
  access(".vercel/output/static/index.html"),
  access(".vercel/output/static/cloudframe-media-sw.js"),
  access(".vercel/output/static/admin/index.html"),
  access(".vercel/output/functions/api.func/index.js"),
]);
```

Also assert the route header contract:

```ts
expect(contract.routes).toContainEqual({
  src: "^/cloudframe-media-sw\\.js$",
  headers: { "cache-control": "no-cache" },
  continue: true,
});
expect(contract.routes[0]).toEqual({
  src: "^/cloudframe-media-sw\\.js$",
  headers: { "cache-control": "no-cache" },
  continue: true,
});
expect(contract.routes[1]).toEqual({ handle: "filesystem" });
```

Update both existing `routes[0]` filesystem assertions in `tests/config.test.ts` and `tests/workspace.test.ts` to `routes[1]`.

Update the E2E fixture results to include `transport: "direct"`. In `browse-viewer.spec.ts`, collect requests and assert:

```ts
expect(requests.some(url => url.includes("/api/tv/google-media/"))).toBe(false);
```

- [ ] **Step 2: Run configuration and E2E tests before extending the Chromium proof**

Run:

```powershell
npx vitest run tests/config.test.ts
npx playwright test e2e/browse-viewer.spec.ts --project=tv-1920
```

Expected: configuration fails until the worker is asserted/copied correctly; update fixture compilation failures identify any missing `transport` field.

- [ ] **Step 3: Add the fixed-worker cache policy**

Insert this route before `{ "handle": "filesystem" }` in `deploy/vercel-build-contract.json`:

```json
{
  "src": "^/cloudframe-media-sw\\.js$",
  "headers": { "cache-control": "no-cache" },
  "continue": true
}
```

`no-cache` permits browser storage but requires revalidation, which is appropriate for a fixed service-worker URL. Do not use `immutable` or a long `max-age`.

- [ ] **Step 4: Extend the pinned Chromium server harness**

In `scripts/check-chromium68.mjs`:

- start a second local server containing a ten-second PCM WAV body;
- answer CORS preflight for `authorization,range`;
- require `Authorization: Bearer chromium68-probe-token`;
- support `Range` and return `206`, `Content-Range`, `Accept-Ranges`, `Content-Length`, and `Content-Type`;
- record upstream requests and any accidental application request under `/__cloudframe_media__/`.
- invoke `scripts/build-tv-media-worker.mjs --outfile <temporary-worker-path> --probe-origin <local-media-origin>` and serve that temporary worker at `/cloudframe-media-sw.js` for the probe;
- verify the ordinary production worker already emitted by `npm run build -w @cloudframe/tv` does not contain the localhost probe origin.

Do not write the probe token or URLs to repository files or final output.

- [ ] **Step 5: Exercise the real built worker through DevTools**

After the existing TV build and Video.js checks, evaluate a browser script against the temporary probe bundle that:

1. registers `/cloudframe-media-sw.js` with scope `/`;
2. waits for `ready` and `controllerchange`;
3. sends a valid `cloudframe-media-grant` for the local cross-origin URL;
4. waits for its exact acknowledgement;
5. assigns the cross-origin URL to a native `<audio preload="metadata">` element;
6. waits for `loadedmetadata`;
7. assigns the filename alias to a second native audio element;
8. waits for its `loadedmetadata`;
9. revokes the session.

Assert in Node that:

```js
if (!upstreamRequests.some(request =>
  request.authorization === "Bearer chromium68-probe-token" &&
  request.range === "bytes=0-"
)) throw new Error("Chromium 68 did not forward bearer Range media");

if (aliasApplicationRequests !== 0) {
  throw new Error("Filename alias escaped the service worker");
}
```

Also require `crypto.subtle`, `TextEncoder`, Service Worker, Fetch, ReadableStream, and Response APIs in the pinned engine check.

- [ ] **Step 6: Run full compatibility gates**

Run:

```powershell
npm run build -w @cloudframe/tv
node scripts/check-tv-bundle.mjs
npm run check:chromium68
npx vitest run tests/config.test.ts
npx playwright test e2e/browse-viewer.spec.ts --project=tv-1920
```

Expected: all PASS. Chromium output states that authenticated Range media and the filename alias loaded on revision `555668`.

- [ ] **Step 7: Commit**

```powershell
git add scripts/check-chromium68.mjs tests/config.test.ts tests/workspace.test.ts deploy/vercel-build-contract.json e2e/fixtures.ts e2e/browse-viewer.spec.ts
git commit -m "Verify direct media on Chromium 68"
```

---

### Task 9: Update active architecture documentation and run full verification

**Files:**
- Modify: `README.md`
- Modify: `PRODUCT.md`
- Modify: `DESIGN.md`
- Modify: `docs/operations/firebase-vercel-setup.md`
- Modify: `docs/operations/webos-acceptance.md`
- Modify: `docs/superpowers/specs/2026-08-27-vercel-control-plane-design.md`
- Modify: `docs/superpowers/specs/2026-08-29-google-media-streaming-design.md`
- Modify: `docs/superpowers/plans/2026-08-29-google-media-streaming.md`
- Modify: `tests/workspace.test.ts`
- Modify: `tests/design-materials.test.ts`

**Interfaces:**
- Consumes: completed runtime behavior from Tasks 2-8.
- Produces: one consistent active architecture statement and a supersession trail for the retired Vercel relay.

- [ ] **Step 1: Write failing documentation-contract tests**

Update `tests/workspace.test.ts` to require:

```ts
expect(`${readme}\n${product}`).toContain("media bytes go directly from Google and Microsoft");
expect(`${readme}\n${product}`).toContain("short-lived Google access token");
expect(`${readme}\n${product}`).not.toContain("Google media is streamed through");
```

Update `tests/design-materials.test.ts` required phrases:

```ts
for (const required of [
  "private Vercel Blob",
  "zero steady-state Firestore reads",
  "live Google Drive and OneDrive metadata",
  "local TV watch history",
  "browser-side authenticated direct delivery",
  "explicit recovery",
]) {
  expect(documentation).toContain(required);
}
```

Add a retired-claim assertion for `authenticated streaming` through Vercel.

- [ ] **Step 2: Run documentation tests and verify stale relay claims**

Run:

```powershell
npx vitest run tests/workspace.test.ts tests/design-materials.test.ts
```

Expected: FAIL on current relay language.

- [ ] **Step 3: Update active product and operations truth**

Every active document must state all of the following without euphemism:

- Vercel authorizes the approved TV and vends bounded media metadata.
- OneDrive returns its provider-signed direct URL.
- Google returns the raw Drive URL plus a short-lived bearer token to the approved TV.
- The root-scoped service worker attaches the bearer token and forwards Range requests directly to Google.
- Media bodies are never proxied, cached, stored, or transcoded by Cloudframe/Vercel.
- Tokens remain memory-only on the TV and cannot be revoked before expiry after vending.
- `access_token` query URLs are rejected and must not be reintroduced.
- Legacy MPEG gets one native filename retry; exact decoder support remains a real-TV result.

Mark the old streaming spec and plan at their top with:

```md
> Superseded by `docs/superpowers/specs/2026-08-29-direct-google-tv-media-design.md`.
> The Vercel Google media relay described below is retired and must not be implemented.
```

- [ ] **Step 4: Update the real webOS acceptance checklist**

Replace the old same-origin Google requirement with checks that:

- browser media requests use `https://www.googleapis.com/drive/v3/files/...` or the worker-only filename alias;
- Google receives `206` Range requests;
- Vercel logs show `/api/tv/media-url` but no `/api/tv/google-media/` requests;
- H.264/AAC MP4, full-size Google image, OneDrive regression, renewal, seeking, and resume pass;
- `MOV00516.MPG` records whether raw or filename attempt succeeds;
- if both attempts receive successful bytes and fail decode, the result is recorded as an exact decoder limitation rather than a transport failure.

- [ ] **Step 5: Run the full repository verification from a clean production build**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build:vercel
node scripts/check-tv-bundle.mjs
npm run check:chromium68
npx playwright test e2e/browse-viewer.spec.ts --project=tv-1920
git diff --check
```

Expected: every command passes. Record exact test counts and bundle sizes in the handoff; do not claim real-LG acceptance from synthetic tests.

- [ ] **Step 6: Commit**

```powershell
git add README.md PRODUCT.md DESIGN.md docs/operations/firebase-vercel-setup.md docs/operations/webos-acceptance.md docs/superpowers/specs/2026-08-27-vercel-control-plane-design.md docs/superpowers/specs/2026-08-29-google-media-streaming-design.md docs/superpowers/plans/2026-08-29-google-media-streaming.md tests/workspace.test.ts tests/design-materials.test.ts
git commit -m "Document direct Google TV media"
```

---

### Task 10: Run the separately authorized real-LG acceptance gate

**Files:**
- Verify only: `docs/operations/webos-acceptance.md`

**Interfaces:**
- Consumes: a preview deployment of the exact verified commit and the user's approved LG webOS 5+ television.
- Produces: `PASS` or `REAL_WEBOS_ACCEPTANCE_PENDING` with secret-safe evidence.

- [ ] **Step 1: Stop if preview deployment has not been authorized**

Deployment changes external state. Obtain explicit authorization before running Vercel deployment commands. Do not promote the production alias as part of local implementation verification.

- [ ] **Step 2: Build and deploy the exact candidate preview after authorization**

```powershell
npm run build:vercel
vercel deploy --prebuilt --target=preview
```

Record the commit, preview URL, TV model, webOS/browser version, network, and UTC start time without recording media URLs or tokens.

- [ ] **Step 3: Have the user operate the LG TV checklist**

Test:

1. Google H.264/AAC MP4 play, pause, seek, resume, and renewal.
2. Full-size Google image navigation.
3. OneDrive image/video regression.
4. `MOV00516.MPG`, recording whether the raw URL or filename alias succeeds.
5. Back/focus restoration and local resume.

- [ ] **Step 4: Verify no Vercel media-byte path**

Use secret-safe aggregate logs:

```powershell
vercel logs --environment preview --since 30m --no-branch --json
```

Confirm descriptor calls exist and the count of `/api/tv/google-media/` requests is zero. Do not print or save full dynamic browse handles, raw Google URLs, tokens, provider IDs, or response bodies.

- [ ] **Step 5: Record the bounded result**

- Mark `PASS` only if all applicable checks succeed on the real LG television.
- If `MOV00516.MPG` receives successful Google delivery on both native attempts but cannot decode, record `REAL_WEBOS_ACCEPTANCE_PENDING: MOV00516.MPG decoder profile unsupported` and attach only model/version/timestamp/HTTP-status-level evidence.
- Do not add transcoding, blob download, Vercel fallback, or query-token workarounds after a decoder limitation; those require a new approved design.
