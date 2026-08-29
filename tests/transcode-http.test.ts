import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TranscodeError,
  createControlRequestContextScope,
  createTranscodeApiApp,
  transcodeProfile,
  type AuthenticatedControlDevice,
  type ControlAuth,
  type ControlPlaneStore,
  type TranscodeCoordinator,
  type TranscodePlaybackSession,
  type TranscodeSourceAuthorizer,
} from "@cloudframe/server";
import { TEST_NOW, testControlDocument } from "./helpers/control-plane";

const directories: string[] = [];
const origin = "https://tv.example.com";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "cloudframe-transcode-http-"));
  directories.push(directory);
  const segmentPath = join(directory, "0.ts");
  await mkdir(directory, { recursive: true });
  await writeFile(segmentPath, Buffer.alloc(188, 7));
  const document = testControlDocument();
  const device: AuthenticatedControlDevice = {
    householdId: "h1",
    deviceId: "device-1",
    sessionVersion: 1,
    device: structuredClone(document.devices["device-1"]!),
    context: { document, revision: 1 },
  };
  const session: TranscodePlaybackSession = {
    id: "session_abcdefghijklmnopqrstuvwxyz123456",
    binding: {
      householdId: "h1", deviceId: "device-1", deviceSessionVersion: 1,
      sourceId: "source-1", rootId: "root-1", rootProviderNodeId: "provider-trips",
      providerNodeId: "video-1", provider: "google", itemId: "item-1",
      name: "MOV00516.MPG", mimeType: "video/mpeg", size: 12_345,
      contentRevision: "revision-7", credentialVersion: 1,
    },
    cacheKey: "a".repeat(64),
    probe: { durationMs: 43_250, container: "mpeg", videoCodec: "mpeg2video", audioCodec: "mp2", width: 640, height: 360, pixelFormat: "yuv420p", frameRate: 25 },
    profile: transcodeProfile("auto"),
    expiresAt: TEST_NOW.getTime() + 45_000,
  };
  const store: ControlPlaneStore = {
    load: async () => ({ document, etag: "r1" }),
    mutate: async () => { throw new Error("unused"); },
  };
  const auth: ControlAuth = {
    admin: vi.fn().mockResolvedValue({ householdId: "h1", sessionId: "admin-session-1", adminPassphraseVersion: 1, csrfToken: "csrf-refresh" }),
    device: vi.fn().mockResolvedValue(device),
    login: async () => { throw new Error("unused"); },
    logout: () => { throw new Error("unused"); },
  };
  const coordinator = {
    session: vi.fn().mockReturnValue(session),
    heartbeat: vi.fn(),
    segment: vi.fn().mockResolvedValue({ path: segmentPath, sizeBytes: 188, sha256: "b".repeat(64), durationMs: 4_000, segmentIndex: 0 }),
    playbackFailure: vi.fn().mockReturnValue(null),
    release: vi.fn().mockResolvedValue(undefined),
    diagnostic: vi.fn().mockReturnValue({
      active: { sessionIdSuffix: "12345678", itemName: "MOV00516.MPG", provider: "google", stage: "encoding", windowIndex: 2, progressPercent: 61, speed: "1.4x" },
      leaseDeviceName: "Living Room", queuedDemandedWindows: 3, busyRejections: 4, cacheBytes: 1024, lastErrorCode: "TRANSCODER_BUSY",
    }),
  } as unknown as TranscodeCoordinator;
  const sourceAuthorizer = {
    validateCurrent: vi.fn().mockReturnValue({}),
  } as unknown as TranscodeSourceAuthorizer;
  const releasePin = vi.fn();
  const cache = { pinServed: vi.fn().mockReturnValue(releasePin) };
  const app = createTranscodeApiApp({
    controlStore: store,
    requestContext: createControlRequestContextScope(),
    auth,
    sourceAuthorizer,
    coordinator,
    cache,
    cacheMaxBytes: 50 * 1024 * 1024,
    allowedOrigin: origin,
    now: () => TEST_NOW,
  });
  return { app, auth, coordinator, sourceAuthorizer, cache, releasePin, session };
}

function request(path: string, method = "GET", headers: HeadersInit = {}) {
  return new Request(`${origin}${path}`, { method, headers: { cookie: "device_session=sealed", ...headers } });
}

