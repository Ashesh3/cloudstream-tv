import type HlsType from "hls.js";
import type { ErrorData } from "hls.js";

export type HlsPlaybackMode = "native-hls" | "hls.js";

export interface HlsPlaybackHandle {
  mode: HlsPlaybackMode;
  destroy(): void;
}

export interface AttachHlsSourceOptions {
  onFatal(error: { kind: "network" | "media" | "unsupported" }): void;
  importHls?: () => Promise<typeof import("hls.js")>;
}

const HLS_MIME = "application/vnd.apple.mpegurl";
const PLAYLIST_PATH = /^\/api\/tv\/transcodes\/([A-Za-z0-9_-]{43})\/master\.m3u8$/u;

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
  let detachListeners = () => undefined;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    detachListeners();
    engine?.destroy();
    video.removeAttribute("src");
    video.load();
  };

  if (video.canPlayType(HLS_MIME) !== "") {
    video.src = playlistUrl;
    return { mode: "native-hls", destroy };
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
      kind: data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "media",
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
  return { mode: "hls.js", destroy };
}
