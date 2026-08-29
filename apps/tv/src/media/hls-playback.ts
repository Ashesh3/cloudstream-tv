import type HlsType from "hls.js";
import type { ErrorData } from "hls.js";

export type HlsPlaybackMode = "native-hls" | "hls.js";

export interface HlsPlaybackHandle {
  mode: HlsPlaybackMode;
  handlesElementErrors: boolean;
  destroy(): void;
}

export type HlsPlaybackErrorKind = "network" | "media" | "unsupported" | "busy" | "cache-full" | "timeout" | "unsupported-source" | "source" | "failed";

export interface AttachHlsSourceOptions {
  onFatal(error: { kind: HlsPlaybackErrorKind }): void;
  importHls?: () => Promise<typeof import("hls.js")>;
  inspectNativeError?: (playlistUrl: string) => Promise<HlsPlaybackErrorKind | null>;
}

const HLS_MIME = "application/vnd.apple.mpegurl";
const PLAYLIST_PATH = /^\/api\/tv\/transcodes\/([A-Za-z0-9_-]{43})\/master\.m3u8$/u;
const NATIVE_DIAGNOSTIC_TIMEOUT_MS = 2_000;
const ERROR_BODY_LIMIT_BYTES = 4 * 1024;

export async function attachHlsSource(
  video: HTMLVideoElement,
  playlistUrl: string,
  options: AttachHlsSourceOptions,
): Promise<HlsPlaybackHandle> {
  if (!PLAYLIST_PATH.test(playlistUrl)) {
    options.onFatal({ kind: "unsupported" });
    throw new Error("Invalid HLS playlist URL");
  }

  let destroyed = false;
  let engine: HlsType | null = null;
  let diagnosticController: AbortController | null = null;
  let detachListeners: () => void = () => undefined;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    detachListeners();
    diagnosticController?.abort();
    engine?.destroy();
    video.removeAttribute("src");
    video.load();
  };

  if (video.canPlayType(HLS_MIME) !== "") {
    let failed = false;
    const onNativeError = () => {
      if (destroyed || failed) return;
      failed = true;
      const inspect = options.inspectNativeError ?? ((url: string) => {
        diagnosticController = new AbortController();
        return inspectNativeHlsError(url, diagnosticController.signal);
      });
      void inspect(playlistUrl).then(kind => {
        if (!destroyed) options.onFatal({ kind: kind ?? "media" });
      }, () => {
        if (!destroyed) options.onFatal({ kind: "media" });
      });
    };
    video.addEventListener("error", onNativeError);
    detachListeners = () => video.removeEventListener("error", onNativeError);
    video.src = playlistUrl;
    return { mode: "native-hls", handlesElementErrors: true, destroy };
  }

  const imported = await (options.importHls ?? (() => import("hls.js")))();
  const Hls = imported.default;
  if (!Hls.isSupported()) {
    options.onFatal({ kind: "unsupported" });
    throw new Error("HLS playback is unsupported");
  }

  engine = new Hls({
    enableWorker: false,
    xhrSetup(xhr) {
      xhr.withCredentials = true;
    },
  });
  let failed = false;
  const onAttached = () => {
    if (!destroyed) engine?.loadSource(playlistUrl);
  };
  const onError = (_event: string, data: ErrorData) => {
    if (!data.fatal || failed || destroyed) return;
    failed = true;
    options.onFatal({
      kind: transcodeErrorKind(data) ?? (data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "media"),
    });
    destroy();
  };
  engine.on(Hls.Events.MEDIA_ATTACHED, onAttached);
  engine.on(Hls.Events.ERROR, onError);
  detachListeners = () => {
    engine?.off(Hls.Events.MEDIA_ATTACHED, onAttached);
    engine?.off(Hls.Events.ERROR, onError);
  };
  engine.attachMedia(video);
  return { mode: "hls.js", handlesElementErrors: true, destroy };
}

async function inspectNativeHlsError(playlistUrl: string, outerSignal: AbortSignal): Promise<HlsPlaybackErrorKind | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outerSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), NATIVE_DIAGNOSTIC_TIMEOUT_MS);
  try {
    const failureUrl = new URL("failure", new URL(playlistUrl, location.origin));
    const response = await fetch(failureUrl, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 204) return null;
    if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
    const text = await boundedText(response, ERROR_BODY_LIMIT_BYTES);
    return transcodeCodeKind(parseSuccessCode(text));
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    outerSignal.removeEventListener("abort", abort);
  }
}

async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) throw new Error("HLS_DIAGNOSTIC_BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(output);
}

function transcodeErrorKind(data: ErrorData): HlsPlaybackErrorKind | null {
  const response = data.response as { text?: unknown } | undefined;
  if (typeof response?.text !== "string" || response.text.length > 4096) return null;
  try {
    return transcodeCodeKind(parseErrorCode(response.text));
  } catch { /* A non-JSON network error retains its generic HLS classification. */ }
  return null;
}

function parseErrorCode(text: string): string {
  const payload = JSON.parse(text) as { error?: { code?: unknown }; code?: unknown };
  return typeof payload?.error?.code === "string" ? payload.error.code : typeof payload?.code === "string" ? payload.code : "";
}

function parseSuccessCode(text: string): string {
  const payload = JSON.parse(text) as { ok?: unknown; data?: { code?: unknown } };
  return payload?.ok === true && typeof payload.data?.code === "string" ? payload.data.code : "";
}

function transcodeCodeKind(code: string): HlsPlaybackErrorKind | null {
  if (code === "TRANSCODER_BUSY") return "busy";
  if (code === "TRANSCODER_CACHE_FULL") return "cache-full";
  if (code === "TRANSCODER_WINDOW_TIMEOUT") return "timeout";
  if (code === "TRANSCODER_UNSUPPORTED") return "unsupported-source";
  if (code === "TRANSCODER_SOURCE_UNAVAILABLE") return "source";
  if (code === "TRANSCODER_FAILED") return "failed";
  return null;
}
