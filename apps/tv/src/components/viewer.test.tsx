// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaNodeDto } from "@cloudframe/shared";
import type { TvApi } from "../api/client";
import { createLocalWatchHistory, type LocalWatchHistory } from "../state/local-watch-history";
import { Viewer } from "./viewer";

describe("unified TV viewer", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("traverses only the loaded media sequence, owns one active video, and restores the exact opening item", async () => {
    const api = viewerApi();
    const closed = vi.fn();
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);

    expect(await screen.findByRole("img", { name: "First.jpg" })).toBeVisible();
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByLabelText("Playing Clip.mp4")).toBeVisible();
    expect(document.querySelectorAll("video")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    expect(document.querySelectorAll("video")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toHaveBeenCalledWith("item_image_1");
  });

  it("opens details with Up, closes them with Down, and Back closes the overlay before the viewer", async () => {
    const closed = vi.fn();
    render(<Viewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);
    await screen.findByRole("img", { name: "First.jpg" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    const details = screen.getByRole("dialog", { name: "Media details" });
    expect(details).toBeVisible();
    const title = screen.getByRole("heading", { name: "First.jpg" });
    const screening = screen.getByText("Now screening · Still");
    expect(title.compareDocumentPosition(screening) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Media details" })).not.toBeInTheDocument();
    expect(closed).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(screen.queryByRole("dialog", { name: "Media details" })).not.toBeInTheDocument();
  });

  it("advances an image slideshow, plays at video, and advances only after video ended", async () => {
    vi.useFakeTimers();
    const api = viewerApi();
    const history = viewerHistory();
    render(<Viewer history={history} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={2} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const video = await screen.findByLabelText("Playing Clip.mp4");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByLabelText("Playing Clip.mp4")).toBe(video);
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 100 });
    fireEvent.ended(video);
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    expect(history.get("item_video_1")).toMatchObject({ positionSeconds: 100, durationSeconds: 100, completed: true });
  });

  it("does not infer authorization from a generic media error and caps manual fresh-URL retry at one", async () => {
    const api = viewerApi();
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const image = await screen.findByRole("img", { name: "First.jpg" });
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    fireEvent.error(image);
    expect(api.mediaUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(3));
    fireEvent.error(await screen.findByRole("img", { name: "First.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await act(async () => { await Promise.resolve(); });
    expect(api.mediaUrl).toHaveBeenCalledTimes(3);
    expect(screen.getByText("A fresh link did not solve this media error.")).toBeVisible();
  });

  it("automatically retries one URL-vending authorization failure and then stops", async () => {
    const api = viewerApi();
    let selectedAttempts = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async nodeId => {
      if (nodeId === "item_image_1") {
        selectedAttempts += 1;
        if (selectedAttempts < 2) throw Object.assign(new Error("expired"), { code: "PROVIDER_UNAUTHORIZED" });
      }
      return { url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" };
    });
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    expect(await screen.findByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/item_image_1");
    expect(selectedAttempts).toBe(2);

    cleanup();
    selectedAttempts = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async nodeId => {
      if (nodeId === "item_image_1") {
        selectedAttempts += 1;
        throw Object.assign(new Error("expired"), { code: "PROVIDER_UNAUTHORIZED" });
      }
      return { url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" };
    });
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    expect(await screen.findByText("A fresh link did not solve this media error.")).toBeVisible();
    expect(selectedAttempts).toBe(2);
  });

  it("resumes synchronously and saves at most every 15s plus pause, lifecycle, switch, and close", async () => {
    vi.useFakeTimers();
    const api = viewerApi();
    const history = viewerHistory();
    history.save("item_video_1", { positionSeconds: 42, durationSeconds: 100, completed: false });
    const save = vi.spyOn(history, "save");
    const view = render(<Viewer history={history} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    let video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42);
    video.currentTime = 50;
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(save).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(save).toHaveBeenCalledTimes(1);
    video.currentTime = 50.5;
    fireEvent.pause(video);
    expect(save).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(save).toHaveBeenCalledTimes(2);
    video.currentTime = 51;
    fireEvent(window, new Event("pagehide"));
    expect(save).toHaveBeenCalledTimes(3);
    video.currentTime = 52;
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(save).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const returned = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(returned, "duration", { configurable: true, value: 100 });
    Object.defineProperty(returned, "currentTime", { configurable: true, writable: true, value: 60 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(save).toHaveBeenCalledTimes(5);
    expect(save).toHaveBeenNthCalledWith(1, "item_video_1", { positionSeconds: 50, durationSeconds: 100, completed: false });
    expect(save).toHaveBeenLastCalledWith("item_video_1", { positionSeconds: 60, durationSeconds: 100, completed: false });
    view.unmount();
    expect(save).toHaveBeenCalledTimes(5);
  });

  it("saves the active video on unmount without a duplicate final snapshot", async () => {
    const history = viewerHistory();
    const save = vi.spyOn(history, "save");
    const view = render(<Viewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 33 });
    view.unmount();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("item_video_1", { positionSeconds: 33, durationSeconds: 100, completed: false });
  });

  it("saves adjacent video A with A's element values before video B replaces it", async () => {
    const sequence = [
      media("item_video_a", "video", "A.mp4", "video/mp4"),
      media("item_video_b", "video", "B.mp4", "video/mp4")
    ];
    const history = viewerHistory();
    const save = vi.spyOn(history, "save");
    render(<Viewer history={history} api={viewerApi()} items={sequence} selectedItemId="item_video_a" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const videoA = await screen.findByLabelText("Playing A.mp4") as HTMLVideoElement;
    Object.defineProperty(videoA, "duration", {
      configurable: true,
      get: () => videoA.getAttribute("src")?.includes("item_video_b") ? 200 : 100
    });
    Object.defineProperty(videoA, "currentTime", {
      configurable: true,
      get: () => videoA.getAttribute("src")?.includes("item_video_b") ? 7 : 35,
      set: () => undefined
    });

    fireEvent.keyDown(window, { key: "ArrowRight" });
    const videoB = await screen.findByLabelText("Playing B.mp4") as HTMLVideoElement;

    expect(videoB).not.toBe(videoA);
    expect(history.get("item_video_a")).toMatchObject({ positionSeconds: 35, durationSeconds: 100, completed: false });
    expect(save).not.toHaveBeenCalledWith("item_video_a", { positionSeconds: 7, durationSeconds: 200, completed: false });
  });

  it("never falls back to the previous video's element when the next video closes before metadata", async () => {
    const sequence = [
      media("item_video_a", "video", "A.mp4", "video/mp4"),
      media("item_video_b", "video", "B.mp4", "video/mp4")
    ];
    const history = viewerHistory();
    const save = vi.spyOn(history, "save");
    render(<Viewer history={history} api={viewerApi()} items={sequence} selectedItemId="item_video_a" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const videoA = await screen.findByLabelText("Playing A.mp4") as HTMLVideoElement;
    Object.defineProperty(videoA, "duration", { configurable: true, value: 100 });
    Object.defineProperty(videoA, "currentTime", { configurable: true, value: 35 });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const videoB = await screen.findByLabelText("Playing B.mp4") as HTMLVideoElement;
    Object.defineProperty(videoB, "duration", { configurable: true, value: Number.NaN });
    Object.defineProperty(videoB, "currentTime", { configurable: true, value: 0 });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(history.get("item_video_a")).toMatchObject({ positionSeconds: 35, durationSeconds: 100, completed: false });
    expect(history.get("item_video_b")).toBeNull();
    expect(save).not.toHaveBeenCalledWith("item_video_b", { positionSeconds: 35, durationSeconds: 100, completed: false });
  });

  it("preserves existing resume history when a quick close happens before metadata", async () => {
    const history = viewerHistory();
    history.save("item_video_1", { positionSeconds: 42, durationSeconds: 100, completed: false });
    const save = vi.spyOn(history, "save");
    render(<Viewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: Number.NaN });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 0 });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(save).not.toHaveBeenCalled();
    expect(history.get("item_video_1")).toMatchObject({ positionSeconds: 42, durationSeconds: 100, completed: false });
  });

  it("saves valid progress on media error and keeps that item association through close and unmount", async () => {
    const history = viewerHistory();
    const save = vi.spyOn(history, "save");
    const view = render(<Viewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, value: 37 });

    fireEvent.error(video);
    expect(history.get("item_video_1")).toMatchObject({ positionSeconds: 37, durationSeconds: 100, completed: false });
    fireEvent.keyDown(window, { key: "Escape" });
    view.unmount();

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("item_video_1", { positionSeconds: 37, durationSeconds: 100, completed: false });
  });

  it("keeps playback operable and shows a polite status when local history is unavailable", async () => {
    const history = createLocalWatchHistory({
      getItem() { throw Object.assign(new Error("denied"), { name: "SecurityError" }); },
      setItem() { throw Object.assign(new Error("denied"), { name: "SecurityError" }); },
      removeItem() { throw Object.assign(new Error("denied"), { name: "SecurityError" }); }
    }, "device-1");

    render(<Viewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Watch progress is unavailable on this TV, but playback will continue.");
    expect(status).toHaveClass("viewer-history-status");
    expect(status).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("offers ten-second video seeking and shows a safe unsupported-codec explanation", async () => {
    render(<Viewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 30 });
    fireEvent.keyDown(window, { key: "MediaFastForward", keyCode: 417 });
    expect(video.currentTime).toBe(40);
    fireEvent.keyDown(window, { key: "MediaRewind", keyCode: 412 });
    expect(video.currentTime).toBe(30);
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);
    expect(screen.getByRole("heading", { name: "This video format cannot play on this TV" })).toBeVisible();
    expect(screen.getAllByText("Clip.mp4")).toHaveLength(2);
    expect(screen.getByText("video/mp4")).toBeVisible();
  });

  it("uses provider URLs directly and never fetches media bytes through the app", async () => {
    const api = viewerApi();
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(video.src).toBe("https://provider.example/item_video_1");
    expect(api.mediaUrl).toHaveBeenCalledWith("item_video_1", expect.any(AbortSignal));
  });

  it("prefetches at most one adjacent image on each side", async () => {
    const sequence = [
      media("item_image_0", "image", "Before.jpg", "image/jpeg"),
      media("item_image_1", "image", "First.jpg", "image/jpeg"),
      media("item_image_2", "image", "After.jpg", "image/jpeg"),
      media("item_image_3", "image", "Too-far.jpg", "image/jpeg")
    ];
    const { container } = render(<Viewer history={viewerHistory()} api={viewerApi()} items={sequence} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await screen.findByRole("img", { name: "First.jpg" });
    const prefetched = Array.from(container.querySelectorAll<HTMLImageElement>(".viewer-prefetch"));
    expect(prefetched.map(image => image.src).sort()).toEqual([
      "https://provider.example/item_image_0",
      "https://provider.example/item_image_2"
    ]);
  });

  it("auto-hides controls only after playback starts and exposes buffered progress", async () => {
    vi.useFakeTimers();
    const { container } = render(<Viewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    let video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 1, end: () => 60 } });
    expect(video.duration).toBe(100);
    expect(video.buffered.end(0)).toBe(60);
    fireEvent.canPlay(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(container.querySelector(".video-controls")).toHaveClass("is-visible");
    video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    await act(async () => { await Promise.resolve(); });
    video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 1, end: () => 60 } });
    fireEvent.timeUpdate(video);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(container.querySelector(".video-controls")).not.toHaveClass("is-visible");
    expect(screen.getByRole("progressbar", { name: "Buffered", hidden: true })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(container.querySelector(".video-controls")).toHaveClass("is-visible");
  });

  it("ignores stale URL completions after navigation cancels an obsolete request", async () => {
    const api = viewerApi();
    let resolveFirst: ((value: { url: string; expiresAt: string; revision: string | null }) => void) | null = null;
    vi.mocked(api.mediaUrl).mockImplementation((nodeId, signal) => {
      if (nodeId === "item_image_1") return new Promise(resolve => {
        resolveFirst = resolve;
        signal?.addEventListener("abort", () => undefined);
      });
      return Promise.resolve({ url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" });
    });
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    await act(async () => { resolveFirst?.({ url: "https://provider.example/stale", expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" }); });
    expect(screen.getByRole("img", { name: "Last.jpg" })).toHaveAttribute("src", "https://provider.example/item_image_2");
    expect(screen.queryByDisplayValue("https://provider.example/stale")).not.toBeInTheDocument();
  });

  it("resumes at the same timestamp after the single fresh-link retry", async () => {
    const api = viewerApi();
    render(<Viewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    let currentTime = 37;
    Object.defineProperty(video, "currentTime", { configurable: true, get: () => currentTime, set: value => { currentTime = value; } });
    fireEvent.timeUpdate(video);
    fireEvent.error(video);
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    expect(screen.getByText("Resuming at 0:37")).toBeVisible();
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(4));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Resuming at 0:37")).toBeVisible();
  });

  it("propagates a media URL device revocation once without retry, close, or trailing writes", async () => {
    vi.useFakeTimers();
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockRejectedValue(Object.assign(new Error("revoked"), { code: "DEVICE_UNAUTHORIZED" }));
    const unauthorized = vi.fn();
    const closed = vi.fn();
    const history = viewerHistory();
    const save = vi.spyOn(history, "save");
    render(<Viewer history={history} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={1} previews={{}} onClose={closed} onUnauthorized={unauthorized} />);
    await act(async () => { await Promise.resolve(); });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    const callsAtRevocation = vi.mocked(api.mediaUrl).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(api.mediaUrl).toHaveBeenCalledTimes(callsAtRevocation);
    expect(save).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

});

const items: MediaNodeDto[] = [
  media("item_image_1", "image", "First.jpg", "image/jpeg"),
  media("item_video_1", "video", "Clip.mp4", "video/mp4"),
  media("item_image_2", "image", "Last.jpg", "image/jpeg")
];

function media(id: string, kind: "image" | "video", name: string, mimeType: string): MediaNodeDto {
  return {
    id, sourceId: "source-1", provider: "google", parentNodeId: "folder-1", name,
    normalizedName: name.toLowerCase(), kind, mimeType, size: 1_000, width: kind === "image" ? 1920 : 1280,
    height: kind === "image" ? 1080 : 720, capturedAt: "2026-08-01T00:00:00.000Z",
    createdAtProvider: null, modifiedAtProvider: null, thumbnailRevision: "revision-1", hasPreview: true,
    folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: 0, available: true
  };
}

function viewerApi(): TvApi {
  return {
    bootstrap: vi.fn(), createDeviceRequest: vi.fn(), requestStatus: vi.fn(), home: vi.fn(), folder: vi.fn(),
    thumbnailUrls: vi.fn(),
    mediaUrl: vi.fn(async nodeId => ({ url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" }))
  };
}

function viewerHistory(): LocalWatchHistory {
  const values = new Map<string, string>();
  return createLocalWatchHistory({
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  }, "device-1", () => new Date("2026-08-27T12:00:00.000Z"));
}
