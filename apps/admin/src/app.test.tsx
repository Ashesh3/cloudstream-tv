// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdminOverviewResponse,
  AssignedRootDto,
  DeviceDto,
  DeviceRequestDto,
  SourceDto
} from "@cloudframe/shared";
import { AdminApp } from "./app";
import type { AdminApi } from "./api/client";

const request = (id: string, name: string, createdAt: string): DeviceRequestDto => ({
  id,
  requestedName: name,
  status: "pending",
  createdAt,
  expiresAt: "2026-08-26T01:00:00.000Z",
  resolvedAt: null,
  approvedDeviceId: null
});

const root: AssignedRootDto = {
  id: "root-1",
  sourceId: "source-1",
  providerNodeId: "provider-folder-1",
  displayName: "Family Photos",
  ancestryProviderIds: [],
  enabled: true,
  createdAt: "2026-08-20T00:00:00.000Z"
};

const device: DeviceDto = {
  id: "device-1",
  name: "Living Room",
  enabled: true,
  assignedRootIds: [root.id],
  mediaOrder: null,
  slideshowSeconds: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  approvedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-26T00:00:00.000Z",
  revokedAt: null
};

const source: SourceDto = {
  id: "source-1",
  provider: "google",
  accountLabel: "Home Drive",
  status: "healthy",
  accessTokenExpiresAt: null,
  nextSyncAt: "2026-08-26T02:00:00.000Z",
  lastSyncStartedAt: "2026-08-26T00:00:00.000Z",
  lastSyncCompletedAt: "2026-08-26T00:04:00.000Z",
  lastSyncErrorCode: null,
  indexProgress: { mode: "initial", processedNodeCount: 42, pendingFolderCount: 3, reconciliationActive: false },
  createdAt: "2026-08-20T00:00:00.000Z"
};

const overview: AdminOverviewResponse = {
  household: {
    id: "household-primary",
    createdAt: "2026-08-20T00:00:00.000Z",
    allowNewDeviceRequests: true,
    defaultMediaOrder: "captured-desc",
    defaultSlideshowSeconds: 8
  },
  pendingRequests: [
    request("request-old", "Kitchen", "2026-08-25T00:00:00.000Z"),
    request("request-new", "Den TV", "2026-08-26T00:00:00.000Z")
  ],
  devices: [device],
  sources: [source],
  roots: [root]
};

function api(): AdminApi {
  return {
    login: vi.fn().mockResolvedValue({ authenticated: true }),
    logout: vi.fn().mockResolvedValue({ authenticated: false }),
    overview: vi.fn().mockResolvedValue(overview),
    approveRequest: vi.fn().mockResolvedValue({ device }),
    denyRequest: vi.fn().mockResolvedValue({ request: { ...overview.pendingRequests[0]!, status: "denied" } }),
    updateDevice: vi.fn().mockResolvedValue({ device }),
    revokeDevice: vi.fn().mockResolvedValue({ revoked: true }),
    settings: vi.fn().mockResolvedValue({
      allowNewDeviceRequests: true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8,
      indexHealth: { totalNodeCount: 120, availableNodeCount: 118, indexingSourceCount: 1, estimatedFirestoreDocumentCount: 122 }
    }),
    updateSettings: vi.fn().mockResolvedValue({
      allowNewDeviceRequests: false,
      defaultMediaOrder: "name-asc",
      defaultSlideshowSeconds: 12
    }),
    rotatePassphrase: vi.fn().mockResolvedValue({ authenticated: false }),
    sources: vi.fn().mockResolvedValue({ sources: [{ ...source, roots: [root] }] }),
    authorizeSource: vi.fn().mockResolvedValue({ authorizationUrl: "https://accounts.example/authorize" }),
    syncSource: vi.fn().mockResolvedValue({ status: "queued" }),
    sourceImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [device] }),
    removeSource: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [device] }),
    sourceTree: vi.fn().mockResolvedValue({ source, parent: null, folders: [] }),
    createRoot: vi.fn().mockResolvedValue({ root }),
    rootImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [device] }),
    removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [device] }),
    thumbnailUrls: vi.fn().mockResolvedValue({ items: [] })
  };
}

