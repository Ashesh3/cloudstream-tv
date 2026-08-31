// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectMediaUrlResponse, GoogleBearerMediaUrlResponse, TvBrowseItemDto } from "@cloudframe/shared";
import type { TvApi } from "../api/client";
import {
  GoogleMediaBridgeError,
  unavailableGoogleMediaBridge,
  type GoogleMediaBridge,
  type PreparedGoogleMediaSource
} from "../media/google-media-bridge";
import { createLocalWatchHistory, type LocalWatchHistory } from "../state/local-watch-history";
import { Viewer } from "./viewer";
import { attachHlsSource } from "../media/hls-playback";
import { loadVideoJs } from "../videojs";

vi.mock("../videojs", () => ({ loadVideoJs: vi.fn(async () => false) }));
vi.mock("../media/hls-playback", () => ({
  attachHlsSource: vi.fn(async (video: HTMLVideoElement, playlistUrl: string, options: { onFatal(error: { kind: string }): void }) => {
    video.src = playlistUrl;
    const error = () => options.onFatal({ kind: "media" });
    video.addEventListener("error", error);
    return { mode: "native-hls", handlesElementErrors: true, destroy() { video.removeEventListener("error", error); video.removeAttribute("src"); } };
  }),
}));

const TestViewer = (props: Omit<Parameters<typeof Viewer>[0], "googleMedia">) => (
  <Viewer googleMedia={unavailableGoogleMediaBridge} {...props} />
);

