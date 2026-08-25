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
  thumbnailUrls: vi.fn()
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
    expect(await screen.findByRole("heading", { name: "Name this TV" })).toBeVisible();
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
      accountLabel: "Home Drive", nodeId: "folder-1", folderCoverNodeIds: [], childFolderCount: 2, childMediaCount: 8
    }] });
    render(<TvApp api={client} browserSupported />);
    expect(await screen.findByText("Family Photos")).toBeVisible();
    fireEvent.keyDown(window, { keyCode: 457 });
    expect(screen.getByRole("dialog", { name: "Sources" })).toBeVisible();
    expect(screen.getByText("Home Drive")).toBeVisible();
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
