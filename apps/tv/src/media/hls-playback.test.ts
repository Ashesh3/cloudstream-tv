// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import { attachHlsSource } from "./hls-playback";

const PLAYLIST = "/api/tv/transcodes/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG/master.m3u8";

describe("HLS playback attachment", () => {
  it("uses native HLS without importing hls.js", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    const load = vi.spyOn(video, "load").mockImplementation(() => undefined);
    const importHls = vi.fn();

    const handle = await attachHlsSource(video, PLAYLIST, {
      onFatal: vi.fn(),
      importHls,
    });

    expect(handle.mode).toBe("native-hls");
    expect(handle.handlesElementErrors).toBe(true);
    expect(video.getAttribute("src")).toBe(PLAYLIST);
    expect(importHls).not.toHaveBeenCalled();
    handle.destroy();
    handle.destroy();
    expect(video.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("probes a failed native-HLS segment route and reports its safe transcode code", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    const onFatal = vi.fn();
    const inspectNativeError = vi.fn(async () => "cache-full" as const);
    await attachHlsSource(video, PLAYLIST, { onFatal, inspectNativeError });

    video.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(inspectNativeError).toHaveBeenCalledWith(PLAYLIST));

    expect(onFatal).toHaveBeenCalledWith({ kind: "cache-full" });
  });

  it("falls back to generic media failure when native-HLS diagnostics are unavailable", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    const onFatal = vi.fn();
    await attachHlsSource(video, PLAYLIST, { onFatal, inspectNativeError: vi.fn(async () => null) });

    video.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith({ kind: "media" }));
  });

  it("queries the protected session failure endpoint without replaying a segment", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: { code: "TRANSCODER_WINDOW_TIMEOUT" } }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    vi.stubGlobal("fetch", fetcher);
    const onFatal = vi.fn();
    await attachHlsSource(video, PLAYLIST, { onFatal });

    video.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith({ kind: "timeout" }));

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ pathname: expect.stringMatching(/\/failure$/u) }), expect.objectContaining({ credentials: "include", cache: "no-store", signal: expect.any(AbortSignal) }));
    vi.unstubAllGlobals();
  });

  it("reports a generic native-HLS media failure when diagnostics exceed their deadline", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const onFatal = vi.fn();
    await attachHlsSource(video, PLAYLIST, { onFatal });

    video.dispatchEvent(new Event("error"));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onFatal).toHaveBeenCalledWith({ kind: "media" });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("aborts a native-HLS diagnostic when playback is destroyed", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    let requestSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      requestSignal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }));
    const onFatal = vi.fn();
    const handle = await attachHlsSource(video, PLAYLIST, { onFatal });
    video.dispatchEvent(new Event("error"));
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    handle.destroy();

    expect(requestSignal.aborted).toBe(true);
    await Promise.resolve();
    expect(onFatal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("attaches one credentialed hls.js engine and loads only after MEDIA_ATTACHED", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    const fake = fakeHlsModule(true);

    const handle = await attachHlsSource(video, PLAYLIST, {
      onFatal: vi.fn(),
      importHls: async () => fake.module,
    });

    expect(handle.mode).toBe("hls.js");
    expect(handle.handlesElementErrors).toBe(true);
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]!.config.enableWorker).toBe(false);
    const xhr = { withCredentials: false } as XMLHttpRequest;
    fake.instances[0]!.config.xhrSetup(xhr);
    expect(xhr.withCredentials).toBe(true);
    expect(fake.instances[0]!.attachMedia).toHaveBeenCalledWith(video);
    expect(fake.instances[0]!.loadSource).not.toHaveBeenCalled();

    fake.instances[0]!.emit("media-attached", undefined);
    expect(fake.instances[0]!.loadSource).toHaveBeenCalledWith(PLAYLIST);
  });

  it.each([
    ["networkError", "network"],
    ["mediaError", "media"],
  ] as const)("reports one fatal %s and destroys the engine", async (type, kind) => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("");
    const load = vi.spyOn(video, "load").mockImplementation(() => undefined);
    const onFatal = vi.fn();
    const fake = fakeHlsModule(true);
    const handle = await attachHlsSource(video, PLAYLIST, {
      onFatal,
      importHls: async () => fake.module,
    });
    const engine = fake.instances[0]!;

    engine.emit("error", { fatal: false, type });
    expect(onFatal).not.toHaveBeenCalled();
    engine.emit("error", { fatal: true, type });
    engine.emit("error", { fatal: true, type });

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith({ kind });
    expect(engine.startLoad).not.toHaveBeenCalled();
    expect(engine.recoverMediaError).not.toHaveBeenCalled();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    handle.destroy();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, "TRANSCODER_BUSY", "busy"],
    [507, "TRANSCODER_CACHE_FULL", "cache-full"],
    [504, "TRANSCODER_WINDOW_TIMEOUT", "timeout"],
    [502, "TRANSCODER_UNSUPPORTED", "unsupported-source"],
    [503, "TRANSCODER_SOURCE_UNAVAILABLE", "source"],
    [502, "TRANSCODER_FAILED", "failed"],
  ] as const)("maps a fatal HLS HTTP %s %s response to %s", async (status, code, kind) => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("");
    vi.spyOn(video, "load").mockImplementation(() => undefined);
    const onFatal = vi.fn();
    const fake = fakeHlsModule(true);
    await attachHlsSource(video, PLAYLIST, { onFatal, importHls: async () => fake.module });

    fake.instances[0]!.emit("error", {
      fatal: true,
      type: "networkError",
      response: { code: status, text: JSON.stringify({ ok: false, error: { code } }) },
    });

    expect(onFatal).toHaveBeenCalledWith({ kind });
  });

  it("reports unsupported playback without assigning a source", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("");
    const onFatal = vi.fn();
    const fake = fakeHlsModule(false);

    await expect(attachHlsSource(video, PLAYLIST, {
      onFatal,
      importHls: async () => fake.module,
    })).rejects.toThrow("HLS playback is unsupported");

    expect(onFatal).toHaveBeenCalledWith({ kind: "unsupported" });
    expect(video.hasAttribute("src")).toBe(false);
    expect(fake.instances).toHaveLength(0);
  });

  it("rejects non-transcode and cross-origin playlist URLs before attachment", async () => {
    const video = document.createElement("video");
    vi.spyOn(video, "canPlayType").mockReturnValue("maybe");
    const onFatal = vi.fn();

    await expect(attachHlsSource(video, "https://evil.example/master.m3u8", {
      onFatal,
    })).rejects.toThrow("Invalid HLS playlist URL");

    expect(onFatal).toHaveBeenCalledWith({ kind: "unsupported" });
    expect(video.hasAttribute("src")).toBe(false);
  });
});

function fakeHlsModule(supported: boolean) {
  const instances: FakeHls[] = [];
  class Hls {
    static readonly Events = { MEDIA_ATTACHED: "media-attached", ERROR: "error" };
    static readonly ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    static isSupported() { return supported; }

    constructor(config: HlsConfig) {
      const instance = new FakeHls(config);
      instances.push(instance);
      return instance;
    }
  }
  return {
    instances,
    module: { default: Hls } as unknown as typeof import("hls.js"),
  };
}

interface HlsConfig {
  enableWorker: boolean;
  xhrSetup(xhr: XMLHttpRequest): void;
}

class FakeHls {
  readonly listeners = new Map<string, Set<(event: string, data: any) => void>>();
  readonly attachMedia = vi.fn();
  readonly loadSource = vi.fn();
  readonly destroy = vi.fn();
  readonly startLoad = vi.fn();
  readonly recoverMediaError = vi.fn();

  constructor(readonly config: HlsConfig) {}

  on(event: string, listener: (event: string, data: any) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (event: string, data: any) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, data: any) {
    this.listeners.get(event)?.forEach(listener => listener(event, data));
  }
}