describe("authenticated HLS routes", () => {
  it("protects the strict admin diagnostic DTO and omits internal identifiers", async () => {
    const current = await harness();
    vi.mocked(current.auth.admin).mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { code: "ADMIN_UNAUTHORIZED" }));
    expect((await current.app(request("/api/admin/transcodes/status")))?.status).toBe(401);

    const response = await current.app(request("/api/admin/transcodes/status"));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("x-csrf-token")).toBe("csrf-refresh");
    expect(await response?.json()).toEqual({ ok: true, data: {
      active: { itemName: "MOV00516.MPG", provider: "google", stage: "encoding", windowIndex: 2, progressPercent: 61, speed: "1.4x" },
      leaseDeviceName: "Living Room", queuedDemandedWindows: 3, busyRejections: 4,
      cacheBytes: 1024, cacheMaxBytes: 50 * 1024 * 1024, lastErrorCode: "TRANSCODER_BUSY",
    } });
    const serialized = JSON.stringify(await current.coordinator.diagnostic());
    expect(JSON.stringify(await (await current.app(request("/api/admin/transcodes/status")))?.json())).not.toMatch(/12345678|providerNodeId|sourceUrl|cacheKey|capability|stderr|cookie|bearer|access_token/i);
    expect(serialized).toContain("12345678");
  });
  it("serves master and complete media playlists with private same-origin headers", async () => {
    const current = await harness();
    const master = await current.app(request(`/api/tv/transcodes/${current.session.id}/master.m3u8`));
    expect(master?.status).toBe(200);
    expect(master?.headers.get("content-type")).toContain("application/vnd.apple.mpegurl");
    expect(master?.headers.get("cache-control")).toBe("private, no-store");
    expect(master?.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(await master?.text()).toContain("stream.m3u8");

    const media = await current.app(request(`/api/tv/transcodes/${current.session.id}/stream.m3u8`));
    expect(await media?.text()).toContain("segments/10.ts");
    expect(current.sourceAuthorizer.validateCurrent).toHaveBeenCalledTimes(2);
  });

  it("streams a complete segment and releases its cache pin at EOF", async () => {
    const current = await harness();
    const response = await current.app(request(`/api/tv/transcodes/${current.session.id}/segments/0.ts`));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toBe("video/mp2t");
    expect(response?.headers.get("content-length")).toBe("188");
    expect(response?.headers.get("cache-control")).toBe("private, max-age=3600, immutable");
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(Buffer.alloc(188, 7));
    expect(current.cache.pinServed).toHaveBeenCalledWith(current.session.cacheKey, 0);
    expect(current.releasePin).toHaveBeenCalledOnce();
  });

  it("requires exact origin for heartbeat and release", async () => {
    const current = await harness();
    const heartbeat = await current.app(request(`/api/tv/transcodes/${current.session.id}/heartbeat`, "POST", { origin }));
    expect(heartbeat?.status).toBe(204);
    expect(current.coordinator.heartbeat).toHaveBeenCalledWith(current.session.id, "device-1");
    const release = await current.app(request(`/api/tv/transcodes/${current.session.id}`, "DELETE", { origin }));
    expect(release?.status).toBe(204);
    expect(current.coordinator.release).toHaveBeenCalledWith(current.session.id, "device-1");

    for (const badOrigin of [undefined, "https://other.example.com"]) {
      const denied = await current.app(request(`/api/tv/transcodes/${current.session.id}/heartbeat`, "POST", badOrigin ? { origin: badOrigin } : {}));
      expect(denied?.status).toBe(403);
    }
  });

  it("returns the exact latest playback failure without probing another segment", async () => {
    const current = await harness();
    vi.mocked(current.coordinator.playbackFailure).mockReturnValueOnce({ code: "TRANSCODER_WINDOW_TIMEOUT" });

    const response = await current.app(request(`/api/tv/transcodes/${current.session.id}/failure`));

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.json()).toEqual({ ok: true, data: { code: "TRANSCODER_WINDOW_TIMEOUT" } });
    expect(current.coordinator.segment).not.toHaveBeenCalled();
    expect(current.coordinator.playbackFailure).toHaveBeenCalledWith(current.session.id);
  });

  it("returns no content when the session has no recorded playback failure", async () => {
    const current = await harness();
    expect((await current.app(request(`/api/tv/transcodes/${current.session.id}/failure`)))?.status).toBe(204);
  });

  it.each([
    [new TranscodeError("TRANSCODER_BUSY"), 409],
    [new TranscodeError("TRANSCODER_CACHE_FULL"), 507],
    [new TranscodeError("TRANSCODER_WINDOW_TIMEOUT"), 504],
    [new TranscodeError("TRANSCODER_SOURCE_UNAVAILABLE"), 503],
    [new TranscodeError("TRANSCODER_FAILED"), 502],
    [new TranscodeError("TRANSCODER_SESSION_EXPIRED"), 410],
  ])("maps %s without leaking paths or diagnostics", async (error, status) => {
    const current = await harness();
    vi.mocked(current.coordinator.segment).mockRejectedValueOnce(error);
    const response = await current.app(request(`/api/tv/transcodes/${current.session.id}/segments/0.ts`));
    expect(response?.status).toBe(status);
    const body = await response?.text();
    expect(body).toContain(error.code);
    expect(body).not.toMatch(/stderr|\\cache|providerNodeId/);
  });

  it("rejects wrong device, expired session, invalid index, traversal, method, and unknown path", async () => {
    const current = await harness();
    vi.mocked(current.coordinator.session).mockReturnValueOnce(null);
    expect((await current.app(request(`/api/tv/transcodes/${current.session.id}/master.m3u8`)))?.status).toBe(410);
    vi.mocked(current.coordinator.session).mockReturnValue(current.session);
    current.session.binding.deviceId = "device-2";
    expect((await current.app(request(`/api/tv/transcodes/${current.session.id}/master.m3u8`)))?.status).toBe(401);
    current.session.binding.deviceId = "device-1";
    expect((await current.app(request(`/api/tv/transcodes/${current.session.id}/segments/-1.ts`)))?.status).toBe(400);
    expect((await current.app(request(`/api/tv/transcodes/${current.session.id}/segments/%2e%2e.ts`)))?.status).toBe(404);
    expect((await current.app(request(`/api/tv/transcodes/${current.session.id}/master.m3u8`, "POST")))?.status).toBe(405);
    await expect(current.app(request("/api/tv/media-url"))).resolves.toBeNull();
  });
});