async function login(client: AdminApi) {
  render(<AdminApp api={client} checkSession={false} />);
  fireEvent.change(await screen.findByLabelText("Admin passphrase"), { target: { value: "a very long household passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Device requests" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/admin/");
});

describe("mobile admin workflows", () => {
  it("presents the approved operational dashboard with household metrics", async () => {
    const client = api();
    await login(client);

    expect(screen.getByRole("heading", { name: "Household overview" })).toBeVisible();
    expect(screen.getByText("Pending requests").parentElement).toHaveTextContent("2");
    expect(screen.getByText("Approved devices").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Cloud sources").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Available folders").parentElement).toHaveTextContent("1");
    expect(screen.getByRole("button", { name: "Open admin menu" })).toBeVisible();
  });

  it("logs in with a visible pending state and returns to login on an expired session", async () => {
    const client = api();
    let resolveLogin!: (value: { authenticated: true }) => void;
    vi.mocked(client.login).mockReturnValue(new Promise(resolve => { resolveLogin = resolve; }));
    render(<AdminApp api={client} checkSession={false} />);
    fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "a very long household passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    resolveLogin({ authenticated: true });
    expect(await screen.findByRole("heading", { name: "Device requests" })).toBeVisible();

    vi.mocked(client.overview).mockRejectedValueOnce(Object.assign(new Error("expired"), { status: 401, code: "ADMIN_SESSION_REQUIRED" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("heading", { name: "Household admin" })).toBeVisible();
  });

  it("uses an existing secure cookie session without asking for the passphrase", async () => {
    const client = api();
    vi.mocked(client.overview).mockReset().mockResolvedValue(overview);
    render(<AdminApp api={client} />);
    expect(await screen.findByRole("heading", { name: "Device requests" })).toBeVisible();
    expect(client.login).not.toHaveBeenCalled();
  });

  it("sorts pending requests newest first, validates approval, and denies only after success", async () => {
    const client = api();
    await login(client);
    const cards = screen.getAllByTestId("request-card");
    expect(within(cards[0]!).getByText("Den TV")).toBeVisible();
    fireEvent.click(within(cards[0]!).getByRole("button", { name: "Approve Den TV" }));
    const dialog = screen.getByRole("dialog", { name: "Approve device" });
    fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve device" }));
    expect(within(dialog).getByText("Enter a device name.")).toBeVisible();
    expect(within(dialog).getByText("Select at least one root.")).toBeVisible();
    expect(client.approveRequest).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText("Device name"), { target: { value: " Den TV " } });
    fireEvent.click(within(dialog).getByLabelText("Family Photos"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve device" }));
    await waitFor(() => expect(client.approveRequest).toHaveBeenCalledWith("request-new", { name: "Den TV", rootIds: ["root-1"] }));

    // Open a second request to exercise denial independently of approval.
    const nextCard = screen.getAllByTestId("request-card").find(card => within(card).queryByText("Kitchen"))!;
    let finishDeny!: () => void;
    vi.mocked(client.denyRequest).mockReturnValue(new Promise(resolve => { finishDeny = () => resolve({ request: { ...overview.pendingRequests[0]!, status: "denied" } }); }));
    fireEvent.click(within(nextCard).getByRole("button", { name: "Deny Kitchen" }));
    expect(screen.getByText("Kitchen")).toBeVisible();
    finishDeny();
    await waitFor(() => expect(screen.queryByText("Kitchen")).not.toBeInTheDocument());
  });

  it("updates device overrides and requires explicit revoke confirmation", async () => {
    const client = api();
    await login(client);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    const editor = screen.getByRole("dialog", { name: "Edit device" });
    fireEvent.change(within(editor).getByLabelText("Device name"), { target: { value: "Family TV" } });
    fireEvent.click(within(editor).getByLabelText("Device enabled"));
    fireEvent.click(within(editor).getByLabelText("Family Photos"));
    fireEvent.change(within(editor).getByLabelText("Media ordering"), { target: { value: "name-asc" } });
    fireEvent.change(within(editor).getByLabelText("Slideshow seconds"), { target: { value: "12" } });
    fireEvent.click(within(editor).getByRole("button", { name: "Save device" }));
    expect(within(editor).getByText("Enter a name and select at least one root.")).toBeVisible();
    fireEvent.click(within(editor).getByLabelText("Family Photos"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save device" }));
    await waitFor(() => expect(client.updateDevice).toHaveBeenCalledWith("device-1", expect.objectContaining({ name: "Family TV", enabled: false, assignedRootIds: ["root-1"], mediaOrder: "name-asc", slideshowSeconds: 12 })));

    fireEvent.click(screen.getByRole("button", { name: "Revoke Living Room" }));
    const confirm = screen.getByRole("alertdialog", { name: "Revoke device" });
    expect(within(confirm).getByText(/cannot be undone/i)).toBeVisible();
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke permanently" }));
    await waitFor(() => expect(client.revokeDevice).toHaveBeenCalledWith("device-1"));
  });

  it("shows safe source checkpoint progress and estimated Firestore index health", async () => {
    const client = api();
    await login(client);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Initial · 42 nodes · 3 folders pending")).toBeVisible();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Settings" }));
    expect(screen.getByText("120")).toBeVisible();
    expect(screen.getByText(/Estimated Firestore documents/)).toBeVisible();
  });

  it("refreshes the overview when a device mutation reports stale state", async () => {
    const client = api();
    await login(client);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Devices" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    vi.mocked(client.updateDevice).mockRejectedValueOnce(Object.assign(new Error("Device changed elsewhere."), { status: 409, code: "DEVICE_STALE" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit device" })).getByRole("button", { name: "Save device" }));
    await waitFor(() => expect(client.overview).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("Device changed elsewhere.");
  });

  it("connects, syncs, reconnects, and previews source removal impact", async () => {
    const client = api();
    const navigate = vi.fn();
    render(<AdminApp api={client} navigate={navigate} checkSession={false} />);
    fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "a very long household passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Device requests" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Sources" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect OneDrive" }));
    await waitFor(() => expect(client.authorizeSource).toHaveBeenCalledWith("onedrive", undefined));
    expect(navigate).toHaveBeenCalledWith("https://accounts.example/authorize");

    fireEvent.click(screen.getByRole("button", { name: "Sync Home Drive" }));
    await waitFor(() => expect(client.syncSource).toHaveBeenCalledWith("source-1"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Home Drive" }));
    await waitFor(() => expect(client.authorizeSource).toHaveBeenCalledWith("google", "source-1"));

    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove source" });
    expect(within(confirm).getByText("Family Photos")).toBeVisible();
    expect(within(confirm).getByText("Living Room")).toBeVisible();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove source permanently" }));
    await waitFor(() => expect(client.removeSource).toHaveBeenCalledWith("source-1"));
  });

  it("updates household settings, rotates the passphrase, signs out, and exposes mobile navigation", async () => {
    const client = api();
    await login(client);
    expect(screen.getByRole("navigation", { name: "Mobile admin sections" })).toBeVisible();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByLabelText("Allow new device requests"));
    fireEvent.change(screen.getByLabelText("Default ordering"), { target: { value: "name-asc" } });
    fireEvent.change(screen.getByLabelText("Default slideshow seconds"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(client.updateSettings).toHaveBeenCalledWith({ allowNewDeviceRequests: false, defaultMediaOrder: "name-asc", defaultSlideshowSeconds: 12 }));

    fireEvent.change(screen.getByLabelText("Current passphrase"), { target: { value: "current passphrase is long" } });
    fireEvent.change(screen.getByLabelText("New passphrase"), { target: { value: "new passphrase is even longer" } });
    fireEvent.click(screen.getByRole("button", { name: "Change passphrase" }));
    expect(await screen.findByRole("heading", { name: "Household admin" })).toBeVisible();

    cleanup();
    await login(client);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Household admin" })).toBeVisible();
  });

  it("shows network recovery and safe OAuth status then removes it from the URL", async () => {
    window.history.replaceState({}, "", "/admin/?section=sources&oauth=cancelled");
    const replace = vi.spyOn(window.history, "replaceState");
    const client = api();
    vi.mocked(client.overview).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    render(<AdminApp api={client} checkSession={false} />);
    fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "a very long household passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Cloudframe could not reach the server.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Connection was cancelled. No source was changed.")).toBeVisible();
    expect(replace).toHaveBeenCalled();
  });
});