describe("unified TV viewer", () => {
  beforeEach(() => {
    vi.mocked(loadVideoJs).mockResolvedValue(false);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prepares Google video before assigning the raw Drive URL", async () => {
    const bridge = fakeGoogleMediaBridge();
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_video_1", "video"));

    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={items} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);

    expect(await screen.findByLabelText("Playing Clip.mp4"))
      .toHaveAttribute("src", googleDescriptor("item_video_1", "video").url);
    const videoPreparation = bridge.prepare.mock.calls.find(call => call[1].kind === "video");
    expect(videoPreparation?.[0]).toMatchObject({
      itemId: "item_video_1",
      kind: "video",
      transport: "google-bearer",
      url: googleDescriptor("item_video_1", "video").url,
      authorization: { scheme: "Bearer", token: "ya29.test-token" },
    });
    expect(videoPreparation?.[1]).toEqual({ name: "Clip.mp4", kind: "video", mimeType: "video/mp4", size: 1_000 });
    expect(videoPreparation?.[2]).toBeInstanceOf(AbortSignal);
    expect(document.body.innerHTML).not.toContain("ya29.test-token");
  });

  it("prepares a full-size Google image through the same bridge", async () => {
    const bridge = fakeGoogleMediaBridge();
    const api = viewerApi();
    const preparation = deferred<PreparedGoogleMediaSource>();
    bridge.prepare.mockReturnValue(preparation.promise);
    vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_image_1", "image"));
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={items} selectedItemId="item_image_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    expect(screen.queryByRole("img", { name: "First.jpg" })).not.toBeInTheDocument();
    preparation.resolve(preparedGoogle("item_image_1", "google-raw"));
    expect(await screen.findByRole("img", { name: "First.jpg" }))
      .toHaveAttribute("src", googleDescriptor("item_image_1", "image").url);
  });

  it("maps Google bridge preparation failures without exposing credentials", async () => {
    const bridge = fakeGoogleMediaBridge();
    bridge.prepare.mockRejectedValue(new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE"));
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_image_1", "image"));

    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[items[0]!]} selectedItemId="item_image_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Direct Google playback is unavailable on this browser" })).toBeVisible();
    expect(document.body.innerHTML).not.toContain("ya29.test-token");
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it.each([
    ["TRANSCODER_BUSY", "Another TV is using the transcoder"],
    ["TRANSCODER_CACHE_FULL", "The transcode cache is full"],
    ["TRANSCODER_WINDOW_TIMEOUT", "Transcoding took too long"],
    ["TRANSCODER_UNSUPPORTED", "This video cannot be transcoded"],
    ["TRANSCODER_SOURCE_UNAVAILABLE", "Cloudframe could not read this video"],
    ["TRANSCODER_FAILED", "Cloudframe could not transcode this video"],
  ])("shows an actionable %s fallback error without offering a fresh provider URL", async (code, title) => {
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async (_handle, _signal, expected, options) => {
      if (expected?.itemId === "item_video_1" && options?.fallback === "hls") throw Object.assign(new Error(code), { code });
      return mediaResponse(`sealed-${expected?.itemId ?? "item_image_1"}`);
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);

    expect(await screen.findByRole("heading", { name: title })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it.each([
    ["busy", "Another TV is using the transcoder"],
    ["cache-full", "The transcode cache is full"],
    ["timeout", "Transcoding took too long"],
    ["unsupported-source", "This video cannot be transcoded"],
    ["source", "Cloudframe could not read this video"],
    ["failed", "Cloudframe could not transcode this video"],
  ] as const)("shows the actionable %s state when an HLS segment request fails", async (kind, title) => {
    const api = viewerApi();
    const sessionId = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    vi.mocked(api.mediaUrl).mockResolvedValue({
      itemId: "item_video_1",
      kind: "video",
      transport: "hls",
      playlistUrl: `/api/tv/transcodes/${sessionId}/master.m3u8`,
      playbackSessionId: sessionId,
      durationSeconds: 65,
      profile: "h264-aac-1080p-v1",
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
      revision: "revision-1",
    });
    vi.mocked(attachHlsSource).mockImplementationOnce(async (video, playlistUrl, options) => {
      video.src = playlistUrl;
      const onError = () => { void Promise.resolve().then(() => options.onFatal({ kind })); };
      video.addEventListener("error", onError);
      return { mode: "native-hls", handlesElementErrors: true, destroy() { video.removeEventListener("error", onError); video.removeAttribute("src"); } };
    });
    render(<TestViewer history={viewerHistory()} api={api} items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4");
    await waitFor(() => expect(api.heartbeatTranscode).toHaveBeenCalledWith(sessionId));
    fireEvent.error(video);

    expect(await screen.findByRole("heading", { name: title })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("shows an adjacent Google bridge failure when navigating to that item", async () => {
    const bridge = fakeGoogleMediaBridge();
    const adjacentPreparation = deferred<PreparedGoogleMediaSource>();
    bridge.prepare.mockImplementation(descriptor => descriptor.itemId === "item_video_1"
      ? adjacentPreparation.promise
      : Promise.resolve(preparedGoogle(descriptor.itemId, "google-raw")));
    const api = googleViewerApi();

    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={items} selectedItemId="item_image_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);

    expect(await screen.findByRole("img", { name: "First.jpg" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Direct Google playback is unavailable on this browser" })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "item_video_1" }),
      expect.objectContaining({ kind: "video" }),
      expect.any(AbortSignal),
    ));
    await act(async () => {
      adjacentPreparation.reject(new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE"));
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { name: "Direct Google playback is unavailable on this browser" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
    expect(screen.queryByText("Preparing video…")).not.toBeInTheDocument();
  });

  it("keeps OneDrive direct and never calls the Google bridge", async () => {
    const bridge = fakeGoogleMediaBridge();
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockResolvedValue(directDescriptor("item_video_1", "video"));
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={items} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const descriptor = directDescriptor("item_video_1", "video");
    expect(await screen.findByLabelText("Playing Clip.mp4"))
      .toHaveAttribute("src", descriptor.transport === "hls" ? descriptor.playlistUrl : descriptor.url);
    expect(bridge.prepare).not.toHaveBeenCalled();
  });

  it("falls back from a direct decoder failure to HLS once and restores the saved timestamp", async () => {
    const api = viewerApi();
    const sessionId = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    vi.mocked(api.mediaUrl)
      .mockResolvedValueOnce(directDescriptor("item_video_1", "video"))
      .mockResolvedValueOnce({
        itemId: "item_video_1",
        kind: "video",
        transport: "hls",
        playlistUrl: `/api/tv/transcodes/${sessionId}/master.m3u8`,
        playbackSessionId: sessionId,
        durationSeconds: 65.832,
        profile: "h264-aac-1080p-v1",
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
        revision: "revision-1",
      });
    render(<TestViewer history={viewerHistory()} api={api} items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const direct = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(direct, "duration", { configurable: true, value: 100 });
    Object.defineProperty(direct, "currentTime", { configurable: true, writable: true, value: 37 });
    Object.defineProperty(direct, "error", { configurable: true, value: { code: 4 } });

    fireEvent.error(direct);

    await waitFor(() => expect(api.mediaUrl).toHaveBeenLastCalledWith(
      "sealed-item_video_1",
      expect.any(AbortSignal),
      { itemId: "item_video_1", kind: "video" },
      { fallback: "hls" },
    ));
    const hls = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(hls).not.toBe(direct);
    expect(screen.getByText("Resuming at 0:37")).toBeVisible();
    Object.defineProperty(hls, "duration", { configurable: true, value: 100 });
    Object.defineProperty(hls, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(hls);
    expect(hls.currentTime).toBe(37);
    Object.defineProperty(hls, "error", { configurable: true, value: { code: 3 } });
    fireEvent.error(hls);
    expect(await screen.findByRole("heading", { name: "The transcoded playback session ended" })).toBeVisible();
    expect(api.mediaUrl).toHaveBeenCalledTimes(2);
  });

  it("owns one active HLS heartbeat and releases the session on navigation", async () => {
    vi.useFakeTimers();
    const api = viewerApi();
    const sessionId = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      if (handle === `sealed-${mpegItem.id}`) {
        return {
          itemId: mpegItem.id,
          kind: "video",
          transport: "hls",
          playlistUrl: `/api/tv/transcodes/${sessionId}/master.m3u8`,
          playbackSessionId: sessionId,
          durationSeconds: 65.832,
          profile: "h264-aac-1080p-v1",
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
          revision: "revision-1",
        };
      }
      return mediaResponse(handle);
    });
    const sequence = [mpegItem, media("item_after_hls", "image", "After.jpg", "image/jpeg")];
    render(<TestViewer history={viewerHistory()} api={api} items={sequence} selectedItemId={mpegItem.id} slideshowSeconds={8} previews={{}} onClose={() => undefined} />);

    const hlsVideo = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); await Promise.resolve(); });
    expect(attachHlsSource).toHaveBeenCalledWith(
      hlsVideo,
      `/api/tv/transcodes/${sessionId}/master.m3u8`,
      expect.objectContaining({ onFatal: expect.any(Function) }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); });
    expect(api.heartbeatTranscode).toHaveBeenCalledWith(sessionId);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.heartbeatTranscode).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "After.jpg" })).toBeVisible();
    await act(async () => { await Promise.resolve(); });
    expect(api.releaseTranscode).toHaveBeenCalledWith(sessionId);
  });

  it("releases grants on renewal and unmount without duplicate release", async () => {
    const bridge = fakeGoogleMediaBridge();
    bridge.prepare
      .mockResolvedValueOnce(preparedGoogle("item_video_1-first", "google-raw"))
      .mockResolvedValueOnce(preparedGoogle("item_video_1-second", "google-raw"));
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_video_1", "video"));
    const rendered = render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const first = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(first, "currentTime", { configurable: true, value: 12 });
    fireEvent.error(first);
    fireEvent.click(await screen.findByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(bridge.release).toHaveBeenCalledWith("session_item_video_1-first"));
    rendered.unmount();
    expect(bridge.release).toHaveBeenCalledWith("session_item_video_1-second");
    expect(new Set(bridge.release.mock.calls.map(call => call[0])).size)
      .toBe(bridge.release.mock.calls.length);
  });

  it("replaces the native video element when a prepared source renews", async () => {
    const bridge = fakeGoogleMediaBridge();
    bridge.prepare
      .mockResolvedValueOnce(preparedGoogle("item_video_1-first", "google-raw"))
      .mockResolvedValueOnce(preparedGoogle("item_video_1-second", "google-raw"));
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_video_1", "video"));
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const first = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    fireEvent.error(first);
    fireEvent.click(await screen.findByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Playing Clip.mp4")).not.toBe(first);
  });

  it("releases every prepared grant even if a bridge reuses a session ID", async () => {
    const bridge = fakeGoogleMediaBridge();
    const shared = {
      sourceUrl: googleDescriptor("item_video_1", "video").url,
      sourceKind: "google-raw" as const,
      sessionId: "session_shared",
      fingerprint: "A".repeat(43),
    };
    bridge.prepare.mockResolvedValue(shared);
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor("item_video_1", "video"));
    const rendered = render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const first = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    fireEvent.error(first);
    fireEvent.click(await screen.findByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(bridge.prepare).toHaveBeenCalledTimes(2));
    rendered.unmount();

    expect(bridge.release).toHaveBeenCalledTimes(2);
    expect(bridge.release).toHaveBeenNthCalledWith(1, "session_shared");
    expect(bridge.release).toHaveBeenNthCalledWith(2, "session_shared");
  });

  it("owns a reused prepared session through only the latest URL-window node", async () => {
    const bridge = fakeGoogleMediaBridge();
    bridge.prepare.mockResolvedValue({
      sourceUrl: googleDescriptor("item_image_1", "image").url,
      sourceKind: "google-raw",
      sessionId: "session_shared_window",
      fingerprint: "A".repeat(43),
    });
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const id = handle.replace(/^sealed-/, "");
      return googleDescriptor(id, "image");
    });
    const sequence = [
      media("item_image_0", "image", "Before.jpg", "image/jpeg"),
      media("item_image_1", "image", "First.jpg", "image/jpeg"),
      media("item_image_2", "image", "After.jpg", "image/jpeg"),
      media("item_image_3", "image", "Last.jpg", "image/jpeg"),
    ];
    const rendered = render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={sequence} selectedItemId="item_image_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    await screen.findByRole("img", { name: "First.jpg" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    rendered.unmount();

    expect(bridge.release).toHaveBeenCalledTimes(1);
    expect(bridge.release).toHaveBeenCalledWith("session_shared_window");
  });

  it("releases prepared grants on close and device revocation", async () => {
    const closeBridge = fakeGoogleMediaBridge();
    const closeView = render(<Viewer googleMedia={closeBridge} history={viewerHistory()} api={googleViewerApi()}
      items={[items[0]!]} selectedItemId="item_image_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    await screen.findByRole("img", { name: "First.jpg" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeBridge.release).toHaveBeenCalledWith("session_item_image_1");
    closeView.unmount();

    const unauthorizedBridge = fakeGoogleMediaBridge();
    const unauthorizedApi = googleViewerApi();
    vi.mocked(unauthorizedApi.mediaUrl).mockImplementation(async handle => {
      if (handle === "sealed-item_image_2") throw Object.assign(new Error("revoked"), { code: "DEVICE_UNAUTHORIZED" });
      return googleDescriptor(handle.replace(/^sealed-/, ""), handle.indexOf("video") >= 0 ? "video" : "image");
    });
    const unauthorized = vi.fn();
    render(<Viewer googleMedia={unauthorizedBridge} history={viewerHistory()} api={unauthorizedApi}
      items={items} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} onUnauthorized={unauthorized} />);
    await waitFor(() => expect(unauthorized).toHaveBeenCalledTimes(1));
    expect(unauthorizedBridge.release).toHaveBeenCalledWith("session_item_video_1");
    expect(new Set(unauthorizedBridge.release.mock.calls.map(call => call[0])).size)
      .toBe(unauthorizedBridge.release.mock.calls.length);
  });

  it("releases prepared grants when navigation is invalidated", async () => {
    const bridge = fakeGoogleMediaBridge();
    const api = googleViewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      if (handle === "sealed-item_image_2") throw Object.assign(new Error("expired"), { code: "NAVIGATION_EXPIRED" });
      const id = handle.replace(/^sealed-/, "");
      return googleDescriptor(id, id.indexOf("video") >= 0 ? "video" : "image");
    });
    const expired = vi.fn();
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={items} selectedItemId="item_video_1" slideshowSeconds={8}
      previews={{}} onClose={() => undefined} onNavigationExpired={expired} />);

    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(bridge.release).toHaveBeenCalledWith("session_item_video_1");
    expect(new Set(bridge.release.mock.calls.map(call => call[0])).size)
      .toBe(bridge.release.mock.calls.length);
  });

  it("traverses only the loaded media sequence, owns one active video, and restores the exact opening item", async () => {
    const api = viewerApi();
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);

    expect(await screen.findByRole("img", { name: "First.jpg" })).toBeVisible();
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByLabelText("Playing Clip.mp4")).toBeVisible();
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(3));
    expect(document.querySelectorAll("video")).toHaveLength(1);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    expect(document.querySelectorAll("video")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toHaveBeenCalledWith("item_image_1");
  });

  it("opens details with Up, closes them with Down, and Back closes the overlay before the viewer", async () => {
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);
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
    render(<TestViewer history={history} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={2} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    const video = await screen.findByLabelText("Playing Clip.mp4");
    fireEvent.loadedMetadata(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
    expect(screen.getByLabelText("Playing Clip.mp4")).toBe(video);
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 100 });
    fireEvent.ended(video);
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    expect(history.get("item_video_1")).toMatchObject({ positionSeconds: 100, durationSeconds: 100, completed: true });
  });

  it("does not infer authorization from generic media errors and gives each reissued URL one retry", async () => {
    const api = viewerApi();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const image = await screen.findByRole("img", { name: "First.jpg" });
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(1));
    fireEvent.error(image);
    expect(api.mediaUrl).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    fireEvent.error(await screen.findByRole("img", { name: "First.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole("img", { name: "First.jpg" })).toBeVisible();
  });

  it("requests HLS once for a confirmed direct video decoder failure", async () => {
    const mp4Item = media("item_delivered_mp4", "video", "Delivered.mp4", "video/mp4");
    const { bridge, api } = deliveredGoogleHarness(mp4Item);
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mp4Item]} selectedItemId={mp4Item.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Delivered.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });

    fireEvent.error(video);

    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    expect(api.mediaUrl).toHaveBeenLastCalledWith(
      `sealed-${mp4Item.id}`,
      expect.any(AbortSignal),
      { itemId: mp4Item.id, kind: "video" },
      { fallback: "hls" },
    );
  });

  it("classifies a delivered Google image failure as an image decoder failure", async () => {
    const imageItem = media("item_delivered_webp", "image", "Delivered.webp", "image/webp");
    const { bridge, api } = deliveredGoogleHarness(imageItem);
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[imageItem]} selectedItemId={imageItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const image = await screen.findByRole("img", { name: "Delivered.webp" });

    fireEvent.error(image);

    expect(await screen.findByRole("heading", { name: "This file reached the TV, but could not be decoded" })).toBeVisible();
    expect(screen.getByText("The TV browser could not decode this image format.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("automatically retries one URL-vending authorization failure and then stops", async () => {
    const api = viewerApi();
    let selectedAttempts = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      if (handle === "sealed-item_image_1") {
        selectedAttempts += 1;
        if (selectedAttempts < 2) throw Object.assign(new Error("expired"), { code: "PROVIDER_UNAUTHORIZED" });
      }
      return mediaResponse(handle);
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    expect(await screen.findByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/item_image_1");
    expect(selectedAttempts).toBe(2);

    cleanup();
    selectedAttempts = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      if (handle === "sealed-item_image_1") {
        selectedAttempts += 1;
        throw Object.assign(new Error("expired"), { code: "PROVIDER_UNAUTHORIZED" });
      }
      return mediaResponse(handle);
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    expect(await screen.findByText("A fresh link did not solve this media error.")).toBeVisible();
    expect(selectedAttempts).toBe(2);
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("resumes synchronously and saves at most every 15s plus pause, lifecycle, switch, and close", async () => {
    vi.useFakeTimers();
    const api = viewerApi();
    const history = viewerHistory();
    history.save("item_video_1", { positionSeconds: 42, durationSeconds: 100, completed: false });
    const save = vi.spyOn(history, "save");
    const view = render(<TestViewer history={history} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    let video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(42);
    video.currentTime = 50;
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    save.mockClear();
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
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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
    const view = render(<TestViewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
    render(<TestViewer history={history} api={viewerApi()} items={sequence} selectedItemId="item_video_a" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
    render(<TestViewer history={history} api={viewerApi()} items={sequence} selectedItemId="item_video_a" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
    render(<TestViewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
    const view = render(<TestViewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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

    render(<TestViewer history={history} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Watch progress is unavailable on this TV, but playback will continue.");
    expect(status).toHaveClass("viewer-history-status");
    expect(status).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.play(video);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("offers ten-second video seeking and requests HLS after a direct decoder failure", async () => {
    const api = viewerApi();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 30 });
    fireEvent.keyDown(window, { key: "MediaFastForward", keyCode: 417 });
    expect(video.currentTime).toBe(40);
    fireEvent.keyDown(window, { key: "MediaRewind", keyCode: 412 });
    expect(video.currentTime).toBe(30);
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);
    await waitFor(() => expect(api.mediaUrl).toHaveBeenLastCalledWith(
      "sealed-item_video_1", expect.any(AbortSignal),
      { itemId: "item_video_1", kind: "video" }, { fallback: "hls" },
    ));
  });

  it("uses provider URLs directly and never fetches media bytes through the app", async () => {
    const api = viewerApi();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(video.src).toBe("https://provider.example/item_video_1");
    expect(api.mediaUrl).toHaveBeenCalledWith("sealed-item_video_1", expect.any(AbortSignal), { itemId: "item_video_1", kind: "video" }, undefined);
  });

  it("keeps one native video inside the Video.js 10 state and container boundary", async () => {
    render(<TestViewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);

    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("src")).toBe("https://provider.example/item_video_1");
    expect(video).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(video.closest("video-skin")?.parentElement?.tagName.toLowerCase()).toBe("video-player");
    expect(document.querySelector("media-container")).toBeNull();

    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    fireEvent.play(video);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it("hides the fallback overlay when the packaged Video.js skin registers", async () => {
    vi.mocked(loadVideoJs).mockResolvedValue(true);
    const { container } = render(<TestViewer history={viewerHistory()} api={viewerApi()} items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);

    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    await waitFor(() => expect(container.querySelector(".video-controls")).toBeNull());
    expect(video.controls).toBe(false);
    expect(video.closest("video-skin")?.parentElement?.tagName.toLowerCase()).toBe("video-player");
  });

  it("keeps native controls and Cloudframe status feedback when Video.js registration fails", async () => {
    const { container } = render(<TestViewer history={viewerHistory()} api={viewerApi()} items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);

    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    await waitFor(() => expect(video.controls).toBe(true));
    expect(container.querySelector(".video-controls")).toBeInTheDocument();
  });

  it("treats autoplay policy rejection as paused without showing a media error", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    render(<TestViewer history={viewerHistory()} api={viewerApi()} items={[items[1]!]} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);

    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    fireEvent.loadedMetadata(video);
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(video.controls).toBe(true);
    const attempts = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    fireEvent.keyDown(window, { key: "Enter" });
    await act(async () => { await Promise.resolve(); });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(attempts + 1);
  });

  it("prefetches at most one adjacent image on each side", async () => {
    const sequence = [
      media("item_image_0", "image", "Before.jpg", "image/jpeg"),
      media("item_image_1", "image", "First.jpg", "image/jpeg"),
      media("item_image_2", "image", "After.jpg", "image/jpeg"),
      media("item_image_3", "image", "Too-far.jpg", "image/jpeg")
    ];
    const { container } = render(<TestViewer history={viewerHistory()} api={viewerApi()} items={sequence} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await screen.findByRole("img", { name: "First.jpg" });
    const prefetched = Array.from(container.querySelectorAll<HTMLImageElement>(".viewer-prefetch"));
    expect(prefetched.map(image => image.src).sort()).toEqual([
      "https://provider.example/item_image_0",
      "https://provider.example/item_image_2"
    ]);
  });

  it("auto-hides controls only after playback starts and exposes buffered progress", async () => {
    vi.useFakeTimers();
    const { container } = render(<TestViewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    let video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "buffered", { configurable: true, value: { length: 1, end: () => 60 } });
    expect(video.duration).toBe(100);
    expect(video.buffered.end(0)).toBe(60);
    fireEvent.canPlay(video);
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(container.querySelector(".video-controls")).toHaveClass("is-visible");
    video = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
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
    const bridge = fakeGoogleMediaBridge();
    const preparation = deferred<PreparedGoogleMediaSource>();
    bridge.prepare.mockImplementation(async descriptor => {
      if (descriptor.itemId === "item_image_1") return preparation.promise;
      return preparedGoogle(descriptor.itemId, "google-raw");
    });
    vi.mocked(api.mediaUrl).mockImplementation((handle, signal) => {
      signal?.addEventListener("abort", () => undefined);
      const id = handle.replace(/^sealed-/, "");
      return Promise.resolve(googleDescriptor(id, id.indexOf("video") >= 0 ? "video" : "image"));
    });
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "Last.jpg" })).toBeVisible();
    await act(async () => { preparation.resolve(preparedGoogle("item_image_1-stale", "google-raw")); });
    expect(screen.getByRole("img", { name: "Last.jpg" })).toHaveAttribute("src", googleDescriptor("item_image_2", "image").url);
    expect(bridge.release).toHaveBeenCalledWith("session_item_image_1-stale");
  });

  it("resumes at the same timestamp after the single fresh-link retry", async () => {
    const api = viewerApi();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
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
    render(<TestViewer history={history} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={1} previews={{}} onClose={closed} onUnauthorized={unauthorized} />);
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

  it("requests fresh navigation once when a media handle expires", async () => {
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockRejectedValue(Object.assign(new Error("Navigation has expired."), { code: "NAVIGATION_EXPIRED" }));
    const expired = vi.fn();
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} onNavigationExpired={expired} />);
    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(closed).not.toHaveBeenCalled();
    expect(screen.queryByText("NAVIGATION_EXPIRED")).not.toBeInTheDocument();
  });

  it("renews an active image when its direct URL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let calls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => ({
      ...mediaResponse(handle),
      url: `https://provider.example/image-${++calls}`,
      expiresAt: new Date(Date.now() + (handle === "sealed-item_image_1" ? 1_000 : 60_000)).toISOString()
    }));
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/image-1");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });

    expect(api.mediaUrl).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/image-2"));
  });

  it("resumes an active video at its exact position after timed URL renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let videoCalls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
      if (result.transport === "hls") return result;
      return {
        ...result,
        url: result.kind === "video" ? `https://provider.example/video-${++videoCalls}` : result.url,
        expiresAt: new Date(Date.now() + (result.kind === "video" ? 1_000 : 60_000)).toISOString()
      };
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const first = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(first, "duration", { configurable: true, value: 100 });
    Object.defineProperty(first, "currentTime", { configurable: true, value: 37 });
    fireEvent.timeUpdate(first);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });
    const renewed = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(renewed, "duration", { configurable: true, value: 100 });
    Object.defineProperty(renewed, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(renewed);

    expect(renewed.src).toBe("https://provider.example/video-2");
    expect(renewed.currentTime).toBe(37);
  });

  it("renews an active video when its URL crosses expiry before the expiry effect installs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    const acceptedAt = Date.now();
    let videoCalls = 0;
    let resolveInitialVideo!: (value: DirectMediaUrlResponse) => void;
    vi.mocked(api.mediaUrl).mockImplementation(handle => {
      const result = mediaResponse(handle);
      if (result.kind !== "video") return Promise.resolve({ ...result, expiresAt: new Date(acceptedAt + 60_000).toISOString() });
      videoCalls += 1;
      if (videoCalls === 1) return new Promise<DirectMediaUrlResponse>(resolve => { resolveInitialVideo = resolve; });
      if (result.transport === "hls") return Promise.resolve(result);
      return Promise.resolve({
        ...result,
        url: `https://provider.example/due-video-${videoCalls}`,
        expiresAt: new Date(acceptedAt + 60_000).toISOString()
      });
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const crossedNow = vi.spyOn(Date, "now").mockReturnValue(acceptedAt + 2);
    await act(async () => {
      const initial = mediaResponse("sealed-item_video_1");
      if (initial.transport === "hls") throw new Error("expected direct fixture");
      resolveInitialVideo({ ...initial, url: "https://provider.example/due-video-1", expiresAt: new Date(acceptedAt + 1).toISOString() });
      await Promise.resolve();
      await Promise.resolve();
    });
    crossedNow.mockRestore();
    const first = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(first, "duration", { configurable: true, value: 100 });
    Object.defineProperty(first, "currentTime", { configurable: true, value: 37 });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); });
    const renewed = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(renewed, "duration", { configurable: true, value: 100 });
    Object.defineProperty(renewed, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(renewed);

    expect(renewed.src).toBe("https://provider.example/due-video-2");
    expect(renewed.currentTime).toBe(37);
  });

  it("cancels an already-due renewal when the viewer closes before the zero-delay tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async handle => ({
      ...mediaResponse(handle),
      expiresAt: new Date(Date.now() + (handle === "sealed-item_image_1" ? -1 : 60_000)).toISOString()
    }));
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const callsBeforeClose = vi.mocked(api.mediaUrl).mock.calls.length;

    fireEvent.keyDown(window, { key: "Escape" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(api.mediaUrl).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it("starts video expiry timing only after the video becomes active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let videoCalls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
      if (result.transport === "hls") return result;
      if (result.kind === "video") videoCalls += 1;
      return {
        ...result,
        url: result.kind === "video" ? `https://provider.example/prefetched-video-${videoCalls}` : result.url,
        expiresAt: new Date(Date.now() + (result.kind === "video" && videoCalls === 1 ? 1_000 : 60_000)).toISOString()
      };
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(vi.mocked(api.mediaUrl).mock.calls.filter(call => call[0] === "sealed-item_video_1")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const activeVideo = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(activeVideo, "duration", { configurable: true, value: 100 });
    Object.defineProperty(activeVideo, "currentTime", { configurable: true, value: 37 });
    fireEvent.timeUpdate(activeVideo);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });
    const renewed = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(renewed, "duration", { configurable: true, value: 100 });
    Object.defineProperty(renewed, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(renewed);

    expect(renewed.src).toBe("https://provider.example/prefetched-video-2");
    expect(renewed.currentTime).toBe(37);
  });

  it("replaces the old expiry timer when a new ready request expires sooner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let activeCalls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
      if (handle !== "sealed-item_image_1") return { ...result, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      activeCalls += 1;
      return {
        ...result,
        url: `https://provider.example/active-${activeCalls}`,
        expiresAt: new Date(Date.now() + (activeCalls === 1 ? 60_000 : 1_000)).toISOString()
      };
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const firstEntry = vi.mocked(api.mediaUrl).mock.calls.find(call => call[0] === "sealed-item_image_1")!;
    fireEvent.error(screen.getByRole("img", { name: "First.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/active-2"));
    expect(firstEntry[2]).toEqual({ itemId: "item_image_1", kind: "image" });
    const timersBefore = vi.getTimerCount();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });

    expect(activeCalls).toBe(3);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timersBefore);
  });

  it("does not vend or renew an adjacent video before close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
      return { ...result, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    });
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const callsBefore = vi.mocked(api.mediaUrl).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });
    expect(vi.mocked(api.mediaUrl).mock.calls.filter(call => call[0] === "sealed-item_video_1")).toHaveLength(0);
    fireEvent.keyDown(window, { key: "Escape" });

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(api.mediaUrl).toHaveBeenCalledTimes(callsBefore);
  });

  it("cancels an obsolete adjacent expiry timer when navigation removes its URL window entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const sequence = [
      media("item_image_0", "image", "Before.jpg", "image/jpeg"),
      media("item_image_1", "image", "First.jpg", "image/jpeg"),
      media("item_image_2", "image", "After.jpg", "image/jpeg"),
      media("item_image_3", "image", "Last.jpg", "image/jpeg")
    ];
    const api = viewerApi();
    const bridge = fakeGoogleMediaBridge();
    vi.mocked(api.mediaUrl).mockImplementation(async handle => ({
      ...googleDescriptor(handle.replace(/^sealed-/, ""), "image"),
      expiresAt: new Date(Date.now() + (handle === "sealed-item_image_0" ? 1_000 : 60_000)).toISOString()
    }));
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api} items={sequence} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const before = vi.mocked(api.mediaUrl).mock.calls.filter(call => call[0] === "sealed-item_image_0").length;
    expect(bridge.release).toHaveBeenCalledWith("session_item_image_0");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });

    expect(vi.mocked(api.mediaUrl).mock.calls.filter(call => call[0] === "sealed-item_image_0")).toHaveLength(before);
  });

  it("cancels a long-delay renewal chain after its first bounded timeout chunk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async handle => ({
      ...mediaResponse(handle),
      expiresAt: new Date(Date.now() + 2_147_001_000).toISOString()
    }));
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const before = vi.mocked(api.mediaUrl).mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(2_147_000_000); });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(api.mediaUrl).toHaveBeenCalledTimes(before);
  });

  it.each([
    ["mismatched item ID", { ...mediaResponse("sealed-item_image_1"), itemId: "item_other" }],
    ["mismatched kind", { ...mediaResponse("sealed-item_image_1"), kind: "video" as const }]
  ])("rejects a %s media response without displaying its URL", async (_name, result) => {
    const api = viewerApi();
    vi.mocked(api.mediaUrl).mockImplementation(async (handle, _signal, expected) => {
      if (handle === "sealed-item_image_1") {
        if (result.itemId !== expected?.itemId || result.kind !== expected.kind) throw Object.assign(new Error("invalid"), { code: "INVALID_RESPONSE" });
        return result;
      }
      return mediaResponse(handle);
    });
    const expired = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} onNavigationExpired={expired} />);

    await waitFor(() => expect(expired).toHaveBeenCalledTimes(1));
    expect(document.body.innerHTML).not.toContain(result.transport === "hls" ? result.playlistUrl : result.url);
  });

});

