// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("TV transcode API", () => {
  it("requests explicit HLS fallback and sends no-content heartbeat/release calls", async () => {
    const sessionId = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: {
        itemId: "item_video",
        kind: "video",
        transport: "hls",
        playlistUrl: `/api/tv/transcodes/${sessionId}/master.m3u8`,
        playbackSessionId: sessionId,
        durationSeconds: 65.832,
        profile: "h264-aac-1080p-v1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        revision: "revision-7",
      } })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);
    const { tvApi } = await import("./client");
    const signal = new AbortController().signal;

    await tvApi.mediaUrl("sealed", signal, { itemId: "item_video", kind: "video" }, { fallback: "hls" });
    await tvApi.heartbeatTranscode(sessionId);
    await tvApi.releaseTranscode(sessionId);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/tv/media-url", expect.objectContaining({
      credentials: "include",
      body: JSON.stringify({ handle: "sealed", fallback: "hls" }),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/tv/transcodes/${sessionId}/heartbeat`, expect.objectContaining({ method: "POST", credentials: "include" }));
    expect(fetcher).toHaveBeenNthCalledWith(3, `/api/tv/transcodes/${sessionId}`, expect.objectContaining({ method: "DELETE", credentials: "include" }));
    expect(new Headers(fetcher.mock.calls[1]![1].headers).has("origin")).toBe(false);
  });

  it.each([
    ["TRANSCODER_BUSY", "Another TV is using the transcoder."],
    ["TRANSCODER_CACHE_FULL", "The transcode cache does not have enough free space."],
    ["TRANSCODER_WINDOW_TIMEOUT", "Cloudframe could not prepare this part of the video in time."],
    ["TRANSCODER_UNSUPPORTED", "Cloudframe cannot transcode this video format."],
    ["TRANSCODER_SOURCE_UNAVAILABLE", "Cloudframe could not read this video from its source."],
    ["TRANSCODER_FAILED", "Cloudframe could not transcode this video."],
  ])("keeps the %s code and maps it to a safe TV message", async (code, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: { code } }), {
      status: code === "TRANSCODER_BUSY" ? 409 : 502,
      headers: { "content-type": "application/json" },
    })));
    const { tvApi } = await import("./client");

    await expect(tvApi.mediaUrl("sealed", undefined, { itemId: "item_video", kind: "video" }, { fallback: "hls" }))
      .rejects.toMatchObject({ code, message });
  });
});
