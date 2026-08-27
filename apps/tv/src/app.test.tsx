// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TvApp } from "./app";
import type { TvApi } from "./api/client";

const api = (): TvApi => ({
  bootstrap: vi.fn(),
  createDeviceRequest: vi.fn(),
  requestStatus: vi.fn(),
  home: vi.fn(),
  folder: vi.fn(),
  thumbnailUrls: vi.fn(),
  mediaUrl: vi.fn(),
  history: vi.fn(),
  saveHistory: vi.fn()
});

describe("TV enrollment and browse states", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a remote-operable name form for an unenrolled TV", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "unenrolled" } });
    render(<TvApp api={client} browserSupported />);
    const heading = await screen.findByRole("heading", { name: "Name this TV" });
    expect(heading).toBeVisible();
    expect(heading.closest(".state-panel")).toHaveAttribute("data-material", "program-stock");
    expect(screen.queryByText("Connect this television")).not.toBeInTheDocument();
    expect(screen.queryByText("Cloudframe", { exact: true })).not.toBeInTheDocument();
    expect(document.querySelector(".eyebrow")).not.toBeInTheDocument();
    expect(screen.getByText("1", { selector: "span" })).toBeVisible();
    expect(screen.getByText("2", { selector: "span" })).toBeVisible();
    expect(screen.getByText("3", { selector: "span" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Request access" })).toBeVisible();
  });

  it("submits a device name then polls pending approval with bounded backoff", async () => {
    vi.useFakeTimers();
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "unenrolled" } });
    vi.mocked(client.createDeviceRequest).mockResolvedValue({
      request: {
        id: "request-1",
        requestedName: "Den TV",
        status: "pending",
        createdAt: "2026-08-26T00:00:00.000Z",
        expiresAt: "2026-08-26T00:30:00.000Z",
        resolvedAt: null,
        approvedDeviceId: null
      }
    });
    vi.mocked(client.requestStatus).mockResolvedValue({ enrollment: { state: "pending", request: {
      id: "request-1", requestedName: "Den TV", status: "pending",
      createdAt: "2026-08-26T00:00:00.000Z", expiresAt: "2026-08-26T00:30:00.000Z",
      resolvedAt: null, approvedDeviceId: null
    } } });
    render(<TvApp api={client} browserSupported />);
    await screen.findByRole("heading", { name: "Name this TV" });
    fireEvent.input(screen.getByLabelText("TV name"), { target: { value: "Den TV" } });
    fireEvent.click(screen.getByRole("button", { name: "Request access" }));
    expect(await screen.findByRole("heading", { name: "Waiting for approval" })).toBeVisible();
    expect(screen.getByText(/Den TV is queued/i)).toBeVisible();
    expect(document.querySelector(".eyebrow")).not.toBeInTheDocument();
    expect(screen.getByText("Request sent securely")).toBeVisible();
    expect(screen.getByText(/keep this screen open/i)).toBeVisible();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
    expect(client.requestStatus).toHaveBeenCalledTimes(1);
  });

  it.each([
    [false, "This TV browser is not supported", "Use a webOS 5 or newer TV."],
    [true, "Device requests are turned off", "Try again"],
  ] as const)("renders safe unsupported and request-disabled screens", async (supported, heading, action) => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "requests-disabled" } });
    render(<TvApp api={client} browserSupported={supported} />);
    expect(await screen.findByRole("heading", { name: heading })).toBeVisible();
    expect(screen.getByText(action)).toBeVisible();
  });

  it.each(["denied", "expired", "revoked"] as const)("shows a safe %s terminal state", async state => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state } });
    render(<TvApp api={client} browserSupported />);
    expect(await screen.findByTestId(`state-${state}`)).toBeVisible();
  });

  it("renders assigned roots and opens the source drawer from Menu", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{
      id: "root-1", sourceId: "source-1", displayName: "Family Photos", provider: "google",
      accountLabel: "Home Drive", nodeId: "folder-1", folderCoverNodeIds: [], childFolderCount: 2, childMediaCount: 8,
      readiness: "ready", readinessMessage: "Ready to screen"
    }] });
    render(<TvApp api={client} browserSupported />);
    expect(await screen.findByRole("heading", { name: "Family Photos" })).toBeVisible();
    fireEvent.keyDown(window, { keyCode: 457 });
    expect(screen.getByRole("dialog", { name: "Sources" })).toBeVisible();
    expect(screen.getByText("Home Drive")).toBeVisible();
  });

  it("keeps provider metadata after the program title instead of using a kicker", async () => {
    const client = readyApiWithRoots();
    render(<TvApp api={client} browserSupported />);
    const title = await screen.findByRole("heading", { name: "Family" });
    const metadata = title.parentElement!.querySelector(".provider-slate")!;
    expect(metadata).toHaveTextContent("Google Drive · Home");
    expect(title.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps the first approved program as initial focus", async () => {
    const client = readyApiWithRoots();
    render(<TvApp api={client} browserSupported />);

    const programs = await screen.findAllByTestId("program-card");
    await waitFor(() => expect(programs[0]).toHaveFocus());
    expect(programs[0]).toHaveAttribute("tabindex", "0");
    expect(programs[1]).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Manage sources" })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: "Manage sources" })).not.toHaveFocus();
  });

  it("shows unavailable or indexing programs without pretending they are empty", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{
      ...rootCards[0]!,
      nodeId: null,
      folderCoverNodeIds: [],
      childFolderCount: 0,
      childMediaCount: 0,
      readiness: "preparing",
      readinessMessage: "Preparing this collection"
    }] });
    render(<TvApp api={client} browserSupported />);

    const program = await screen.findByTestId("program-card");
    expect(screen.getAllByText("Preparing this collection").length).toBeGreaterThan(0);
    expect(screen.queryByText("This folder is empty")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 folders/i)).not.toBeInTheDocument();
    fireEvent.click(program);
    expect(client.folder).not.toHaveBeenCalled();
  });

  it("restores exact grid focus after the source drawer closes", async () => {
    const client = readyApiWithRoots();
    render(<TvApp api={client} browserSupported />);
    const grid = await screen.findByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Trips/ })).toHaveFocus());
    fireEvent.keyDown(window, { keyCode: 457 });
    expect(screen.getByRole("dialog", { name: "Sources" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Trips/ })).toHaveFocus());
  });

  it("restores exact grid focus when Menu closes the source drawer", async () => {
    const client = readyApiWithRoots();
    render(<TvApp api={client} browserSupported />);
    const grid = await screen.findByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Trips/ })).toHaveFocus());
    fireEvent.keyDown(window, { keyCode: 457 });
    await screen.findByRole("dialog", { name: "Sources" });
    fireEvent.keyDown(window, { keyCode: 457 });
    await waitFor(() => expect(screen.getByRole("button", { name: /Trips/ })).toHaveFocus());
  });

  it("loads missing pages once and focuses the same-column destination after append", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, nodeId: "folder-parent" }] });
    vi.mocked(client.folder)
      .mockResolvedValueOnce(folderPage("folder-parent", 0, 10, "page-2"))
      .mockResolvedValueOnce(folderPage("folder-parent", 10, 6, null));
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: /Node 12/ })).toHaveFocus());
  });

  it("refetches every saved page before Back restores a later-page item", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, nodeId: "folder-parent" }] });
    vi.mocked(client.folder)
      .mockResolvedValueOnce(folderPage("folder-parent", 0, 10, "page-2"))
      .mockResolvedValueOnce(folderPage("folder-parent", 10, 6, null))
      .mockResolvedValueOnce(folderPage("node-12", 0, 0, null, "Child"))
      .mockResolvedValueOnce(folderPage("folder-parent", 0, 10, "page-2"))
      .mockResolvedValueOnce(folderPage("folder-parent", 10, 6, null));
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await screen.findByRole("button", { name: /Node 12/ });
    fireEvent.click(screen.getByRole("button", { name: /Node 12/ }));
    await screen.findByRole("heading", { name: "Child" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(5));
    await waitFor(() => expect(screen.getByRole("button", { name: /Node 12/ })).toHaveFocus());
  });

  it("replays more than twenty saved pages before exact Back restoration", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, nodeId: "folder-parent" }] });
    for (let page = 0; page < 22; page += 1) {
      vi.mocked(client.folder).mockResolvedValueOnce(folderPage("folder-parent", page, 1, page < 21 ? `page-${page + 1}` : null, "Parent"));
    }
    vi.mocked(client.folder).mockResolvedValueOnce(folderPage("node-21", 0, 0, null, "Child"));
    for (let page = 0; page < 22; page += 1) {
      vi.mocked(client.folder).mockResolvedValueOnce(folderPage("folder-parent", page, 1, page < 21 ? `page-${page + 1}` : null, "Parent"));
    }
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    await screen.findByRole("grid", { name: "Parent" });
    for (let page = 1; page < 22; page += 1) {
      fireEvent.keyDown(screen.getByRole("grid", { name: "Parent" }), { key: "ArrowDown" });
      await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(page + 1));
    }
    fireEvent.click(await screen.findByRole("button", { name: /Node 21/ }));
    await screen.findByRole("heading", { name: "Child" });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(45));
    await waitFor(() => expect(screen.getByRole("button", { name: /Node 21/ })).toHaveFocus());
  });

  it("shows no-roots, empty-folder and offline retry states", async () => {
    const noRoots = api();
    vi.mocked(noRoots.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(noRoots.home).mockResolvedValue({ roots: [] });
    const first = render(<TvApp api={noRoots} browserSupported />);
    expect(await screen.findByRole("heading", { name: "No folders assigned" })).toBeVisible();
    first.unmount();

    const offline = api();
    vi.mocked(offline.bootstrap).mockRejectedValue(new TypeError("Failed to fetch"));
    render(<TvApp api={offline} browserSupported />);
    expect(await screen.findByRole("heading", { name: "Cloudframe is offline" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(offline.bootstrap).toHaveBeenCalledTimes(2));
  });

  it("opens media in the loaded-folder viewer and restores the exact grid item after Back", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, nodeId: "folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("folder-parent", "folder", "Parent"), breadcrumbs: [],
      children: [node("image-1", "image", "First"), node("folder-2", "folder", "Nested"), node("image-2", "image", "Second")],
      nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
    vi.mocked(client.mediaUrl).mockImplementation(async nodeId => ({ url: `https://provider.example/${nodeId}`, expiresAt: "2026-08-26T01:00:00.000Z", revision: "r1" }));
    vi.mocked(client.history).mockResolvedValue({ history: [] });
    vi.mocked(client.saveHistory).mockImplementation(async (nodeId, value) => ({ history: { nodeId, ...value, updatedAt: "2026-08-26T00:00:00.000Z" } }));
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Second/ })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: /Second/ }));
    expect(await screen.findByRole("img", { name: "Second" })).toBeVisible();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Second/ })).toHaveFocus());
  });

  it("shows persisted video resume progress and refreshes it after the viewer closes", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, nodeId: "folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("folder-parent", "folder", "Parent"), breadcrumbs: [],
      children: [videoNode("video-1", "Lake")], nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
    vi.mocked(client.mediaUrl).mockResolvedValue({ url: "https://provider.example/video-1", expiresAt: "2026-08-26T01:00:00.000Z", revision: "r1" });
    vi.mocked(client.history)
      .mockResolvedValueOnce({ history: [{ nodeId: "video-1", positionSeconds: 30, durationSeconds: 120, completed: false, updatedAt: "2026-08-26T00:00:00.000Z" }] })
      .mockResolvedValue({ history: [{ nodeId: "video-1", positionSeconds: 60, durationSeconds: 120, completed: false, updatedAt: "2026-08-26T00:05:00.000Z" }] });
    vi.mocked(client.saveHistory).mockImplementation(async (nodeId, value) => ({ history: { nodeId, ...value, updatedAt: "2026-08-26T00:05:00.000Z" } }));

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    expect(await screen.findByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(screen.getByRole("button", { name: /Lake/ }));
    await screen.findByLabelText("Playing Lake");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuenow", "50");
    expect(vi.mocked(client.history).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves Back unhandled at the virtual root", async () => {
    const client = readyApiWithRoots();
    render(<TvApp api={client} browserSupported />);
    const grid = await screen.findByRole("grid");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    grid.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("rebootstraps the session once when the viewer reports device revocation", async () => {
    const client = api();
    vi.mocked(client.bootstrap)
      .mockResolvedValueOnce({ enrollment: { state: "ready", device: readyDevice, household } })
      .mockResolvedValueOnce({ enrollment: { state: "revoked" } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, nodeId: "folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("folder-parent", "folder", "Parent"), breadcrumbs: [],
      children: [node("image-1", "image", "First")], nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
    vi.mocked(client.history).mockResolvedValue({ history: [] });
    vi.mocked(client.mediaUrl).mockRejectedValue(Object.assign(new Error("revoked"), { code: "DEVICE_UNAUTHORIZED" }));
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    expect(await screen.findByTestId("state-revoked")).toBeVisible();
    expect(client.bootstrap).toHaveBeenCalledTimes(2);
  });
});

const readyDevice = {
  id: "device-1", name: "Living room", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null,
  slideshowSeconds: null, createdAt: "2026-08-26T00:00:00.000Z", approvedAt: "2026-08-26T00:00:00.000Z",
  lastSeenAt: "2026-08-26T00:00:00.000Z", revokedAt: null
};

const household = {
  id: "household-primary", createdAt: "2026-08-26T00:00:00.000Z", allowNewDeviceRequests: true,
  defaultMediaOrder: "captured-desc" as const, defaultSlideshowSeconds: 8
};

const rootCards = [
  { id: "root-1", sourceId: "source-1", displayName: "Family", provider: "google" as const, accountLabel: "Home", nodeId: "folder-1", folderCoverNodeIds: [], childFolderCount: 2, childMediaCount: 8, readiness: "ready" as const, readinessMessage: "Ready to screen" },
  { id: "root-2", sourceId: "source-2", displayName: "Trips", provider: "onedrive" as const, accountLabel: "Cloud", nodeId: "folder-2", folderCoverNodeIds: [], childFolderCount: 1, childMediaCount: 5, readiness: "ready" as const, readinessMessage: "Ready to screen" }
];

function readyApiWithRoots() {
  const client = api();
  vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
  vi.mocked(client.home).mockResolvedValue({ roots: rootCards });
  vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
  return client;
}

function folderPage(parentId: string, start: number, count: number, nextCursor: string | null, parentName = "Parent") {
  return {
    parent: node(parentId, "folder", parentName), breadcrumbs: [],
    children: Array.from({ length: count }, (_, offset) => node(`node-${start + offset}`, start + offset === 12 || start + offset === 21 ? "folder" : "image", `Node ${start + offset}`)),
    nextCursor
  };
}

function node(id: string, kind: "folder" | "image", name: string) {
  return { id, sourceId: "source-1", provider: "google" as const, parentNodeId: null, name, normalizedName: name.toLowerCase(), kind, mimeType: kind === "image" ? "image/jpeg" : null, size: null, width: null, height: null, capturedAt: null, createdAtProvider: null, modifiedAtProvider: null, thumbnailRevision: null, hasPreview: false, folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: 0, available: true };
}

function videoNode(id: string, name: string) {
  return { ...node(id, "image", name), kind: "video" as const, mimeType: "video/mp4" };
}