const items: TvBrowseItemDto[] = [
  media("item_image_1", "image", "First.jpg", "image/jpeg"),
  media("item_video_1", "video", "Clip.mp4", "video/mp4"),
  media("item_image_2", "image", "Last.jpg", "image/jpeg")
];

const mpegItem = media("mpeg", "video", "MOV00516.MPG", "video/mpeg");

function media(id: string, kind: "image" | "video", name: string, mimeType: string): TvBrowseItemDto {
  return {
    id, handle: `sealed-${id}`, name,
    normalizedName: name.toLowerCase(), kind, mimeType, size: 1_000, width: kind === "image" ? 1920 : 1280,
    height: kind === "image" ? 1080 : 720, capturedAt: "2026-08-01T00:00:00.000Z",
    createdAtProvider: null, modifiedAtProvider: null, thumbnailRevision: "thumbnail-1", contentRevision: "revision-1", hasPreview: true
  };
}

  function viewerApi(): TvApi {
  return {
    bootstrap: vi.fn(), createDeviceRequest: vi.fn(), requestStatus: vi.fn(), home: vi.fn(), folder: vi.fn(),
    thumbnailUrls: vi.fn(),
    mediaUrl: vi.fn(async handle => mediaResponse(handle)),
    heartbeatTranscode: vi.fn().mockResolvedValue(undefined),
    releaseTranscode: vi.fn().mockResolvedValue(undefined)
  };
}

