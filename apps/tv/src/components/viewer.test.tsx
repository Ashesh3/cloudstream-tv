// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaNodeDto } from "@cloudframe/shared";
import type { TvApi } from "../api/client";
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
    render(<Viewer api={api} items={items} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={closed} />);

    expect(await screen.findByRole("img", { name: "First.jpg" })).toBeVisible();
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByLabelText("Playing Clip.mp4")).toBeVisible();
    expect(document.querySelectorAll("video")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    expect(document.querySelectorAll("video")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toHaveBeenCalledWith("image-1");
  });

  it("opens details with Up, closes them with Down, and Back closes the overlay before the viewer", async () => {
    const closed = vi.fn();
    render(<Viewer api={viewerApi()} items={items} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={closed} />);
    await screen.findByRole("img", { name: "First.jpg" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(screen.getByRole("dialog", { name: "Media details" })).toBeVisible();
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
    render(<Viewer api={api} items={items} selectedItemId="image-1" slideshowSeconds={2} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const video = await screen.findByLabelText("Playing Clip.mp4");
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByLabelText("Playing Clip.mp4")).toBe(video);
    fireEvent.ended(video);
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
  });

  it("does not infer authorization from a generic media error and caps manual fresh-URL retry at one", async () => {
    const api = viewerApi();
    render(<Viewer api={api} items={items} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
      if (nodeId === "image-1") {
        selectedAttempts += 1;
        if (selectedAttempts < 2) throw Object.assign(new Error("expired"), { code: "PROVIDER_UNAUTHORIZED" });
      }
      return { url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" };
    });
    render(<Viewer api={api} items={items} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    expect(await screen.findByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/image-1");
    expect(selectedAttempts).toBe(2);

    cleanup();
    selectedAttempts = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async nodeId => {
      if (nodeId === "image-1") {
        selectedAttempts += 1;
        throw Object.assign(new Error("expired"), { code: "PROVIDER_UNAUTHORIZED" });
      }
      return { url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" };
    });
    render(<Viewer api={api} items={items} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    expect(await screen.findByText("A fresh link did not solve this media error.")).toBeVisible();
    expect(selectedAttempts).toBe(2);
  });

  it("resumes video and saves finite history every 15s, on pause, seek, visibility loss, pagehide, switch, and close", async () => {
    vi.useFakeTimers();
    const api = viewerApi();
    vi.mocked(api.history).mockResolvedValue({ history: [{
      nodeId: "video-1", positionSeconds: 42, durationSeconds: 100, completed: false,
      updatedAt: "2026-08-26T00:00:00.000Z"
    }] });
    const view = render(<Viewer api={api} items={items} selectedItemId="video-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42);
    video.currentTime = 50;
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.saveHistory).toHaveBeenCalledTimes(1);
    fireEvent.pause(video);
    expect(api.saveHistory).toHaveBeenCalledTimes(2);
    fireEvent.seeked(video);
    expect(api.saveHistory).toHaveBeenCalledTimes(3);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(api.saveHistory).toHaveBeenCalledTimes(4);
    fireEvent(window, new Event("pagehide"));
    expect(api.saveHistory).toHaveBeenCalledTimes(5);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(api.saveHistory).toHaveBeenCalledTimes(6);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const returned = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(returned, "duration", { configurable: true, value: 100 });
    Object.defineProperty(returned, "currentTime", { configurable: true, writable: true, value: 60 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(api.saveHistory).toHaveBeenCalledTimes(7);
    expect(api.saveHistory).toHaveBeenNthCalledWith(1, "video-1", { positionSeconds: 50, durationSeconds: 100, completed: false });
    expect(api.saveHistory).toHaveBeenLastCalledWith("video-1", { positionSeconds: 60, durationSeconds: 100, completed: false });
    view.unmount();
  });

  it("offers ten-second video seeking and shows a safe unsupported-codec explanation", async () => {
    render(<Viewer api={viewerApi()} items={items} selectedItemId="video-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
    render(<Viewer api={api} items={items} selectedItemId="video-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(video.src).toBe("https://provider.example/video-1");
    expect(api.mediaUrl).toHaveBeenCalledWith("video-1", expect.any(AbortSignal));
  });

  it("prefetches at most one adjacent image on each side", async () => {
    const sequence = [
      media("image-0", "image", "Before.jpg", "image/jpeg"),
      media("image-1", "image", "First.jpg", "image/jpeg"),
      media("image-2", "image", "After.jpg", "image/jpeg"),
      media("image-3", "image", "Too-far.jpg", "image/jpeg")
    ];
    const { container } = render(<Viewer api={viewerApi()} items={sequence} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await screen.findByRole("img", { name: "First.jpg" });
    const prefetched = Array.from(container.querySelectorAll<HTMLImageElement>(".viewer-prefetch"));
    expect(prefetched.map(image => image.src).sort()).toEqual([
      "https://provider.example/image-0",
      "https://provider.example/image-2"
    ]);
  });

  it("auto-hides controls only after playback starts and exposes buffered progress", async () => {
    vi.useFakeTimers();
    const { container } = render(<Viewer api={viewerApi()} items={items} selectedItemId="video-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    const controls = container.querySelector(".video-controls")!;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 1, end: () => 60 } });
    fireEvent.canPlay(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(controls).toHaveClass("is-visible");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    fireEvent.progress(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(controls).not.toHaveClass("is-visible");
    expect(screen.getByRole("progressbar", { name: "Buffered", hidden: true })).toHaveAttribute("aria-valuenow", "60");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(controls).toHaveClass("is-visible");
  });

  it("ignores stale URL completions after navigation cancels an obsolete request", async () => {
    const api = viewerApi();
    let resolveFirst: ((value: { url: string; expiresAt: string; revision: string | null }) => void) | null = null;
    vi.mocked(api.mediaUrl).mockImplementation((nodeId, signal) => {
      if (nodeId === "image-1") return new Promise(resolve => {
        resolveFirst = resolve;
        signal?.addEventListener("abort", () => undefined);
      });
      return Promise.resolve({ url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" });
    });
    render(<Viewer api={api} items={items} selectedItemId="image-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    await act(async () => { resolveFirst?.({ url: "https://provider.example/stale", expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" }); });
    expect(screen.getByRole("img", { name: "Last.jpg" })).toHaveAttribute("src", "https://provider.example/image-2");
    expect(screen.queryByDisplayValue("https://provider.example/stale")).not.toBeInTheDocument();
  });

  it("resumes at the same timestamp after the single fresh-link retry", async () => {
    const api = viewerApi();
    render(<Viewer api={api} items={items} selectedItemId="video-1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
});

const items: MediaNodeDto[] = [
  media("image-1", "image", "First.jpg", "image/jpeg"),
  media("video-1", "video", "Clip.mp4", "video/mp4"),
  media("image-2", "image", "Last.jpg", "image/jpeg")
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
    mediaUrl: vi.fn(async nodeId => ({ url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "revision-1" })),
    history: vi.fn(async () => ({ history: [] })),
    saveHistory: vi.fn(async (nodeId, value) => ({ history: { nodeId, ...value, updatedAt: "2026-08-26T00:00:00.000Z" } }))
  };
}
