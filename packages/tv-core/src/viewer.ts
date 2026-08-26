export interface ViewerMediaItem {
  id: string;
  name: string;
  kind: "image" | "video";
  mimeType: string | null;
  revision: string | null;
}

export type ViewerUrlStatus = "loading" | "ready" | "error";
export type ViewerMediaErrorKind = "authorization" | "codec" | "generic";

export interface ViewerUrlState {
  status: ViewerUrlStatus;
  requestId: number;
  url?: string;
  revision: string | null;
  refreshUsed: boolean;
  resumeSeconds: number;
  errorKind?: ViewerMediaErrorKind;
}

export interface ViewerUrlRequest {
  nodeId: string;
  requestId: number;
}

interface ViewerRetryState {
  revision: string | null;
  used: boolean;
}

export interface ViewerState {
  items: ViewerMediaItem[];
  index: number;
  mode: "image" | "video";
  restorationItemId: string;
  overlayOpen: boolean;
  slideshowActive: boolean;
  playbackIntent: "play" | "pause";
  videoPlaying: boolean;
  controlsVisible: boolean;
  closed: boolean;
  mediaError: { nodeId: string; kind: ViewerMediaErrorKind } | null;
  urls: Record<string, ViewerUrlState>;
  retryLedger: Record<string, ViewerRetryState>;
  nextRequestId: number;
}

export type ViewerAction =
  | { type: "navigate"; direction: -1 | 1 }
  | { type: "enter" }
  | { type: "overlay"; open: boolean }
  | { type: "back" }
  | { type: "slideshow-tick" }
  | { type: "video-ended"; nodeId: string }
  | { type: "video-playing"; nodeId: string }
  | { type: "video-paused"; nodeId: string }
  | { type: "media-error"; nodeId: string; kind: ViewerMediaErrorKind }
  | { type: "url-ready"; nodeId: string; requestId: number; url: string; revision: string | null }
  | { type: "url-failed"; nodeId: string; requestId: number; kind: ViewerMediaErrorKind }
  | { type: "authorization-expired"; nodeId: string; resumeSeconds: number }
  | { type: "manual-retry"; nodeId: string; resumeSeconds: number }
  | { type: "controls-timeout" }
  | { type: "activity" };

export function createViewerState(items: ViewerMediaItem[], selectedItemId: string): ViewerState {
  if (items.length === 0) throw new Error("Viewer requires at least one media item.");
  const index = items.findIndex(item => item.id === selectedItemId);
  if (index < 0) throw new Error("Selected viewer item is not in the media sequence.");
  const retryLedger: Record<string, ViewerRetryState> = {};
  items.forEach(item => { retryLedger[item.id] = { revision: item.revision, used: false }; });
  return withUrlWindow({
    items: items.slice(),
    index,
    mode: items[index]!.kind,
    restorationItemId: selectedItemId,
    overlayOpen: false,
    slideshowActive: false,
    playbackIntent: "pause",
    videoPlaying: false,
    controlsVisible: true,
    closed: false,
    mediaError: null,
    urls: {},
    retryLedger,
    nextRequestId: 1
  });
}

export function activeViewerItem(state: ViewerState): ViewerMediaItem {
  return state.items[state.index]!;
}

export function pendingViewerUrlRequests(state: ViewerState): ViewerUrlRequest[] {
  return Object.keys(state.urls).map(nodeId => ({ nodeId, entry: state.urls[nodeId]! }))
    .filter(value => value.entry.status === "loading")
    .map(value => ({ nodeId: value.nodeId, requestId: value.entry.requestId }));
}

export function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  if (state.closed && action.type !== "activity") return state;
  switch (action.type) {
    case "navigate":
      return navigate(state, action.direction);
    case "enter": {
      const active = activeViewerItem(state);
      if (active.kind === "image") {
        return { ...state, slideshowActive: !state.slideshowActive, controlsVisible: true, mediaError: null };
      }
      return {
        ...state,
        playbackIntent: state.playbackIntent === "play" ? "pause" : "play",
        controlsVisible: true
      };
    }
    case "overlay":
      return { ...state, overlayOpen: action.open, controlsVisible: true };
    case "back":
      return state.overlayOpen
        ? { ...state, overlayOpen: false, controlsVisible: true }
        : { ...state, closed: true, slideshowActive: false, playbackIntent: "pause", videoPlaying: false };
    case "slideshow-tick":
      if (!state.slideshowActive || activeViewerItem(state).kind !== "image") return state;
      if (state.index >= state.items.length - 1) return { ...state, slideshowActive: false };
      return navigate(state, 1);
    case "video-ended":
      if (activeViewerItem(state).id !== action.nodeId) return state;
      if (!state.slideshowActive || state.index >= state.items.length - 1) {
        return { ...state, playbackIntent: "pause", videoPlaying: false, slideshowActive: false, controlsVisible: true };
      }
      return navigate({ ...state, playbackIntent: "pause", videoPlaying: false }, 1);
    case "video-playing":
      return activeViewerItem(state).id === action.nodeId
        ? { ...state, playbackIntent: "play", videoPlaying: true }
        : state;
    case "video-paused":
      return activeViewerItem(state).id === action.nodeId
        ? { ...state, playbackIntent: "pause", videoPlaying: false, controlsVisible: true }
        : state;
    case "media-error":
      return activeViewerItem(state).id === action.nodeId
        ? {
            ...state,
            slideshowActive: false,
            playbackIntent: "pause",
            videoPlaying: false,
            controlsVisible: true,
            mediaError: { nodeId: action.nodeId, kind: action.kind }
          }
        : state;
    case "url-ready": {
      const current = state.urls[action.nodeId];
      if (!current || current.requestId !== action.requestId || current.status !== "loading") return state;
      const previousRetry = state.retryLedger[action.nodeId];
      const revisionChanged = previousRetry?.revision !== action.revision;
      const retry = revisionChanged
        ? { revision: action.revision, used: false }
        : previousRetry ?? { revision: action.revision, used: false };
      return {
        ...state,
        urls: {
          ...state.urls,
          [action.nodeId]: {
            ...current,
            status: "ready",
            url: action.url,
            revision: action.revision,
            refreshUsed: retry.used,
            errorKind: undefined
          }
        },
        retryLedger: { ...state.retryLedger, [action.nodeId]: retry },
        mediaError: state.mediaError?.nodeId === action.nodeId ? null : state.mediaError
      };
    }
    case "url-failed": {
      const current = state.urls[action.nodeId];
      if (!current || current.requestId !== action.requestId || current.status !== "loading") return state;
      return {
        ...state,
        urls: { ...state.urls, [action.nodeId]: { ...current, status: "error", errorKind: action.kind } },
        slideshowActive: activeViewerItem(state).id === action.nodeId ? false : state.slideshowActive
      };
    }
    case "authorization-expired":
    case "manual-retry":
      return refreshUrlOnce(state, action.nodeId, action.resumeSeconds);
    case "controls-timeout":
      return state.videoPlaying && activeViewerItem(state).kind === "video" && !state.overlayOpen
        ? { ...state, controlsVisible: false }
        : state;
    case "activity":
      return { ...state, controlsVisible: true };
  }
}