function mediaResponse(handle: string): DirectMediaUrlResponse {
  const id = handle.replace(/^sealed-/, "");
  const item = items.find(candidate => candidate.id === id);
  const kind = item && item.kind !== "folder" ? item.kind : id.indexOf("video") >= 0 ? "video" : "image";
  return {
    itemId: id,
    kind,
    transport: "direct",
    url: `https://provider.example/${id}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revision: "revision-1"
  };
}

function googleViewerApi(): TvApi {
  const api = viewerApi();
  vi.mocked(api.mediaUrl).mockImplementation(async handle => {
    const id = handle.replace(/^sealed-/, "");
    return googleDescriptor(id, id.indexOf("video") >= 0 ? "video" : "image");
  });
  return api;
}

interface FakeGoogleMediaBridge extends GoogleMediaBridge {
  prepare: ReturnType<typeof vi.fn<GoogleMediaBridge["prepare"]>>;
  evidence: ReturnType<typeof vi.fn<GoogleMediaBridge["evidence"]>>;
  waitForEvidence: ReturnType<typeof vi.fn<GoogleMediaBridge["waitForEvidence"]>>;
  release: ReturnType<typeof vi.fn<GoogleMediaBridge["release"]>>;
}

function fakeGoogleMediaBridge(): FakeGoogleMediaBridge {
  return {
    prepare: vi.fn<GoogleMediaBridge["prepare"]>(async descriptor => preparedGoogle(descriptor.itemId, "google-raw")),
    evidence: vi.fn<GoogleMediaBridge["evidence"]>(() => ({ outcome: "none", attempt: "google-raw" })),
    waitForEvidence: vi.fn<GoogleMediaBridge["waitForEvidence"]>(async () => ({ outcome: "none", attempt: "google-raw" })),
    release: vi.fn<GoogleMediaBridge["release"]>(),
  };
}


function deliveredGoogleHarness(
  item: TvBrowseItemDto,
  sessionId = `session_${item.id}`
): { bridge: FakeGoogleMediaBridge; api: TvApi } {
  const bridge = fakeGoogleMediaBridge();
  const api = viewerApi();
  vi.mocked(api.mediaUrl).mockResolvedValue(googleDescriptor(item.id, item.kind === "video" ? "video" : "image"));
  bridge.prepare.mockResolvedValue({
    sourceUrl: googleDescriptor(item.id, item.kind === "video" ? "video" : "image").url,
    sourceKind: "google-raw",
    sessionId,
    fingerprint: "A".repeat(43),
  });
  bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "response", status: 206 });
  return { bridge, api };
}


function googleDescriptor(itemId: string, kind: "image" | "video"): GoogleBearerMediaUrlResponse {
  return {
    itemId,
    kind,
    transport: "google-bearer",
    url: `https://www.googleapis.com/drive/v3/files/${itemId}?alt=media&supportsAllDrives=true`,
    authorization: { scheme: "Bearer", token: "ya29.test-token" },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revision: "revision-1",
  };
}

function directDescriptor(itemId: string, kind: "image" | "video"): DirectMediaUrlResponse {
  return {
    itemId,
    kind,
    transport: "direct",
    url: `https://provider.example/${itemId}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    revision: "revision-1",
  };
}

function preparedGoogle(itemId: string, sourceKind: PreparedGoogleMediaSource["sourceKind"]): PreparedGoogleMediaSource {
  return {
    sourceUrl: googleDescriptor(itemId.replace(/-(?:first|second|stale)$/u, ""), itemId.indexOf("video") >= 0 ? "video" : "image").url,
    sourceKind,
    sessionId: `session_${itemId}`,
    fingerprint: "A".repeat(43),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function viewerHistory(): LocalWatchHistory {
  const values = new Map<string, string>();
  return createLocalWatchHistory({
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  }, "device-1", () => new Date("2026-08-27T12:00:00.000Z"));
}
