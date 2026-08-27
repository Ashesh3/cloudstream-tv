import type { DirectThumbnailItem, TvBrowseItemDto } from "@cloudframe/shared";
import {
  activeViewerItem,
  calculateBufferedPercent,
  clampVideoSeek,
  createViewerState,
  historySnapshot,
  normalizeTvKey,
  pendingViewerUrlRequests,
  shouldHandleTvKey,
  viewerReducer,
  type ViewerMediaItem
} from "@cloudframe/tv-core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "preact/hooks";

import type { TvApi } from "../api/client";
import type { LocalWatchHistory } from "../state/local-watch-history";
import { ImageViewer } from "./image-viewer";
import { VideoPlayer } from "./video-player";
import { ViewerOverlay } from "./viewer-overlay";

export function Viewer({ api, history, items, selectedItemId, slideshowSeconds, previews, onClose, onUnauthorized = () => undefined, onNavigationExpired = () => undefined }: {
  api: TvApi;
  history: LocalWatchHistory;
  items: TvBrowseItemDto[];
  selectedItemId: string;
  slideshowSeconds: number;
  previews: Record<string, DirectThumbnailItem>;
  onClose: (restorationItemId: string) => void;
  onUnauthorized?: () => void;
  onNavigationExpired?: () => void;
}) {
  const viewerItems = useMemo(() => items.map(toViewerItem), [items]);
  const itemHandles = useMemo(() => {
    const result: Record<string, string> = {};
    items.forEach(item => { result[item.id] = item.handle; });
    return result;
  }, [items]);
  const [state, dispatch] = useReducer(viewerReducer, undefined, () => createViewerState(viewerItems, selectedItemId));
  const [historyAvailable, setHistoryAvailable] = useState(history.available);
  const [buffering, setBuffering] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const active = activeViewerItem(state);
  const activeUrl = state.urls[active.id];
  const urlRequests = pendingViewerUrlRequests(state);
  const urlRequestKey = urlRequests.map(request => `${request.nodeId}:${request.requestId}`).join("|");
  const associatedVideo = useRef<{ itemId: string; element: HTMLVideoElement } | null>(null);
  const lastVideoElements = useRef<Record<string, HTMLVideoElement>>({});
  const inflightUrls = useRef<Record<string, { requestId: number; controller: AbortController }>>({});
  const startedUrlRequests = useRef<Record<string, boolean>>({});
  const latestResumeOverrides = useRef<Record<string, number>>({});
  const latestVideoPositions = useRef<Record<string, number>>({});
  const lastSavedSnapshots = useRef<Record<string, string>>({});
  const [resumeOverrides, setResumeOverrides] = useState<Record<string, number>>({});
  const closed = useRef(false);
  const unauthorized = useRef(false);
  const navigationExpired = useRef(false);
  const mounted = useRef(true);

  const abortUrlRequests = useCallback(() => {
    Object.keys(inflightUrls.current).forEach(nodeId => inflightUrls.current[nodeId]!.controller.abort());
    inflightUrls.current = {};
    startedUrlRequests.current = {};
  }, []);

  const propagateUnauthorized = useCallback((error: unknown): boolean => {
    if (!isDeviceUnauthorized(error)) return false;
    if (unauthorized.current) return true;
    unauthorized.current = true;
    closed.current = true;
    abortUrlRequests();
    const element = videoElementFor(active.id);
    if (element) element.pause();
    onUnauthorized();
    return true;
  }, [abortUrlRequests, active.id, onUnauthorized]);

  const propagateNavigationExpired = useCallback((error: unknown): boolean => {
    if (!isNavigationExpired(error)) return false;
    if (navigationExpired.current) return true;
    navigationExpired.current = true;
    closed.current = true;
    abortUrlRequests();
    const element = videoElementFor(active.id);
    if (element) element.pause();
    onNavigationExpired();
    return true;
  }, [abortUrlRequests, active.id, onNavigationExpired]);

  const saveElementHistory = useCallback((itemId: string, element: HTMLVideoElement | null) => {
    if (!element || unauthorized.current || !Number.isFinite(element.currentTime) || element.currentTime < 0 || !Number.isFinite(element.duration) || element.duration <= 0) return;
    latestVideoPositions.current[itemId] = element.currentTime;
    const value = historySnapshot(element.currentTime, element.duration);
    const snapshotKey = `${value.positionSeconds}:${value.durationSeconds}:${value.completed ? 1 : 0}:${history.available ? 1 : 0}`;
    if (lastSavedSnapshots.current[itemId] === snapshotKey) return;
    lastSavedSnapshots.current[itemId] = snapshotKey;
    history.save(itemId, value);
    if (!history.available) setHistoryAvailable(false);
  }, [history]);

  const associateVideo = useCallback((itemId: string, element: HTMLVideoElement | null) => {
    const current = associatedVideo.current;
    if (!element) {
      if (current?.itemId === itemId) {
        saveElementHistory(current.itemId, current.element);
        if (associatedVideo.current === current) associatedVideo.current = null;
      }
      return;
    }
    if (current && (current.itemId !== itemId || current.element !== element)) {
      current.element.pause();
      saveElementHistory(current.itemId, current.element);
      if (associatedVideo.current === current) associatedVideo.current = null;
    }
    associatedVideo.current = { itemId, element };
    lastVideoElements.current[itemId] = element;
  }, [saveElementHistory]);

  const videoRef = useCallback((element: HTMLVideoElement | null) => {
    associateVideo(active.id, element);
  }, [active.id, associateVideo]);

  function videoElementFor(itemId: string): HTMLVideoElement | null {
    const current = associatedVideo.current;
    return current?.itemId === itemId ? current.element : lastVideoElements.current[itemId] ?? null;
  }

  useEffect(() => {
    if (unauthorized.current) return;
    Object.keys(inflightUrls.current).forEach(nodeId => {
      const request = inflightUrls.current[nodeId]!;
      const wanted = state.urls[nodeId];
      if (!wanted || wanted.status !== "loading" || wanted.requestId !== request.requestId) {
        request.controller.abort();
        delete inflightUrls.current[nodeId];
      }
    });
    urlRequests.forEach(({ nodeId, requestId }) => {
      const entry = state.urls[nodeId]!;
      if (inflightUrls.current[nodeId]?.requestId === requestId) return;
      const requestKey = `${nodeId}:${requestId}`;
      if (startedUrlRequests.current[requestKey]) return;
      startedUrlRequests.current[requestKey] = true;
      const controller = new AbortController();
      inflightUrls.current[nodeId] = { requestId, controller };
      const handle = itemHandles[nodeId];
      if (!handle) {
        dispatch({ type: "url-failed", nodeId, requestId: entry.requestId, kind: "authorization" });
        return;
      }
      void api.mediaUrl(handle, controller.signal).then(result => {
        if (!controller.signal.aborted && !unauthorized.current && mounted.current) {
          delete inflightUrls.current[nodeId];
          const expected = items.find(item => item.id === nodeId);
          if (!expected || result.itemId !== nodeId || result.kind !== expected.kind) {
            dispatch({ type: "url-failed", nodeId, requestId: entry.requestId, kind: "authorization" });
            return;
          }
          dispatch({ type: "url-ready", nodeId, requestId: entry.requestId, url: result.url, revision: result.revision });
        }
      }).catch(error => {
        if (controller.signal.aborted || unauthorized.current || !mounted.current) return;
        delete inflightUrls.current[nodeId];
        if (propagateUnauthorized(error) || propagateNavigationExpired(error)) return;
        if (isAuthorizationEvidence(error)) dispatch({ type: "authorization-expired", nodeId, resumeSeconds: entry.resumeSeconds });
        else dispatch({ type: "url-failed", nodeId, requestId: entry.requestId, kind: "generic" });
      });
    });
  }, [api, itemHandles, items, propagateNavigationExpired, propagateUnauthorized, urlRequestKey]);

  useEffect(() => () => {
    mounted.current = false;
    abortUrlRequests();
  }, [abortUrlRequests]);

  useEffect(() => {
    setCurrentSeconds(0);
    setDurationSeconds(0);
    setBuffering(false);
    setBufferedPercent(0);
  }, [active.id, active.kind, activeUrl?.url]);

  useEffect(() => {
    const element = videoElementFor(active.id);
    if (!element || active.kind !== "video") return;
    if (state.playbackIntent === "play") void element.play().catch(() => dispatch({ type: "media-error", nodeId: active.id, kind: "generic" }));
    else element.pause();
  }, [active.id, active.kind, activeUrl?.url, state.playbackIntent]);

  useEffect(() => {
    if (!state.slideshowActive || active.kind !== "image") return;
    const timer = window.setTimeout(() => { if (!unauthorized.current && mounted.current) dispatch({ type: "slideshow-tick" }); }, Math.max(1, slideshowSeconds) * 1_000);
    return () => window.clearTimeout(timer);
  }, [active.id, active.kind, slideshowSeconds, state.slideshowActive]);

  useEffect(() => {
    if (!state.videoPlaying || active.kind !== "video" || state.overlayOpen) return;
    const timer = window.setTimeout(() => { if (!unauthorized.current && mounted.current) dispatch({ type: "controls-timeout" }); }, 4_000);
    return () => window.clearTimeout(timer);
  }, [active.id, active.kind, state.controlsVisible, state.overlayOpen, state.videoPlaying]);

  useEffect(() => {
    if (active.kind !== "video" || !state.videoPlaying) return;
    const timer = window.setInterval(() => saveElementHistory(active.id, videoElementFor(active.id)), 15_000);
    return () => window.clearInterval(timer);
  }, [active.id, active.kind, saveElementHistory, state.videoPlaying]);

  const close = useCallback(() => {
    if (closed.current || unauthorized.current || !mounted.current) return;
    if (active.kind === "video") saveElementHistory(active.id, videoElementFor(active.id));
    closed.current = true;
    abortUrlRequests();
    dispatch({ type: "back" });
    onClose(state.restorationItemId);
  }, [abortUrlRequests, active.id, active.kind, onClose, saveElementHistory, state.restorationItemId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" && active.kind === "video") saveElementHistory(active.id, videoElementFor(active.id));
    };
    const onPageHide = () => { if (active.kind === "video") saveElementHistory(active.id, videoElementFor(active.id)); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [active.id, active.kind, saveElementHistory]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (unauthorized.current || !mounted.current) return;
      const action = normalizeTvKey(event);
      if (action && shouldHandleTvKey(action, event.repeat)) {
        dispatch({ type: "activity" });
        if (action === "left") dispatch({ type: "navigate", direction: -1 });
        else if (action === "right") dispatch({ type: "navigate", direction: 1 });
        else if (action === "up") dispatch({ type: "overlay", open: true });
        else if (action === "down") dispatch({ type: "overlay", open: false });
        else if (action === "enter" || action === "play-pause") dispatch({ type: "enter" });
        else if (action === "play") dispatch({ type: "video-playing", nodeId: active.id });
        else if (action === "pause") dispatch({ type: "video-paused", nodeId: active.id });
        else if (action === "back") {
          if (state.overlayOpen) dispatch({ type: "back" });
          else close();
        } else return;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const code = event.keyCode || event.which;
      const video = videoElementFor(active.id);
      if ((code === 412 || code === 417) && active.kind === "video" && video) {
        video.currentTime = clampVideoSeek(video.currentTime, video.duration, code === 412 ? -10 : 10);
        dispatch({ type: "activity" });
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active.id, active.kind, close, state.overlayOpen]);

  const retry = () => {
    if (unauthorized.current || !mounted.current) return;
    const before = state.urls[active.id];
    const resumeSeconds = latestVideoPositions.current[active.id] || currentSeconds || videoElementFor(active.id)?.currentTime || 0;
    latestResumeOverrides.current[active.id] = resumeSeconds;
    setResumeOverrides(current => ({ ...current, [active.id]: resumeSeconds }));
    dispatch({ type: "manual-retry", nodeId: active.id, resumeSeconds });
    if (before?.refreshUsed) dispatch({ type: "media-error", nodeId: active.id, kind: "authorization" });
  };

  const onMediaError = (itemId: string, element: HTMLVideoElement | null) => {
    if (unauthorized.current || !mounted.current) return;
    saveElementHistory(itemId, element);
    if (element && Number.isFinite(element.currentTime) && element.currentTime >= 0) latestVideoPositions.current[itemId] = element.currentTime;
    dispatch({ type: "media-error", nodeId: itemId, kind: element?.error?.code === 4 ? "codec" : "generic" });
  };

  const historyEntry = history.get(active.id);
  const historyResume = historyEntry?.completed ? 0 : historyEntry?.positionSeconds ?? 0;
  return (
    <section className="viewer-shell" aria-label="Media viewer" data-media-kind={active.kind}>
      <span className="viewer-frame-corners" aria-hidden="true"><i /><i /><b /><b /></span>
      <div className="viewer-topline">
        <span>Program {state.index + 1} / {state.items.length}</span>
        <strong>{active.name}</strong>
        <span>Up: details · Back: collection</span>
      </div>
      {!historyAvailable ? <p className="viewer-history-status" role="status">Watch progress is unavailable on this TV, but playback will continue.</p> : null}
      {resumeOverrides[active.id] ? <span className="viewer-resume-note">Resuming at {formatResume(resumeOverrides[active.id]!)}</span> : null}
      <div className="viewer-stage">
        {state.mediaError?.kind === "codec" ? (
          <ViewerError title="This video format cannot play on this TV" item={active} body="Cloudframe streams the original file directly and does not transcode it. Try a browser-compatible H.264/AAC MP4." onRetry={retry} />
        ) : state.mediaError ? (
          <ViewerError title="This media could not be opened" item={active} body={activeUrl?.refreshUsed ? "A fresh link did not solve this media error." : "The provider link failed. You can request one fresh link safely."} onRetry={retry} />
        ) : active.kind === "image" ? (
          <ImageViewer item={active} url={activeUrl} previewUrl={previews[active.id]?.url} onError={() => onMediaError(active.id, null)} />
        ) : (
          <VideoPlayer
            key={active.id} item={active} url={activeUrl} videoRef={videoRef} controlsVisible={state.controlsVisible}
            buffering={buffering} currentSeconds={currentSeconds} durationSeconds={durationSeconds} bufferedPercent={bufferedPercent}
            onLoadedMetadata={element => {
              const resumeSeconds = latestResumeOverrides.current[active.id] || resumeOverrides[active.id] || activeUrl?.resumeSeconds || historyResume;
              if (resumeSeconds > 0 && resumeSeconds < element.duration) element.currentTime = resumeSeconds;
              if (resumeSeconds > 0) delete latestResumeOverrides.current[active.id];
              if (resumeOverrides[active.id]) setResumeOverrides(current => {
                const next = { ...current };
                delete next[active.id];
                return next;
              });
              setCurrentSeconds(element.currentTime);
              setDurationSeconds(element.duration);
              if (state.playbackIntent === "play") void element.play().catch(() => undefined);
            }}
            onPlaying={() => setBuffering(false)}
            onPlay={() => { setBuffering(false); dispatch({ type: "video-playing", nodeId: active.id }); }}
            onCanPlay={() => setBuffering(false)}
            onPause={element => { dispatch({ type: "video-paused", nodeId: active.id }); saveElementHistory(active.id, element); }}
            onWaiting={() => setBuffering(true)}
            onTimeUpdate={element => {
              const current = element.currentTime;
              latestVideoPositions.current[active.id] = current;
              setCurrentSeconds(current);
              setDurationSeconds(element.duration);
              if (Number.isFinite(element.duration) && element.duration > 0 && element.buffered.length > 0) {
                setBufferedPercent(calculateBufferedPercent(element.buffered.end(element.buffered.length - 1), element.duration));
              }
            }}
            onProgress={element => {
              if (!Number.isFinite(element.duration) || element.duration <= 0 || element.buffered.length === 0) return;
              setBufferedPercent(calculateBufferedPercent(element.buffered.end(element.buffered.length - 1), element.duration));
            }}
            onSeeked={element => saveElementHistory(active.id, element)}
            onEnded={element => { saveElementHistory(active.id, element); dispatch({ type: "video-ended", nodeId: active.id }); }}
            onError={element => onMediaError(active.id, element)}
          />
        )}
      </div>
      <div className="viewer-prefetches" aria-hidden="true">
        {state.items.map((item, index) => {
          if (item.kind !== "image" || index === state.index || Math.abs(index - state.index) > 1) return null;
          const entry = state.urls[item.id];
          return entry?.status === "ready" && entry.url ? <img className="viewer-prefetch" key={item.id} src={entry.url} alt="" referrerPolicy="no-referrer" /> : null;
        })}
      </div>
      {state.overlayOpen && <ViewerOverlay items={state.items} activeIndex={state.index} />}
    </section>
  );
}

function ViewerError({ title, item, body, onRetry }: { title: string; item: ViewerMediaItem; body: string; onRetry: () => void }) {
  return <div className="viewer-error" role="alert"><h2>{title}</h2><strong>{item.name}</strong><span>{item.mimeType ?? "Unknown format"}</span><p>{body}</p><button type="button" onClick={onRetry}>Try fresh URL</button></div>;
}

function toViewerItem(item: TvBrowseItemDto): ViewerMediaItem {
  if (item.kind === "folder") throw new Error("Folders cannot enter the viewer sequence.");
  return { id: item.id, name: item.name, kind: item.kind, mimeType: item.mimeType, revision: item.thumbnailRevision };
}

function isAuthorizationEvidence(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  return code === "MEDIA_URL_EXPIRED" || code === "PROVIDER_UNAUTHORIZED";
}

function isDeviceUnauthorized(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  return code === "DEVICE_UNAUTHORIZED";
}

function isNavigationExpired(error: unknown): boolean {
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
  return code === "NAVIGATION_EXPIRED" || code === "ITEM_NOT_FOUND";
}

function formatResume(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}
