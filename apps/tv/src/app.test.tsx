// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TvApp } from "./app";
import { tvApi, type TvApi } from "./api/client";

const api = (): TvApi => ({
  bootstrap: vi.fn(),
  createDeviceRequest: vi.fn(),
  requestStatus: vi.fn(),
  home: vi.fn(),
  folder: vi.fn(),
  thumbnailUrls: vi.fn(async () => ({ items: [] })),
  mediaUrl: vi.fn()
});

describe("TV enrollment and browse states", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      id: "root-1", handle: "sealed-folder-1", displayName: "Family Photos", provider: "google",
      accountLabel: "Home Drive"
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

  it("shows neutral root metadata without readiness, index, count, or mosaic copy", async () => {
    const client = readyApiWithRoots();
    render(<TvApp api={client} browserSupported />);
    await screen.findAllByTestId("program-card");
    expect(screen.getAllByText("Google Drive · Home")).toHaveLength(2);
    expect(screen.queryByText(/ready to screen|preparing this collection|indexing|\d+ folders|\d+ media/i)).not.toBeInTheDocument();
    expect(document.querySelector(".folder-mosaic")).not.toBeInTheDocument();
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

  it("returns from a drawer-selected collection to the local household program", async () => {
    const client = readyApiWithRoots();
    vi.mocked(client.folder).mockResolvedValue(folderPage("root-2", 0, 0, null, "Trips collection"));
    render(<TvApp api={client} browserSupported />);
    await screen.findByRole("grid");
    fireEvent.keyDown(window, { keyCode: 457 });
    const trips = screen.getAllByRole("button", { name: /Trips/ });
    fireEvent.click(trips[trips.length - 1]!);
    await screen.findByRole("heading", { name: "Trips collection" });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByRole("heading", { name: "Trips" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: /Trips/ })).toHaveFocus());
    expect(client.home).toHaveBeenCalledTimes(1);
  });

  it("loads missing pages once and focuses the same-column destination after append", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder)
      .mockResolvedValueOnce(folderPage("root-1", 0, 10, "page-2"))
      .mockResolvedValueOnce(folderPage("root-1", 10, 6, null));
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

  it("restores accumulated pages and focus from the local stack without refetching ancestry", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder)
      .mockResolvedValueOnce(folderPage("root-1", 0, 10, "page-2"))
      .mockResolvedValueOnce(folderPage("root-1", 10, 6, null))
      .mockResolvedValueOnce(folderPage("node-12", 0, 0, null, "Child"));
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
    await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("button", { name: /Node 12/ })).toHaveFocus());
  });

  it("deduplicates appended public IDs and re-sorts the accumulated folder entries", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: { ...readyDevice, mediaOrder: "name-asc" }, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder)
      .mockResolvedValueOnce({
        parent: node("root-1", "folder", "Parent"),
        children: [node("item_z", "image", "Zulu"), node("item_b", "image", "Bravo")],
        nextCursor: "page-2"
      })
      .mockResolvedValueOnce({
        parent: node("root-1", "folder", "Parent"),
        children: [node("item_b", "image", "Bravo duplicate"), node("item_a", "image", "Alpha")],
        nextCursor: null
      });
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(2));
    const cards = screen.getAllByRole("button", { name: /image/ });
    expect(cards.map(card => card.getAttribute("aria-label"))).toEqual(["Alpha, image", "Bravo duplicate, image", "Zulu, image"]);
  });

  it("stops pagination when the provider repeats the current sealed cursor", async () => {
    const client = pagedClient(
      folderPage("root-1", 0, 10, "cursor-a"),
      folderPage("root-1", 10, 3, "cursor-a")
    );
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    await requestNextPage(grid, client, 2);
    expect(screen.getByRole("button", { name: /Node 12/ })).toHaveFocus();

    fireEvent.keyDown(grid, { key: "ArrowDown" });

    expect(client.folder).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("More items could not be loaded. Refresh this collection to try again.");
  });

  it("stops an A to B to A cursor cycle without another provider request", async () => {
    const client = pagedClient(
      folderPage("root-1", 0, 10, "cursor-a"),
      folderPage("root-1", 10, 10, "cursor-b"),
      folderPage("root-1", 20, 10, "cursor-a")
    );
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    await requestNextPage(grid, client, 2);
    await requestNextPage(grid, client, 3);

    fireEvent.keyDown(grid, { key: "ArrowDown" });

    expect(client.folder).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("status")).toHaveTextContent("More items could not be loaded.");
  });

  it("terminates a duplicate-only page while adopting renewed DTOs and preserving focus", async () => {
    const first = folderPage("root-1", 0, 10, "cursor-a");
    const renewed = first.children.map((item, index) => ({ ...item, handle: `renewed-${item.id}`, name: index === 9 ? "Renewed Node 9" : item.name }));
    const client = pagedClient(first, { parent: first.parent, children: renewed, nextCursor: "cursor-b" });
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    const grid = await screen.findByRole("grid", { name: "Parent" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("button", { name: /Node 9/ })).toHaveFocus());

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(2));

    expect(screen.getByRole("button", { name: /Renewed Node 9/ })).toHaveFocus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(client.folder).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("No additional items were returned. Refresh this collection to check again.");
  });

  it("refreshes home and clears local navigation when a folder handle expires", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home)
      .mockResolvedValueOnce({ roots: rootCards })
      .mockResolvedValueOnce({ roots: [{ ...rootCards[1]!, displayName: "Fresh Trips" }] });
    vi.mocked(client.folder).mockRejectedValue(Object.assign(new Error("Navigation has expired."), { code: "NAVIGATION_EXPIRED" }));

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));

    expect(await screen.findByRole("heading", { name: "Fresh Trips" })).toBeVisible();
    expect(client.home).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("NAVIGATION_EXPIRED")).not.toBeInTheDocument();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    screen.getByRole("grid").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("maps thumbnail results by public item ID and ignores unrelated responses", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [browseItem("item_photo", "sealed-photo", "Photo", "image")],
      nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [
      { itemId: "item_other", status: "ready", url: "https://provider.example/wrong", expiresAt: futureIso(), revision: null },
      { itemId: "item_photo", status: "ready", url: "https://provider.example/photo", expiresAt: futureIso(), revision: null }
    ] });

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    await waitFor(() => expect(document.querySelector(".media-preview img")).toBeInTheDocument());
    const image = document.querySelector<HTMLImageElement>(".media-preview img")!;
    expect(image.src).toBe("https://provider.example/photo");
    expect(client.thumbnailUrls).toHaveBeenCalledWith(["sealed-photo"], expect.any(AbortSignal));
    expect(document.body.innerHTML).not.toContain("https://provider.example/wrong");
  });

  it("refreshes home and removes stale cards when thumbnail vending reports item not found", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home)
      .mockResolvedValueOnce({ roots: [rootCards[0]!] })
      .mockResolvedValueOnce({ roots: [rootCards[1]!] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [browseItem("item_photo", "sealed-photo", "Stale photo", "image")],
      nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockRejectedValue(Object.assign(new Error("gone"), { code: "ITEM_NOT_FOUND" }));

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));

    expect(await screen.findByRole("heading", { name: "Trips" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Stale photo/ })).not.toBeInTheDocument();
    expect(client.home).toHaveBeenCalledTimes(2);
  });

  it("removes an expired thumbnail and re-vends it while the item remains visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [browseItem("item_photo", "sealed-photo", "Photo", "image")],
      nextCursor: null
    });
    vi.mocked(client.thumbnailUrls)
      .mockResolvedValueOnce({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/old", expiresAt: new Date(Date.now() + 1_000).toISOString(), revision: null }] })
      .mockResolvedValueOnce({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/fresh", expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: null }] });

    render(<TvApp api={client} browserSupported />);
    const family = await findButtonWithFakeTimers(/Family/);
    fireEvent.click(family);
    await flushFakeTimersUntil(() => document.querySelector(".media-preview img") !== null);
    expect(document.querySelector<HTMLImageElement>(".media-preview img")?.src).toBe("https://provider.example/old");

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });

    await waitFor(() => expect(document.querySelector<HTMLImageElement>(".media-preview img")?.src).toBe("https://provider.example/fresh"));
    expect(client.thumbnailUrls).toHaveBeenCalledTimes(2);
  });

  it("does not repeatedly vend a visible thumbnail reported unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [browseItem("item_photo", "sealed-photo", "Photo", "image")],
      nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [{ itemId: "item_photo", status: "unavailable" }] });

    render(<TvApp api={client} browserSupported />);
    const family = await findButtonWithFakeTimers(/Family/);
    fireEvent.click(family);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(60_000); });

    expect(client.thumbnailUrls).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".media-preview img")).not.toBeInTheDocument();
  });

  it("replaces a renewed thumbnail timer when the new entry expires sooner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    const parent = node("root-1", "folder", "Parent");
    const initialChildren = Array.from({ length: 10 }, (_, index) => browseItem(index === 9 ? "item_photo" : `item_${index}`, index === 9 ? "sealed-photo-old" : `sealed-${index}`, index === 9 ? "Photo" : `Item ${index}`, "image"));
    vi.mocked(client.folder)
      .mockResolvedValueOnce({ parent, children: initialChildren, nextCursor: "cursor-a" })
      .mockResolvedValueOnce({ parent, children: [browseItem("item_photo", "sealed-photo-new", "Photo renewed", "image"), browseItem("item_new", "sealed-new", "New", "image")], nextCursor: null });
    vi.mocked(client.thumbnailUrls)
      .mockResolvedValueOnce({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/old", expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: null }] })
      .mockResolvedValueOnce({ items: [
        { itemId: "item_photo", status: "ready", url: "https://provider.example/renewed", expiresAt: new Date(Date.now() + 1_000).toISOString(), revision: null },
        { itemId: "item_new", status: "unavailable" }
      ] })
      .mockResolvedValueOnce({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/fresh", expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: null }] });

    render(<TvApp api={client} browserSupported />);
    const family = await findButtonWithFakeTimers(/Family/);
    fireEvent.click(family);
    await flushFakeTimersUntil(() => document.querySelector<HTMLImageElement>(".media-preview img")?.src === "https://provider.example/old");
    const grid = screen.getByRole("grid", { name: "Parent" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await flushFakeTimersUntil(() => vi.mocked(client.folder).mock.calls.length === 2);
    await flushFakeTimersUntil(() => screen.queryByRole("button", { name: /Photo renewed/ }) !== null);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); await Promise.resolve(); });

    await flushFakeTimersUntil(() => document.querySelector<HTMLImageElement>(".media-preview img")?.src === "https://provider.example/fresh");
    expect(client.thumbnailUrls).toHaveBeenCalledTimes(3);
  });

  it("re-requests when a decoded thumbnail expires before installation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({ parent: node("root-1", "folder", "Parent"), children: [browseItem("item_photo", "sealed-photo", "Photo", "image")], nextCursor: null });
    vi.mocked(client.thumbnailUrls)
      .mockImplementationOnce(async (_handles, signal) => {
        const expiresAt = new Date(Date.now() + 1).toISOString();
        return new Promise(resolve => window.setTimeout(() => {
          if (signal?.aborted) return;
          resolve({ items: [{ itemId: "item_photo", status: "ready" as const, url: "https://provider.example/raced", expiresAt, revision: null }] });
        }, 2));
      })
      .mockResolvedValueOnce({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/fresh", expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: null }] });

    render(<TvApp api={client} browserSupported />);
    const family = await findButtonWithFakeTimers(/Family/);
    fireEvent.click(family);
    await flushFakeTimersUntil(() => vi.mocked(client.thumbnailUrls).mock.calls.length === 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30); await Promise.resolve(); await Promise.resolve(); });

    await flushFakeTimersUntil(() => document.querySelector<HTMLImageElement>(".media-preview img")?.src === "https://provider.example/fresh");
    expect(client.thumbnailUrls).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain("https://provider.example/raced");
  });

  it("re-requests a thumbnail that becomes due between state acceptance and timer installation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({ parent: node("root-1", "folder", "Parent"), children: [browseItem("item_photo", "sealed-photo", "Photo", "image")], nextCursor: null });
    type ThumbnailResponse = Awaited<ReturnType<TvApi["thumbnailUrls"]>>;
    let resolveInitial!: (value: ThumbnailResponse) => void;
    vi.mocked(client.thumbnailUrls)
      .mockReturnValueOnce(new Promise<ThumbnailResponse>(resolve => { resolveInitial = resolve; }))
      .mockResolvedValueOnce({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/fresh", expiresAt: new Date(Date.now() + 60_000).toISOString(), revision: null }] });

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await findButtonWithFakeTimers(/Family/));
    await flushFakeTimersUntil(() => vi.mocked(client.thumbnailUrls).mock.calls.length === 1);
    const acceptedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(acceptedAt).mockReturnValue(acceptedAt + 2);
    await act(async () => {
      resolveInitial({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/raced", expiresAt: new Date(acceptedAt + 1).toISOString(), revision: null }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    now.mockRestore();

    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); });

    await flushFakeTimersUntil(() => document.querySelector<HTMLImageElement>(".media-preview img")?.src === "https://provider.example/fresh");
    expect(client.thumbnailUrls).toHaveBeenCalledTimes(2);
    expect(document.body.innerHTML).not.toContain("https://provider.example/raced");
  });

  it("cancels an already-due thumbnail re-request when the app unmounts before the zero-delay tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00.000Z"));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({ parent: node("root-1", "folder", "Parent"), children: [browseItem("item_photo", "sealed-photo", "Photo", "image")], nextCursor: null });
    type ThumbnailResponse = Awaited<ReturnType<TvApi["thumbnailUrls"]>>;
    let resolveInitial!: (value: ThumbnailResponse) => void;
    vi.mocked(client.thumbnailUrls).mockReturnValueOnce(new Promise<ThumbnailResponse>(resolve => { resolveInitial = resolve; }));

    const view = render(<TvApp api={client} browserSupported />);
    fireEvent.click(await findButtonWithFakeTimers(/Family/));
    await flushFakeTimersUntil(() => vi.mocked(client.thumbnailUrls).mock.calls.length === 1);
    const acceptedAt = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(acceptedAt).mockReturnValue(acceptedAt + 2);
    await act(async () => {
      resolveInitial({ items: [{ itemId: "item_photo", status: "ready", url: "https://provider.example/raced", expiresAt: new Date(acceptedAt + 1).toISOString(), revision: null }] });
      await Promise.resolve();
      await Promise.resolve();
    });
    now.mockRestore();

    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve(); });

    expect(client.thumbnailUrls).toHaveBeenCalledTimes(1);
  });

  it("deduplicates initial roots and children with the final DTO winning", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    const duplicateRoot = browseItem("item_duplicate_root", "sealed-root-old", "Family", "folder");
    vi.mocked(client.home).mockResolvedValue({ roots: [
      { id: duplicateRoot.id, handle: duplicateRoot.handle, displayName: "Family", provider: "google", accountLabel: "Home" },
      { id: duplicateRoot.id, handle: "sealed-root-new", displayName: "Family renewed", provider: "google", accountLabel: "Home" }
    ] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: { ...duplicateRoot, handle: "sealed-root-new", name: "Parent", normalizedName: "parent" },
      children: [
        browseItem("item_duplicate", "sealed-old", "Old image", "image"),
        browseItem("item_duplicate", "sealed-new", "Renewed video", "video")
      ],
      nextCursor: null
    });
    vi.mocked(client.mediaUrl).mockImplementation(async handle => ({
      itemId: "item_duplicate", kind: "video", url: `https://provider.example/${handle}`,
      expiresAt: futureIso(), revision: null
    }));

    render(<TvApp api={client} browserSupported />);
    const roots = await screen.findAllByTestId("program-card");
    expect(roots).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Family renewed/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Family renewed/ }));
    expect(await screen.findAllByRole("button", { name: /Renewed video/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Renewed video/ }));
    await screen.findByLabelText("Playing Renewed video");
    expect(client.folder).toHaveBeenCalledWith("sealed-root-new", undefined);
    expect(client.mediaUrl).toHaveBeenCalledWith("sealed-new", expect.any(AbortSignal), { itemId: "item_duplicate", kind: "video" });
  });

  it("refreshes navigation when a folder response parent does not match the requested item", async () => {
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home)
      .mockResolvedValueOnce({ roots: [rootCards[0]!] })
      .mockResolvedValueOnce({ roots: [rootCards[1]!] });
    vi.mocked(client.folder).mockResolvedValue({ parent: node("item_wrong", "folder", "Wrong"), children: [], nextCursor: null });
    render(<TvApp api={client} browserSupported />);

    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));

    expect(await screen.findByRole("heading", { name: "Trips" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Wrong" })).not.toBeInTheDocument();
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
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [node("image-1", "image", "First"), node("folder-2", "folder", "Nested"), node("image-2", "image", "Second")],
      nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
    vi.mocked(client.mediaUrl).mockImplementation(async handle => mediaResponse(handle));
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

  it("uses the ready device's local history and refreshes progress synchronously after viewer close", async () => {
    window.localStorage.setItem("cloudframe.tv.watch-history.v1:device-1", JSON.stringify({
      version: 1,
      entries: {
        item_video_1: { positionSeconds: 30, durationSeconds: 120, completed: false, updatedAt: "2026-08-26T00:00:00.000Z" }
      }
    }));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [videoNode("item_video_1", "Lake")], nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
    vi.mocked(client.mediaUrl).mockResolvedValue({ itemId: "item_video_1", kind: "video", url: "https://provider.example/item_video_1", expiresAt: futureIso(), revision: "r1" });

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    expect(await screen.findByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuenow", "25");
    fireEvent.click(screen.getByRole("button", { name: /Lake/ }));
    const video = await screen.findByLabelText("Playing Lake") as HTMLVideoElement;
    Object.defineProperty(video, "duration", { configurable: true, value: 120 });
    Object.defineProperty(video, "currentTime", { configurable: true, writable: true, value: 60 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuenow", "50");
    expect(window.localStorage.getItem("cloudframe.tv.watch-history.v1:device-1")).toContain('"positionSeconds":60');
  });

  it("does not reuse another ready device's local history after the session changes", async () => {
    window.localStorage.setItem("cloudframe.tv.watch-history.v1:device-1", JSON.stringify({
      version: 1,
      entries: { item_video_1: { positionSeconds: 90, durationSeconds: 120, completed: false, updatedAt: "2026-08-26T00:00:00.000Z" } }
    }));
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: { ...readyDevice, id: "device-2" }, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [videoNode("item_video_1", "Lake")], nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });

    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    expect(screen.queryByRole("progressbar", { name: "Watched" })).not.toBeInTheDocument();
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
    vi.mocked(client.home).mockResolvedValue({ roots: [{ ...rootCards[0]!, handle: "sealed-folder-parent" }] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [node("image-1", "image", "First")], nextCursor: null
    });
    vi.mocked(client.thumbnailUrls).mockResolvedValue({ items: [] });
    vi.mocked(client.mediaUrl).mockRejectedValue(Object.assign(new Error("revoked"), { code: "DEVICE_UNAUTHORIZED" }));
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    fireEvent.click(await screen.findByRole("button", { name: /First/ }));
    expect(await screen.findByTestId("state-revoked")).toBeVisible();
    expect(client.bootstrap).toHaveBeenCalledTimes(2);
  });
});

describe("TV API live browse contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends only sealed handles and sealed cursors to TV browse and media routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse({
        parent: browseItem("item_folder", "sealed-parent", "Folder", "folder"),
        children: [],
        nextCursor: null
      }))
      .mockResolvedValueOnce(apiResponse({ items: [] }))
      .mockResolvedValueOnce(apiResponse({
        itemId: "item_video",
        kind: "video",
        url: "https://provider.example/video",
        expiresAt: futureIso(),
        revision: "r1"
      }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await tvApi.folder("sealed/folder", "sealed cursor");
    await tvApi.thumbnailUrls(["sealed-image"], controller.signal);
    await tvApi.mediaUrl("sealed-video", controller.signal);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/tv/folders/sealed%2Ffolder?cursor=sealed%20cursor", expect.objectContaining({ credentials: "include" }));
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string)).toEqual({ handles: ["sealed-image"], maxDimension: 720 });
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string)).toEqual({ handle: "sealed-video" });
  });

  it("accepts a same-origin Google media path without exposing a provider token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse({
      itemId: "item_video",
      kind: "video",
      url: "/api/tv/google-media/sealed-google-handle",
      expiresAt: futureIso(),
      revision: null
    })));

    await expect(tvApi.mediaUrl("sealed-google-handle")).resolves.toMatchObject({
      url: "/api/tv/google-media/sealed-google-handle"
    });
  });

  it("preserves bounded raw server error codes while replacing internal messages", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "NAVIGATION_EXPIRED",
      message: "secret internal navigation detail",
      retryAfterSeconds: 5
    }), { status: 404, headers: { "content-type": "application/json" } })));

    await expect(tvApi.folder("sealed-folder")).rejects.toMatchObject({
      status: 404,
      code: "NAVIGATION_EXPIRED",
      message: "This collection needs to be refreshed.",
      retryAfterSeconds: 5
    });
  });

  it.each([
    ["home extra field", () => tvApi.home(), { roots: [{ ...rootCards[0], providerNodeId: "raw-provider" }] }],
    ["home bad item ID", () => tvApi.home(), { roots: [{ ...rootCards[0], id: "root-private" }] }],
    ["home empty handle", () => tvApi.home(), { roots: [{ ...rootCards[0], handle: "" }] }],
    ["folder bad parent kind", () => tvApi.folder("sealed-folder"), { parent: browseItem("item_parent", "sealed-parent", "Parent", "image"), children: [], nextCursor: null }],
    ["folder non-array children", () => tvApi.folder("sealed-folder"), { parent: browseItem("item_parent", "sealed-parent", "Parent", "folder"), children: {}, nextCursor: null }],
    ["folder child kind and MIME mismatch", () => tvApi.folder("sealed-folder"), { parent: browseItem("item_parent", "sealed-parent", "Parent", "folder"), children: [{ ...browseItem("item_image", "sealed-image", "Image", "image"), mimeType: "video/mp4" }], nextCursor: null }],
    ["folder bad cursor", () => tvApi.folder("sealed-folder"), { parent: browseItem("item_parent", "sealed-parent", "Parent", "folder"), children: [], nextCursor: "" }],
    ["thumbnail bad item ID", () => tvApi.thumbnailUrls(["sealed-image"]), { items: [{ itemId: "raw-provider", status: "unavailable" }] }],
    ["thumbnail unavailable smuggles URL", () => tvApi.thumbnailUrls(["sealed-image"]), { items: [{ itemId: "item_image", status: "unavailable", url: "https://provider.example/image", expiresAt: futureIso() }] }],
    ["thumbnail expired URL", () => tvApi.thumbnailUrls(["sealed-image"]), { items: [{ itemId: "item_image", status: "ready", url: "https://provider.example/image", expiresAt: "2020-01-01T00:00:00.000Z", revision: null }] }],
    ["media bad URL", () => tvApi.mediaUrl("sealed-image"), { itemId: "item_image", kind: "image", url: "http://provider.example/image", expiresAt: futureIso(), revision: null }],
    ["media expired URL", () => tvApi.mediaUrl("sealed-image"), { itemId: "item_image", kind: "image", url: "https://provider.example/image", expiresAt: "2020-01-01T00:00:00.000Z", revision: null }],
    ["media extra provider field", () => tvApi.mediaUrl("sealed-image"), { itemId: "item_image", kind: "image", url: "https://provider.example/image", expiresAt: futureIso(), revision: null, providerNodeId: "raw-provider" }]
  ])("rejects malformed successful %s responses", async (_name, call, data) => {
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse(data)));
    await expect(call()).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "The server returned an unexpected response." });
  });

  it("rejects malformed bootstrap and create-request success payloads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(apiResponse({ enrollment: { state: "ready", device: { ...readyDevice, providerNodeId: "raw" }, household } }))
      .mockResolvedValueOnce(apiResponse({ request: { id: "request-1", requestedName: "TV", status: "pending" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(tvApi.bootstrap()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(tvApi.createDeviceRequest("TV")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects media item ID and kind mismatches against the requested DTO context", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse({ itemId: "item_other", kind: "video", url: "https://provider.example/video", expiresAt: futureIso(), revision: null })));
    await expect(tvApi.mediaUrl("sealed-image", undefined, { itemId: "item_image", kind: "image" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it.each([
    ["extra success-envelope field", () => tvApi.home(), () => ({ ok: true, data: { roots: [] }, extra: true })],
    ["custom success-envelope prototype", () => tvApi.bootstrap(), () => Object.assign(Object.create({ inherited: true }), { ok: true, data: { enrollment: { state: "unenrolled" } } })],
    ["success-envelope getter", () => tvApi.folder("sealed-folder"), () => Object.defineProperty({ ok: true }, "data", { enumerable: true, get() { throw new Error("getter secret"); } })],
    ["success-envelope symbol", () => tvApi.home(), () => Object.assign({ ok: true, data: { roots: [] } }, { [Symbol("secret")]: true })],
    ["success-envelope non-enumerable extra", () => tvApi.home(), () => Object.defineProperty({ ok: true, data: { roots: [] } }, "secret", { value: true })],
    ["proxy ownKeys failure", () => tvApi.mediaUrl("sealed-image"), () => new Proxy({ ok: true, data: {} }, { ownKeys() { throw new Error("proxy secret"); } })]
  ])("rejects %s as fixed invalid response", async (_name, call, payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => apiValueResponse(payload())));
    await expect(call()).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "The server returned an unexpected response." });
  });

  it.each([
    ["custom root prototype", Object.assign(Object.create({ inherited: true }), rootCards[0])],
    ["folder child accessor", Object.defineProperty({ ...browseItem("item_image", "sealed-image", "Image", "image") }, "name", { enumerable: true, get() { throw new Error("name secret"); } })],
    ["media symbol field", Object.assign({ itemId: "item_image", kind: "image", url: "https://provider.example/image", expiresAt: futureIso(), revision: null }, { [Symbol("secret")]: true })]
  ])("rejects nested plain-data violation: %s", async (name, value) => {
    const data = name === "custom root prototype"
      ? { roots: [value] }
      : name === "folder child accessor"
        ? { parent: browseItem("item_parent", "sealed-parent", "Parent", "folder"), children: [value], nextCursor: null }
        : value;
    vi.stubGlobal("fetch", vi.fn(async () => apiValueResponse({ ok: true, data })));
    const call = name === "custom root prototype" ? tvApi.home() : name === "folder child accessor" ? tvApi.folder("sealed-folder") : tvApi.mediaUrl("sealed-image");
    await expect(call).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("accepts 121 and 1024 code-unit live provider names without mutating them", async () => {
    const name121 = ` ${"A".repeat(119)} `;
    const name1024 = "B".repeat(1024);
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse({
      parent: browseItem("item_parent", "sealed-parent", "Parent", "folder"),
      children: [
        { ...browseItem("item_121", "sealed-121", name121, "image"), normalizedName: "a".repeat(121) },
        { ...browseItem("item_1024", "sealed-1024", name1024, "image"), normalizedName: "b".repeat(2048) }
      ],
      nextCursor: null
    })));

    const page = await tvApi.folder("sealed-folder");
    expect(page.children.map(item => item.name)).toEqual([name121, name1024]);
  });

  it.each([
    ["1025 code units", "C".repeat(1025)],
    ["C0 control", "bad\u0007name"]
  ])("rejects live provider names containing %s", async (_name, filename) => {
    vi.stubGlobal("fetch", vi.fn(async () => apiResponse({
      parent: browseItem("item_parent", "sealed-parent", "Parent", "folder"),
      children: [{ ...browseItem("item_bad", "sealed-bad", filename, "image"), normalizedName: "bad" }],
      nextCursor: null
    })));
    await expect(tvApi.folder("sealed-folder")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("renders a 121-character live provider filename without truncating its accessible name", async () => {
    const filename = "P".repeat(121);
    const client = api();
    vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
    vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
    vi.mocked(client.folder).mockResolvedValue({
      parent: node("root-1", "folder", "Parent"),
      children: [{ ...browseItem("item_long", "sealed-long", filename, "image"), normalizedName: filename.toLowerCase() }],
      nextCursor: null
    });
    render(<TvApp api={client} browserSupported />);
    fireEvent.click(await screen.findByRole("button", { name: /Family/ }));
    expect(await screen.findByRole("button", { name: `${filename}, image` })).toBeVisible();
  });
});

const readyDevice = {
  id: "device-1", name: "Living room", enabled: true, assignedRootIds: ["root-1"], mediaOrder: null,
  slideshowSeconds: null, createdAt: "2026-08-26T00:00:00.000Z", approvedAt: "2026-08-26T00:00:00.000Z",
  revokedAt: null
};

const household = {
  allowNewDeviceRequests: true,
  defaultMediaOrder: "captured-desc" as const, defaultSlideshowSeconds: 8
};

const rootCards = [
  { id: "root-1", handle: "sealed-folder-1", displayName: "Family", provider: "google" as const, accountLabel: "Home" },
  { id: "root-2", handle: "sealed-folder-2", displayName: "Trips", provider: "onedrive" as const, accountLabel: "Cloud" }
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
    parent: node(parentId, "folder", parentName),
    children: Array.from({ length: count }, (_, offset) => node(`node-${start + offset}`, start + offset === 12 || start + offset === 21 ? "folder" : "image", `Node ${start + offset}`)),
    nextCursor
  };
}

function node(id: string, kind: "folder" | "image", name: string) {
  return browseItem(id, `sealed-${id}`, name, kind);
}

function videoNode(id: string, name: string) {
  return { ...node(id, "image", name), kind: "video" as const, mimeType: "video/mp4" };
}

function pagedClient(...pages: ReturnType<typeof folderPage>[]) {
  const client = api();
  vi.mocked(client.bootstrap).mockResolvedValue({ enrollment: { state: "ready", device: readyDevice, household } });
  vi.mocked(client.home).mockResolvedValue({ roots: [rootCards[0]!] });
  pages.forEach(page => vi.mocked(client.folder).mockResolvedValueOnce(page));
  return client;
}

async function requestNextPage(grid: HTMLElement, client: TvApi, expectedCalls: number) {
  for (let step = 0; step < 8 && vi.mocked(client.folder).mock.calls.length < expectedCalls; step += 1) {
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await act(async () => { await Promise.resolve(); });
  }
  await waitFor(() => expect(client.folder).toHaveBeenCalledTimes(expectedCalls));
}

function browseItem(id: string, handle: string, name: string, kind: "folder" | "image" | "video") {
  return {
    id, handle, name, normalizedName: name.toLowerCase(), kind,
    mimeType: kind === "folder" ? null : kind === "video" ? "video/mp4" : "image/jpeg",
    size: null, width: null, height: null, capturedAt: null, createdAtProvider: null,
    modifiedAtProvider: null, thumbnailRevision: null, hasPreview: kind !== "folder"
  };
}

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function apiValueResponse(value: unknown) {
  const response = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "json", { value: async () => value });
  return response;
}

function futureIso() {
  return new Date(Date.now() + 60_000).toISOString();
}

async function findButtonWithFakeTimers(name: RegExp): Promise<HTMLButtonElement> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const button = screen.queryByRole("button", { name });
    if (button) return button as HTMLButtonElement;
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }
  throw new Error(`Button not rendered: ${name}`);
}

async function flushFakeTimersUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await act(async () => { await Promise.resolve(); await Promise.resolve(); if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1); });
  }
  throw new Error("Condition did not settle.");
}

function mediaResponse(handle: string) {
  const itemId = handle.replace(/^sealed-/, "");
  return {
    itemId,
    kind: itemId.indexOf("video") >= 0 ? "video" as const : "image" as const,
    url: `https://provider.example/${itemId}`,
    expiresAt: futureIso(),
    revision: "r1"
  };
}