function navigate(state: ViewerState, direction: -1 | 1): ViewerState {
  const index = Math.max(0, Math.min(state.items.length - 1, state.index + direction));
  if (index === state.index) return { ...state, controlsVisible: true };
  const nextItem = state.items[index]!;
  return withUrlWindow({
    ...state,
    index,
    mode: nextItem.kind,
    playbackIntent: state.slideshowActive && nextItem.kind === "video" ? "play" : "pause",
    videoPlaying: false,
    controlsVisible: true,
    mediaError: null
  });
}

function withUrlWindow(state: ViewerState): ViewerState {
  const nextUrls: Record<string, ViewerUrlState> = {};
  let nextRequestId = state.nextRequestId;
  const start = Math.max(0, state.index - 1);
  const end = Math.min(state.items.length - 1, state.index + 1);
  for (let index = start; index <= end; index += 1) {
    const item = state.items[index]!;
    const existing = state.urls[item.id];
    if (existing) nextUrls[item.id] = existing;
    else {
      const retry = state.retryLedger[item.id] ?? { revision: item.revision, used: false };
      nextUrls[item.id] = {
        status: "loading",
        requestId: nextRequestId,
        revision: retry.revision,
        refreshUsed: retry.used,
        resumeSeconds: 0
      };
      nextRequestId += 1;
    }
  }
  return { ...state, urls: nextUrls, nextRequestId };
}

function refreshUrlOnce(state: ViewerState, nodeId: string, resumeSeconds: number): ViewerState {
  const current = state.urls[nodeId];
  if (!current) return state;
  const retry = state.retryLedger[nodeId] ?? { revision: current.revision, used: current.refreshUsed };
  if (retry.used) {
    return {
      ...state,
      urls: {
        ...state.urls,
        [nodeId]: { ...current, status: "error", refreshUsed: true, errorKind: "authorization" }
      },
      mediaError: activeViewerItem(state).id === nodeId ? { nodeId, kind: "authorization" } : state.mediaError,
      slideshowActive: activeViewerItem(state).id === nodeId ? false : state.slideshowActive
    };
  }
  const nextRetry = { ...retry, used: true };
  return {
    ...state,
    urls: {
      ...state.urls,
      [nodeId]: {
        status: "loading",
        requestId: state.nextRequestId,
        revision: current.revision,
        refreshUsed: true,
        resumeSeconds: finiteNonNegative(resumeSeconds)
      }
    },
    retryLedger: { ...state.retryLedger, [nodeId]: nextRetry },
    nextRequestId: state.nextRequestId + 1,
    mediaError: state.mediaError?.nodeId === nodeId ? null : state.mediaError
  };
}

export function clampVideoSeek(currentSeconds: number, durationSeconds: number, deltaSeconds: number): number {
  const current = finiteNonNegative(currentSeconds);
  const duration = finiteNonNegative(durationSeconds);
  return Math.max(0, Math.min(duration, current + deltaSeconds));
}

export function historySnapshot(positionSeconds: number, durationSeconds: number): {
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
} {
  const duration = finiteNonNegative(durationSeconds);
  const position = Math.min(duration, finiteNonNegative(positionSeconds));
  return {
    positionSeconds: position,
    durationSeconds: duration,
    completed: duration > 0 && position >= Math.max(duration - 5, duration * 0.95)
  };
}

export function calculateBufferedPercent(bufferedEndSeconds: number, durationSeconds: number): number {
  const duration = finiteNonNegative(durationSeconds);
  if (duration === 0) return 0;
  return Math.max(0, Math.min(100, Math.round(finiteNonNegative(bufferedEndSeconds) / duration * 100)));
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
