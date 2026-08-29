// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectMediaUrlResponse, GoogleBearerMediaUrlResponse, TvBrowseItemDto } from "@cloudframe/shared";
import type { TvApi } from "../api/client";
import {
  GoogleMediaBridgeError,
  unavailableGoogleMediaBridge,
  type GoogleMediaBridge,
  type GoogleMediaDeliveryEvidence,
  type PreparedGoogleMediaSource
} from "../media/google-media-bridge";
import { createLocalWatchHistory, type LocalWatchHistory } from "../state/local-watch-history";
import { Viewer } from "./viewer";

const TestViewer = (props: Omit<Parameters<typeof Viewer>[0], "googleMedia">) => (
  <Viewer googleMedia={unavailableGoogleMediaBridge} {...props} />
);

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
    await act(async () => {
      adjacentPreparation.reject(new GoogleMediaBridgeError("GOOGLE_MEDIA_BRIDGE_UNAVAILABLE"));
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "Direct Google playback is unavailable on this browser" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowRight" });
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
    expect(await screen.findByLabelText("Playing Clip.mp4"))
      .toHaveAttribute("src", directDescriptor("item_video_1", "video").url);
    expect(bridge.prepare).not.toHaveBeenCalled();
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
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    fireEvent.error(image);
    expect(api.mediaUrl).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(3));
    fireEvent.error(await screen.findByRole("img", { name: "First.jpg" }));
    fireEvent.click(screen.getByRole("button", { name: "Try fresh URL" }));
    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(4));
    expect(await screen.findByRole("img", { name: "First.jpg" })).toBeVisible();
  });

  it("retries a delivered legacy MPEG once through its filename alias", async () => {
    const { bridge, api } = deliveredMpegHarness();
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "duration", { configurable: true, value: 100 });
    Object.defineProperty(raw, "currentTime", { configurable: true, writable: true, value: 37 });
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });

    fireEvent.error(raw);

    await waitFor(() => expect(bridge.filenameSource).toHaveBeenCalledWith("session_mpeg"));
    expect(bridge.waitForEvidence).toHaveBeenCalledWith("session_mpeg", 300);
    await waitFor(() => expect(screen.getByLabelText("Playing MOV00516.MPG"))
      .toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG"));
    const alias = screen.getByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    expect(alias).not.toBe(raw);
    expect(screen.getByText("Resuming at 0:37")).toBeVisible();
    expect(api.mediaUrl).toHaveBeenCalledTimes(1);
    Object.defineProperty(alias, "duration", { configurable: true, value: 100 });
    Object.defineProperty(alias, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(alias);
    expect(alias.currentTime).toBe(37);

    bridge.evidence.mockReturnValue({
      attempt: "google-filename", outcome: "response", status: 206,
    });
    Object.defineProperty(alias, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(alias);

    expect(await screen.findByRole("heading", { name: "This file reached the TV, but could not be decoded" })).toBeVisible();
    expect(bridge.filenameSource).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("coalesces duplicate native failures into one filename alias substitution", async () => {
    const evidence = deferred<GoogleMediaDeliveryEvidence>();
    const { bridge, api } = deliveredMpegHarness();
    bridge.waitForEvidence.mockReturnValue(evidence.promise);
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });

    raw.dispatchEvent(new Event("error"));
    raw.dispatchEvent(new Event("error"));
    await act(async () => { evidence.resolve({ attempt: "google-raw", outcome: "response", status: 206 }); });

    await waitFor(() => expect(screen.getByLabelText("Playing MOV00516.MPG"))
      .toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG"));
    expect(bridge.waitForEvidence).toHaveBeenCalledTimes(1);
    expect(bridge.filenameSource).toHaveBeenCalledTimes(1);
  });

  it("treats a missing same-session filename source as a bridge failure", async () => {
    const { bridge, api } = deliveredMpegHarness();
    bridge.filenameSource.mockReturnValue(null);
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });

    fireEvent.error(raw);

    expect(await screen.findByRole("heading", { name: "Direct Google playback is unavailable on this browser" })).toBeVisible();
    expect(screen.queryByText(/could not be decoded/iu)).not.toBeInTheDocument();
  });

  it("requires successful delivery evidence for the currently mounted filename attempt", async () => {
    const { bridge, api } = deliveredMpegHarness();
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(raw);
    await waitFor(() => expect(screen.getByLabelText("Playing MOV00516.MPG"))
      .toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG"));
    const alias = screen.getByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(alias, "error", { configurable: true, value: { code: 4 } });

    bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "response", status: 206 });
    fireEvent.error(alias);

    expect(await screen.findByRole("heading", { name: "This media could not be opened" })).toBeVisible();
    expect(screen.queryByText(/could not be decoded/iu)).not.toBeInTheDocument();
    expect(bridge.filenameSource).toHaveBeenCalledTimes(1);
  });

  it("ignores a late error from the removed raw video after the filename alias mounts", async () => {
    const { bridge, api } = deliveredMpegHarness();
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(raw);
    await waitFor(() => expect(screen.getByLabelText("Playing MOV00516.MPG"))
      .toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG"));
    bridge.evidence.mockReturnValue({ attempt: "google-filename", outcome: "response", status: 206 });

    raw.dispatchEvent(new Event("error"));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole("heading", { name: "This file reached the TV, but could not be decoded" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Playing MOV00516.MPG")).toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG");
  });

  it("classifies a filename alias network failure as transport", async () => {
    const { bridge, api } = deliveredMpegHarness();
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(raw);
    await waitFor(() => expect(screen.getByLabelText("Playing MOV00516.MPG"))
      .toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG"));
    const alias = screen.getByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;

    bridge.evidence.mockReturnValue({ attempt: "google-filename", outcome: "network-error" });
    fireEvent.error(alias);

    expect(await screen.findByRole("heading", { name: "The Google media link could not be opened" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("classifies any failed filename attempt after successful delivery as a decoder failure", async () => {
    const { bridge, api } = deliveredMpegHarness();
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const raw = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(raw, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(raw);
    await waitFor(() => expect(screen.getByLabelText("Playing MOV00516.MPG"))
      .toHaveAttribute("src", "/__cloudframe_media__/session_mpeg/MOV00516.MPG"));
    const alias = screen.getByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(alias, "error", { configurable: true, value: { code: 3 } });
    bridge.evidence.mockReturnValue({ attempt: "google-filename", outcome: "response", status: 206 });

    fireEvent.error(alias);

    expect(await screen.findByRole("heading", { name: "This file reached the TV, but could not be decoded" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it.each([401, 403])("renews once when worker evidence reports %s", async status => {
    const { bridge, api } = deliveredMpegHarness();
    bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "response", status });
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 37 });

    fireEvent.error(video);

    await waitFor(() => expect(api.mediaUrl).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Resuming at 0:37")).toBeVisible();
    expect(bridge.filenameSource).not.toHaveBeenCalled();
  });

  it.each([
    [{ attempt: "google-raw", outcome: "bridge-error" }, "Direct Google playback is unavailable on this browser"],
    [{ attempt: "google-raw", outcome: "network-error" }, "The Google media link could not be opened"],
    [{ attempt: "google-raw", outcome: "response", status: 500 }, "The Google media link could not be opened"],
  ] as const)("shows secret-safe evidence error copy for $1", async (evidence, expectedCopy) => {
    const { bridge, api } = deliveredMpegHarness();
    bridge.evidence.mockReturnValue(evidence as GoogleMediaDeliveryEvidence);
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;

    fireEvent.error(video);

    expect(await screen.findByRole("heading", { name: expectedCopy })).toBeVisible();
    expect(document.body.innerHTML).not.toContain("ya29.test-token");
    expect(document.body.innerHTML).not.toContain("www.googleapis.com");
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("does not call code 4 a decoder failure without successful delivery evidence", async () => {
    const { bridge, api } = deliveredMpegHarness();
    bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "none" });
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });

    fireEvent.error(video);

    expect(await screen.findByRole("heading", { name: "This media could not be opened" })).toBeVisible();
    expect(screen.queryByText(/could not be decoded/iu)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try fresh URL" })).toBeVisible();
  });

  it("classifies delivered non-MPEG code 4 as a decoder failure without an alias retry", async () => {
    const mp4Item = media("item_delivered_mp4", "video", "Delivered.mp4", "video/mp4");
    const { bridge, api } = deliveredGoogleHarness(mp4Item);
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mp4Item]} selectedItemId={mp4Item.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Delivered.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });

    fireEvent.error(video);

    expect(await screen.findByRole("heading", { name: "This file reached the TV, but could not be decoded" })).toBeVisible();
    expect(bridge.filenameSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
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
    expect(bridge.filenameSource).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Try fresh URL" })).not.toBeInTheDocument();
  });

  it("ignores delayed evidence after the failed session is no longer active", async () => {
    const evidence = deferred<GoogleMediaDeliveryEvidence>();
    const bridge = fakeGoogleMediaBridge();
    bridge.waitForEvidence.mockReturnValue(evidence.promise);
    bridge.evidence.mockReturnValue({ attempt: "google-raw", outcome: "response", status: 206 });
    const api = googleViewerApi();
    const sequence = [mpegItem, media("item_after_mpeg", "image", "After.jpg", "image/jpeg")];
    render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={sequence} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);
    expect(bridge.waitForEvidence).toHaveBeenCalledWith("session_mpeg", 300);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(await screen.findByRole("img", { name: "After.jpg" })).toBeVisible();
    await act(async () => { evidence.resolve({ attempt: "google-raw", outcome: "response", status: 206 }); });

    expect(bridge.filenameSource).not.toHaveBeenCalled();
    expect(screen.getByRole("img", { name: "After.jpg" })).toBeVisible();
  });

  it("ignores delayed evidence after the viewer unmounts", async () => {
    const evidence = deferred<GoogleMediaDeliveryEvidence>();
    const { bridge, api } = deliveredMpegHarness();
    bridge.waitForEvidence.mockReturnValue(evidence.promise);
    const view = render(<Viewer googleMedia={bridge} history={viewerHistory()} api={api}
      items={[mpegItem]} selectedItemId={mpegItem.id} slideshowSeconds={8}
      previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing MOV00516.MPG") as HTMLVideoElement;
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);

    view.unmount();
    await act(async () => { evidence.resolve({ attempt: "google-raw", outcome: "response", status: 206 }); });

    expect(bridge.filenameSource).not.toHaveBeenCalled();
    expect(bridge.release).toHaveBeenCalledWith("session_mpeg");
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

  it("offers ten-second video seeking and keeps direct code 4 on the generic retry path", async () => {
    render(<TestViewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 30 });
    fireEvent.keyDown(window, { key: "MediaFastForward", keyCode: 417 });
    expect(video.currentTime).toBe(40);
    fireEvent.keyDown(window, { key: "MediaRewind", keyCode: 412 });
    expect(video.currentTime).toBe(30);
    Object.defineProperty(video, "error", { configurable: true, value: { code: 4 } });
    fireEvent.error(video);
    expect(screen.getByRole("heading", { name: "This media could not be opened" })).toBeVisible();
    expect(screen.getAllByText("Clip.mp4")).toHaveLength(2);
    expect(screen.getByText("video/mp4")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try fresh URL" })).toBeVisible();
  });

  it("uses provider URLs directly and never fetches media bytes through the app", async () => {
    const api = viewerApi();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(video.src).toBe("https://provider.example/item_video_1");
    expect(api.mediaUrl).toHaveBeenCalledWith("sealed-item_video_1", expect.any(AbortSignal), { itemId: "item_video_1", kind: "video" });
  });

  it("keeps one native video inside the Video.js 10 state and container boundary", async () => {
    render(<TestViewer history={viewerHistory()} api={viewerApi()} items={items} selectedItemId="item_video_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);

    const video = await screen.findByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("src")).toBe("https://provider.example/item_video_1");
    expect(video).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(video.closest("media-container")?.parentElement?.tagName.toLowerCase()).toBe("video-player");

    Object.defineProperty(video, "duration", { configurable: true, value: 100 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 0 });
    fireEvent.loadedMetadata(video);
    fireEvent.play(video);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
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

    expect(api.mediaUrl).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(screen.getByRole("img", { name: "First.jpg" })).toHaveAttribute("src", "https://provider.example/image-3"));
  });

  it("resumes an active video at its exact position after timed URL renewal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let videoCalls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
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
      resolveInitialVideo({ ...mediaResponse("sealed-item_video_1"), url: "https://provider.example/due-video-1", expiresAt: new Date(acceptedAt + 1).toISOString() });
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

  it("samples a prefetched video at fire time after it becomes active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let videoCalls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
      if (result.kind === "video") videoCalls += 1;
      return {
        ...result,
        url: result.kind === "video" ? `https://provider.example/prefetched-video-${videoCalls}` : result.url,
        expiresAt: new Date(Date.now() + (result.kind === "video" && videoCalls === 1 ? 1_000 : 60_000)).toISOString()
      };
    });
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={() => undefined} />);
    for (let attempt = 0; attempt < 10 && vi.getTimerCount() < 2; attempt += 1) {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const activeVideo = screen.getByLabelText("Playing Clip.mp4") as HTMLVideoElement;
    Object.defineProperty(activeVideo, "duration", { configurable: true, value: 100 });
    Object.defineProperty(activeVideo, "currentTime", { configurable: true, value: 37 });
    fireEvent.timeUpdate(activeVideo);

    await act(async () => { await vi.advanceTimersByTimeAsync(401); await Promise.resolve(); });
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

  it("renews an expired adjacent URL and ignores later timers after close", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const api = viewerApi();
    let videoCalls = 0;
    vi.mocked(api.mediaUrl).mockImplementation(async handle => {
      const result = mediaResponse(handle);
      if (result.kind === "video") videoCalls += 1;
      return { ...result, expiresAt: new Date(Date.now() + (result.kind === "video" && videoCalls === 1 ? 1_000 : 60_000)).toISOString() };
    });
    const closed = vi.fn();
    render(<TestViewer history={viewerHistory()} api={api} items={items} selectedItemId="item_image_1" slideshowSeconds={8} previews={{}} onClose={closed} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const callsBefore = vi.mocked(api.mediaUrl).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });
    expect(vi.mocked(api.mediaUrl).mock.calls.filter(call => call[0] === "sealed-item_video_1")).toHaveLength(2);
    fireEvent.keyDown(window, { key: "Escape" });

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(api.mediaUrl).toHaveBeenCalledTimes(callsBefore + 1);
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
    expect(document.body.innerHTML).not.toContain(result.url);
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
    createdAtProvider: null, modifiedAtProvider: null, thumbnailRevision: "revision-1", hasPreview: true
  };
}

function viewerApi(): TvApi {
  return {
    bootstrap: vi.fn(), createDeviceRequest: vi.fn(), requestStatus: vi.fn(), home: vi.fn(), folder: vi.fn(),
    thumbnailUrls: vi.fn(),
    mediaUrl: vi.fn(async handle => mediaResponse(handle))
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
  filenameSource: ReturnType<typeof vi.fn<GoogleMediaBridge["filenameSource"]>>;
  evidence: ReturnType<typeof vi.fn<GoogleMediaBridge["evidence"]>>;
  waitForEvidence: ReturnType<typeof vi.fn<GoogleMediaBridge["waitForEvidence"]>>;
  release: ReturnType<typeof vi.fn<GoogleMediaBridge["release"]>>;
}

function fakeGoogleMediaBridge(): FakeGoogleMediaBridge {
  return {
    prepare: vi.fn<GoogleMediaBridge["prepare"]>(async descriptor => preparedGoogle(descriptor.itemId, "google-raw")),
    filenameSource: vi.fn<GoogleMediaBridge["filenameSource"]>(() => null),
    evidence: vi.fn<GoogleMediaBridge["evidence"]>(() => ({ outcome: "none", attempt: "google-raw" })),
    waitForEvidence: vi.fn<GoogleMediaBridge["waitForEvidence"]>(async () => ({ outcome: "none", attempt: "google-raw" })),
    release: vi.fn<GoogleMediaBridge["release"]>(),
  };
}

function deliveredMpegHarness(): { bridge: FakeGoogleMediaBridge; api: TvApi } {
  return deliveredGoogleHarness(mpegItem, "session_mpeg", "/__cloudframe_media__/session_mpeg/MOV00516.MPG");
}

function deliveredGoogleHarness(
  item: TvBrowseItemDto,
  sessionId = `session_${item.id}`,
  filenameUrl = `/__cloudframe_media__/${sessionId}/${encodeURIComponent(item.name)}`
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
  bridge.filenameSource.mockReturnValue({
    sourceUrl: filenameUrl,
    sourceKind: "google-filename",
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
