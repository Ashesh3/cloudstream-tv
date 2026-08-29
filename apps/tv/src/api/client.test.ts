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
});
