import { describe, expect, it } from "vitest";

import {
  activeViewerItem,
  calculateBufferedPercent,
  clampVideoSeek,
  createViewerState,
  historySnapshot,
  viewerReducer,
  type ViewerMediaItem
} from "@cloudframe/tv-core";

const media: ViewerMediaItem[] = [
  { id: "image-1", name: "First.jpg", kind: "image", mimeType: "image/jpeg", revision: "r1" },
  { id: "video-1", name: "Clip.mp4", kind: "video", mimeType: "video/mp4", revision: "r1" },
  { id: "image-2", name: "Last.jpg", kind: "image", mimeType: "image/jpeg", revision: "r2" },
  { id: "image-3", name: "Outside.jpg", kind: "image", mimeType: "image/jpeg", revision: "r3" }
];

describe("viewer reducer", () => {
  it("opens on the exact selected media ID and requests only the active and adjacent window", () => {
    const state = createViewerState(media, "video-1");

    expect(activeViewerItem(state).id).toBe("video-1");
    expect(state.restorationItemId).toBe("video-1");
    expect(Object.keys(state.urls).sort()).toEqual(["image-1", "image-2", "video-1"]);
    expect(Object.values(state.urls).every(entry => entry.status === "loading")).toBe(true);
  });

  it("clamps Left and Right without wrapping and pauses a deactivated video", () => {
    let state = createViewerState(media, "image-1");
    state = viewerReducer(state, { type: "navigate", direction: -1 });
    expect(state.index).toBe(0);

    state = viewerReducer(state, { type: "navigate", direction: 1 });
    state = viewerReducer(state, { type: "enter" });
    expect(state.playbackIntent).toBe("play");
    state = viewerReducer(state, { type: "navigate", direction: 1 });
    expect(activeViewerItem(state).id).toBe("image-2");
    expect(state.playbackIntent).toBe("pause");
    expect(Object.keys(state.urls).sort()).toEqual(["image-2", "image-3", "video-1"]);

    state = viewerReducer(state, { type: "navigate", direction: 1 });
    state = viewerReducer(state, { type: "navigate", direction: 1 });
    expect(state.index).toBe(3);
  });

  it("uses Enter for image slideshow and video play-pause", () => {
    let image = createViewerState(media, "image-1");
    image = viewerReducer(image, { type: "enter" });
    expect(image.slideshowActive).toBe(true);
    image = viewerReducer(image, { type: "enter" });
    expect(image.slideshowActive).toBe(false);

    let video = createViewerState(media, "video-1");
    video = viewerReducer(video, { type: "enter" });
    expect(video.playbackIntent).toBe("play");
    video = viewerReducer(video, { type: "enter" });
    expect(video.playbackIntent).toBe("pause");
  });

  it("opens and closes details before Back closes with the original restoration target", () => {
    let state = createViewerState(media, "video-1");
    state = viewerReducer(state, { type: "overlay", open: true });
    state = viewerReducer(state, { type: "navigate", direction: 1 });
    state = viewerReducer(state, { type: "back" });
    expect(state.overlayOpen).toBe(false);
    expect(state.closed).toBe(false);
    state = viewerReducer(state, { type: "back" });
    expect(state.closed).toBe(true);
    expect(state.restorationItemId).toBe("video-1");
  });

  it("advances image slides, pauses at video, continues on ended, and never wraps", () => {
    let state = createViewerState(media.slice(0, 3), "image-1");
    state = viewerReducer(state, { type: "enter" });
    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(activeViewerItem(state).id).toBe("video-1");
    expect(state.slideshowActive).toBe(true);
    expect(state.playbackIntent).toBe("play");

    state = viewerReducer(state, { type: "video-ended", nodeId: "video-1" });
    expect(activeViewerItem(state).id).toBe("image-2");
    expect(state.playbackIntent).toBe("pause");
    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(state.index).toBe(2);
    expect(state.slideshowActive).toBe(false);
  });

  it("stops the slideshow on a current image error", () => {
    let state = createViewerState(media, "image-1");
    state = viewerReducer(state, { type: "enter" });
    state = viewerReducer(state, { type: "media-error", nodeId: "image-1", kind: "generic" });
    expect(state.slideshowActive).toBe(false);
    expect(state.mediaError).toMatchObject({ nodeId: "image-1", kind: "generic" });
  });

  it.each([
    { startId: "image-1", direction: 1 as const, returnDirection: -1 as const },
    { startId: "image-2", direction: -1 as const, returnDirection: 1 as const }
  ])("promotes an adjacent URL failure when navigating $direction and clears it on the ready destination", ({ startId, direction, returnDirection }) => {
    let state = createViewerState(media, startId);
    const start = state.urls[startId]!;
    state = viewerReducer(state, {
      type: "url-ready",
      nodeId: startId,
      requestId: start.requestId,
      url: `https://provider.example/${startId}`,
      sourceKind: "direct",
      expiresAtEpoch: 10_000,
      revision: "r1"
    });
    const adjacent = state.urls["video-1"]!;
    state = viewerReducer(state, { type: "url-failed", nodeId: "video-1", requestId: adjacent.requestId, kind: "bridge" });
    expect(state.mediaError).toBeNull();

    state = viewerReducer(state, { type: "navigate", direction });
    expect(activeViewerItem(state).id).toBe("video-1");
    expect(state.mediaError).toEqual({ nodeId: "video-1", kind: "bridge" });

    state = viewerReducer(state, { type: "navigate", direction: returnDirection });
    expect(activeViewerItem(state).id).toBe(startId);
    expect(state.mediaError).toBeNull();
  });

  it("stops an active slideshow when it reaches a cached failed image", () => {
    const images = [media[0]!, media[2]!, media[3]!];
    let state = createViewerState(images, "image-1");
    state = viewerReducer(state, { type: "enter" });
    const failed = state.urls["image-2"]!;
    state = viewerReducer(state, { type: "url-failed", nodeId: "image-2", requestId: failed.requestId, kind: "bridge" });
    expect(state.slideshowActive).toBe(true);

    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(activeViewerItem(state).id).toBe("image-2");
    expect(state.mediaError).toEqual({ nodeId: "image-2", kind: "bridge" });
    expect(state.slideshowActive).toBe(false);

    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(activeViewerItem(state).id).toBe("image-2");
  });

  it("pauses when an active slideshow reaches a cached failed video", () => {
    let state = createViewerState(media.slice(0, 3), "image-1");
    state = viewerReducer(state, { type: "enter" });
    const failed = state.urls["video-1"]!;
    state = viewerReducer(state, { type: "url-failed", nodeId: "video-1", requestId: failed.requestId, kind: "bridge" });

    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(activeViewerItem(state).id).toBe("video-1");
    expect(state.mediaError).toEqual({ nodeId: "video-1", kind: "bridge" });
    expect(state.slideshowActive).toBe(false);
    expect(state.playbackIntent).toBe("pause");
    expect(state.videoPlaying).toBe(false);

    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(activeViewerItem(state).id).toBe("video-1");
  });

  it("pauses an active slideshow video when its URL preparation fails", () => {
    let state = createViewerState(media.slice(0, 3), "image-1");
    state = viewerReducer(state, { type: "enter" });
    state = viewerReducer(state, { type: "slideshow-tick" });
    expect(activeViewerItem(state).id).toBe("video-1");
    expect(state.playbackIntent).toBe("play");
    const video = state.urls["video-1"]!;

    state = viewerReducer(state, {
      type: "url-failed",
      nodeId: "video-1",
      requestId: video.requestId,
      kind: "bridge"
    });

    expect(state.mediaError).toEqual({ nodeId: "video-1", kind: "bridge" });
    expect(state.slideshowActive).toBe(false);
    expect(state.playbackIntent).toBe("pause");
    expect(state.videoPlaying).toBe(false);
  });

  it("pauses an active slideshow video when authorization renewal is exhausted", () => {
    let state = createViewerState(media.slice(0, 3), "image-1");
    state = viewerReducer(state, { type: "enter" });
    state = viewerReducer(state, { type: "slideshow-tick" });
    const initial = state.urls["video-1"]!;
    state = viewerReducer(state, {
      type: "url-ready",
      nodeId: "video-1",
      requestId: initial.requestId,
      url: "https://provider.example/video",
      sourceKind: "direct",
      expiresAtEpoch: 10_000,
      revision: "r1"
    });
    state = viewerReducer(state, { type: "authorization-expired", nodeId: "video-1", resumeSeconds: 37 });

    state = viewerReducer(state, { type: "authorization-expired", nodeId: "video-1", resumeSeconds: 37 });

    expect(state.mediaError).toEqual({ nodeId: "video-1", kind: "authorization" });
    expect(state.slideshowActive).toBe(false);
    expect(state.playbackIntent).toBe("pause");
    expect(state.videoPlaying).toBe(false);
    expect(state.controlsVisible).toBe(true);
  });

  it("ignores stale URL completions and keeps authorization renewal consumed after reissue", () => {
    let state = createViewerState(media, "image-1");
    const first = state.urls["image-1"]!;
    state = viewerReducer(state, {
      type: "url-ready", nodeId: "image-1", requestId: first.requestId + 100,
      url: "https://stale.example/media", sourceKind: "direct", expiresAtEpoch: 10_000, revision: "r1"
    });
    expect(state.urls["image-1"]!.status).toBe("loading");

    state = viewerReducer(state, {
      type: "url-ready", nodeId: "image-1", requestId: first.requestId,
      url: "https://provider.example/media", sourceKind: "direct", expiresAtEpoch: 10_000, revision: "r1"
    });
    state = viewerReducer(state, { type: "authorization-expired", nodeId: "image-1", resumeSeconds: 37 });
    const retry = state.urls["image-1"]!;
    expect(retry.status).toBe("loading");
    expect(retry.refreshUsed).toBe(true);
    expect(retry.resumeSeconds).toBe(37);

    state = viewerReducer(state, {
      type: "url-ready", nodeId: "image-1", requestId: retry.requestId,
      url: "https://provider.example/fresh", sourceKind: "direct", expiresAtEpoch: 20_000, revision: "r1"
    });
    expect(state.urls["image-1"]).toMatchObject({ status: "ready", refreshUsed: true });
    expect(state.retryLedger["image-1"]).toMatchObject({ revision: "r1", used: true });
    const nextRequestId = state.nextRequestId;
    state = viewerReducer(state, { type: "authorization-expired", nodeId: "image-1", resumeSeconds: 41 });
    expect(state.urls["image-1"]).toMatchObject({ status: "error", refreshUsed: true, errorKind: "authorization" });
    expect(state.mediaError).toEqual({ nodeId: "image-1", kind: "authorization" });
    expect(state.nextRequestId).toBe(nextRequestId);
  });

  it("gives each successfully issued URL its own one-error retry allowance", () => {
    let state = createViewerState(media, "image-1");
    const initial = state.urls["image-1"]!;
    state = viewerReducer(state, {
      type: "url-ready", nodeId: "image-1", requestId: initial.requestId,
      url: "https://provider.example/media", sourceKind: "direct", expiresAtEpoch: 10_000, revision: "r1"
    });
    state = viewerReducer(state, { type: "manual-retry", nodeId: "image-1", resumeSeconds: 12 });
    const retry = state.urls["image-1"]!;
    state = viewerReducer(state, {
      type: "url-ready", nodeId: "image-1", requestId: retry.requestId,
      url: "https://provider.example/reissued", sourceKind: "direct", expiresAtEpoch: 20_000, revision: "r1"
    });
    expect(state.urls["image-1"]!.refreshUsed).toBe(false);
    state = viewerReducer(state, { type: "manual-retry", nodeId: "image-1", resumeSeconds: 14 });
    expect(state.urls["image-1"]!.status).toBe("loading");
    expect(state.urls["image-1"]!.refreshUsed).toBe(true);
  });

  it("renews an expected URL expiry without consuming the error retry allowance", () => {
    let state = createViewerState(media, "video-1");
    const initial = state.urls["video-1"]!;
    state = viewerReducer(state, {
      type: "url-ready", nodeId: "video-1", requestId: initial.requestId,
      url: "https://provider.example/video", sourceKind: "direct", expiresAtEpoch: 10_000, revision: "r1"
    });
    state = viewerReducer(state, { type: "url-expired", nodeId: "video-1", requestId: initial.requestId, resumeSeconds: 37 });
    const renewal = state.urls["video-1"]!;
    expect(renewal).toMatchObject({ status: "loading", refreshUsed: false, resumeSeconds: 37 });
    state = viewerReducer(state, {
      type: "url-ready", nodeId: "video-1", requestId: renewal.requestId,
      url: "https://provider.example/video-fresh", sourceKind: "direct", expiresAtEpoch: 20_000, revision: "r1"
    });
    expect(state.urls["video-1"]).toMatchObject({ status: "ready", expiresAtEpoch: 20_000, refreshUsed: false });
    state = viewerReducer(state, { type: "authorization-expired", nodeId: "video-1", resumeSeconds: 39 });
    expect(state.urls["video-1"]).toMatchObject({ status: "loading", refreshUsed: true, resumeSeconds: 39 });
  });

  it("ignores expiry from a superseded request and drops expiry data outside the URL window", () => {
    let state = createViewerState(media, "image-1");
    const initial = state.urls["image-1"]!;
    state = viewerReducer(state, {
      type: "url-ready", nodeId: "image-1", requestId: initial.requestId,
      url: "https://provider.example/image", sourceKind: "direct", expiresAtEpoch: 10_000, revision: "r1"
    });
    const unchanged = viewerReducer(state, { type: "url-expired", nodeId: "image-1", requestId: initial.requestId + 1, resumeSeconds: 0 });
    expect(unchanged.urls["image-1"]).toMatchObject({ status: "ready", expiresAtEpoch: 10_000 });
    state = viewerReducer(state, { type: "navigate", direction: 1 });
    state = viewerReducer(state, { type: "navigate", direction: 1 });
    expect(state.urls["image-1"]).toBeUndefined();
  });

  it("stores Google source metadata without credentials", () => {
    let state = createViewerState(media, "image-1");
    const initial = state.urls["image-1"]!;
    state = viewerReducer(state, {
      type: "url-ready",
      nodeId: "image-1",
      requestId: initial.requestId,
      url: "https://www.googleapis.com/drive/v3/files/file_1?alt=media&supportsAllDrives=true",
      sourceKind: "google-raw",
      expiresAtEpoch: 10_000,
      revision: "r1"
    });

    expect(state.urls["image-1"]?.sourceKind).toBe("google-raw");
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("ya29.test-token");
  });

  it("substitutes the active raw Google source without consuming URL renewal state", () => {
    let state = createViewerState(media, "video-1");
    const initial = state.urls["video-1"]!;
    state = viewerReducer(state, {
      type: "url-ready",
      nodeId: "video-1",
      requestId: initial.requestId,
      url: "https://www.googleapis.com/drive/v3/files/video-1?alt=media&supportsAllDrives=true",
      sourceKind: "google-raw",
      expiresAtEpoch: 10_000,
      revision: "r1"
    });
    state = {
      ...state,
      retryLedger: { ...state.retryLedger, "video-1": { revision: "r1", used: true } },
      mediaError: { nodeId: "video-1", kind: "generic" }
    };
    const before = state.urls["video-1"]!;

    state = viewerReducer(state, {
      type: "compatibility-source",
      nodeId: "video-1",
      url: "/__cloudframe_media__/session_mpeg/MOV00516.MPG",
      sourceKind: "google-filename",
      resumeSeconds: 37
    });

    expect(state.urls["video-1"]).toEqual({
      ...before,
      url: "/__cloudframe_media__/session_mpeg/MOV00516.MPG",
      sourceKind: "google-filename",
      resumeSeconds: 37,
      errorKind: undefined
    });
    expect(state.retryLedger["video-1"]).toEqual({ revision: "r1", used: true });
    expect(state.mediaError).toBeNull();
  });

  it.each([
    ["direct source", "active", "ready", "direct"],
    ["inactive source", "inactive", "ready", "google-raw"],
    ["loading source", "active", "loading", undefined],
    ["filename source", "active", "ready", "google-filename"]
  ] as const)("ignores compatibility substitution for a %s", (_label, target, status, sourceKind) => {
    let state = createViewerState(media, target === "active" ? "video-1" : "image-1");
    const current = state.urls["video-1"]!;
    if (status === "ready") {
      state = viewerReducer(state, {
        type: "url-ready",
        nodeId: "video-1",
        requestId: current.requestId,
        url: "https://provider.example/video",
        sourceKind: sourceKind!,
        expiresAtEpoch: 10_000,
        revision: "r1"
      });
    }
    const before = state;

    const next = viewerReducer(state, {
      type: "compatibility-source",
      nodeId: "video-1",
      url: "/__cloudframe_media__/session_mpeg/MOV00516.MPG",
      sourceKind: "google-filename",
      resumeSeconds: 37
    });

    expect(next).toBe(before);
  });

  it("hides controls only while the active video is playing with no overlay", () => {
    let state = createViewerState(media, "video-1");
    state = viewerReducer(state, { type: "controls-timeout" });
    expect(state.controlsVisible).toBe(true);
    state = viewerReducer(state, { type: "video-playing", nodeId: "video-1" });
    state = viewerReducer(state, { type: "controls-timeout" });
    expect(state.controlsVisible).toBe(false);
    state = viewerReducer(state, { type: "activity" });
    state = viewerReducer(state, { type: "overlay", open: true });
    state = viewerReducer(state, { type: "controls-timeout" });
    expect(state.controlsVisible).toBe(true);
  });
});

describe("video helpers", () => {
  it("seeks in bounded ten-second steps", () => {
    expect(clampVideoSeek(4, 120, -10)).toBe(0);
    expect(clampVideoSeek(116, 120, 10)).toBe(120);
    expect(clampVideoSeek(51, 120, 10)).toBe(61);
  });

  it("builds finite history and marks only near-end playback complete", () => {
    expect(historySnapshot(96, 100)).toEqual({ positionSeconds: 96, durationSeconds: 100, completed: true });
    expect(historySnapshot(30, 100)).toEqual({ positionSeconds: 30, durationSeconds: 100, completed: false });
    expect(historySnapshot(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ positionSeconds: 0, durationSeconds: 0, completed: false });
  });

  it("calculates bounded buffered progress from media ranges", () => {
    expect(calculateBufferedPercent(60, 100)).toBe(60);
    expect(calculateBufferedPercent(200, 100)).toBe(100);
    expect(calculateBufferedPercent(Number.NaN, 0)).toBe(0);
  });
});
