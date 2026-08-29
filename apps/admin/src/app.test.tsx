// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { AdminSnapshotResponse, ControlDeviceDto, ControlRequestDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { AdminApp } from "./app";
import { AdminApiError, type AdminApi } from "./api/client";
import { CHECKED_CONTROL_SELECTORS, CONTROL_HIT_TARGET, DIRECTION_SEED } from "./design/ledger";

const request = (id: string, name: string, createdAt: string): ControlRequestDto => ({ id, requestedName: name, status: "pending", createdAt, expiresAt: "2026-08-29T01:00:00.000Z", resolvedAt: null, approvedDeviceId: null });
const root: ControlRootDto = { id: "root-1", sourceId: "source-1", displayName: "Family Photos", enabled: true, createdAt: "2026-08-20T00:00:00.000Z" };
const device: ControlDeviceDto = { id: "device-1", name: "Living Room", enabled: true, assignedRootIds: [root.id], mediaOrder: null, slideshowSeconds: null, createdAt: "2026-08-20T00:00:00.000Z", approvedAt: "2026-08-20T00:00:00.000Z", revokedAt: null };
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const refreshFailure = new AdminApiError(503, "REQUEST_FAILED", "Cloudframe is temporarily unavailable. Try again.");
const never = <T,>() => new Promise<T>(() => undefined);
const snapshot: AdminSnapshotResponse = {
  revision: 7,
  household: { allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 },
  pendingRequests: [request("request-old", "Kitchen", "2026-08-25T00:00:00.000Z"), request("request-new", "Den TV", "2026-08-26T00:00:00.000Z")],
  devices: [device], sources: [source], roots: [root], storage: { mode: "local", revision: 7 }
};

function api(initial = snapshot): AdminApi {
  const providerRoot = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
  return {
    login: vi.fn().mockResolvedValue({ authenticated: true }), logout: vi.fn().mockResolvedValue({ authenticated: false }),
    snapshot: vi.fn().mockResolvedValue(initial), approveRequest: vi.fn().mockResolvedValue({ device }),
    denyRequest: vi.fn().mockResolvedValue({ request: { ...initial.pendingRequests[0]!, status: "denied" } }),
    updateDevice: vi.fn().mockResolvedValue({ device }), revokeDevice: vi.fn().mockResolvedValue({ revoked: true }),
    updateSettings: vi.fn().mockResolvedValue({ revision: 8 }), rotatePassphrase: vi.fn().mockResolvedValue({ authenticated: false, revision: 8 }),
    authorizeSource: vi.fn(async provider => ({ authorizationUrl: provider === "google" ? "https://accounts.google.com/o/oauth2/v2/auth?client_id=test" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test" })),
    sourceImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [device] }), removeSource: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [device] }),
    providerFolders: vi.fn().mockResolvedValue({ source, current: providerRoot, breadcrumbs: [providerRoot], folders: [], nextCursor: null }),
    createRoot: vi.fn().mockResolvedValue({ root }), rootImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [device] }), removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [device] })
  };
}

async function login(client: AdminApi) {
  render(<AdminApp api={client} checkSession={false} />);
  fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "a very long household passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Device requests" });
}
const go = (name: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "Admin sections" })).getByRole("button", { name }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState({}, "", "/admin/"); });

describe("admin snapshot workflows", () => {
  it("loads the admin with exactly one snapshot request and no legacy reads", async () => {
    const client = api();
    render(<AdminApp api={client} />);
    expect(await screen.findByText("Household overview")).toBeInTheDocument();
    expect(client.snapshot).toHaveBeenCalledTimes(1);
    expect("overview" in client).toBe(false); expect("settings" in client).toBe(false); expect("sources" in client).toBe(false);
    expect(client.login).not.toHaveBeenCalled();
  });

  it("keeps the single initial snapshot usable through StrictMode effect replay", async () => {
    const client = api();
    render(<StrictMode><AdminApp api={client} /></StrictMode>);
    expect(await screen.findByRole("heading", { name: "Device requests" })).toBeVisible();
    expect(client.snapshot).toHaveBeenCalledTimes(1);
  });

  it("shows source and access truth without indexing or quota language", async () => {
    await login(api());
    const sourceHealth = screen.getByRole("region", { name: "Source health" });
    expect(within(sourceHealth).getByText("Connected")).toBeVisible();
    expect(screen.getByRole("region", { name: "Attention" })).toHaveTextContent("2 televisions waiting");
    const figures = screen.getByRole("region", { name: "Program figures" });
    expect(figures).toHaveTextContent("1 approved"); expect(figures).toHaveTextContent("1 connected");
    expect(document.body.textContent).not.toMatch(/index|quota|reconcil|processed|Firestore/i);
  });

  it.each([
    ["healthy", "Connected"], ["reauth-required", "Reauthorization required"], ["disabled", "Disabled"]
  ] as const)("maps %s source truth to %s", async (status, label) => {
    await login(api({ ...snapshot, sources: [{ ...source, status }] }));
    expect(screen.getByRole("region", { name: "Source health" })).toHaveTextContent(label);
  });

  it("counts only healthy sources as connected", async () => {
    await login(api({ ...snapshot, sources: [{ ...source, status: "reauth-required" }] }));
    expect(screen.getByRole("region", { name: "Program figures" })).toHaveTextContent("0 connected");
  });

  it("shows local encrypted storage and current control-plane counts", async () => {
    await login(api());
    expect(screen.getByText("Local encrypted storage")).toBeVisible();
    expect(document.body.textContent).not.toMatch(/Vercel|recovery copy/i);
    go("Settings");
    expect(screen.getByText("Approved devices").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Connected sources").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Approved roots").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Pending requests").parentElement).toHaveTextContent("2");
    expect(document.body.textContent).not.toMatch(/data loss/i);
  });

  it("performs a focused device mutation and then one snapshot refresh", async () => {
    const client = api();
    await login(client); go("Devices");
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit device" })).getByRole("button", { name: "Save device" }));
    await waitFor(() => expect(client.updateDevice).toHaveBeenCalledTimes(1));
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  });

  it("approves and denies only after focused mutations and snapshot refreshes", async () => {
    const client = api();
    vi.mocked(client.snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ ...snapshot, pendingRequests: snapshot.pendingRequests.filter(value => value.id !== "request-new") })
      .mockResolvedValueOnce({ ...snapshot, pendingRequests: [] });
    await login(client);
    const first = screen.getAllByTestId("request-card")[0]!;
    fireEvent.click(within(first).getByRole("button", { name: "Approve Den TV" }));
    const dialog = screen.getByRole("dialog", { name: "Approve device" });
    fireEvent.click(within(dialog).getByLabelText("Family Photos"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve device" }));
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
    fireEvent.click(within(screen.getByTestId("request-card")).getByRole("button", { name: "Deny Kitchen" }));
    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(3));
  });

  it("preserves an approved device and closes approval when its snapshot refresh fails", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(refreshFailure);
    await login(client);
    fireEvent.click(within(screen.getAllByTestId("request-card")[0]!).getByRole("button", { name: "Approve Den TV" }));
    const dialog = screen.getByRole("dialog", { name: "Approve device" });
    fireEvent.click(within(dialog).getByLabelText("Family Photos"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve device" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Approve device" })).not.toBeInTheDocument());
    expect(screen.queryByText("Den TV")).not.toBeInTheDocument();
    expect(screen.getByText("Den TV was approved.")).toBeVisible();
    expect(screen.getByText("Change saved, but the household ledger could not be refreshed. Refresh to confirm the latest state.")).toBeVisible();
    expect(screen.queryByText("Action could not be completed")).not.toBeInTheDocument();
  });

  it("closes approval immediately while the committed refresh remains pending", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockReturnValueOnce(never());
    await login(client);
    fireEvent.click(within(screen.getAllByTestId("request-card")[0]!).getByRole("button", { name: "Approve Den TV" }));
    const dialog = screen.getByRole("dialog", { name: "Approve device" });
    fireEvent.click(within(dialog).getByLabelText("Family Photos"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve device" }));

    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Approve device" })).not.toBeInTheDocument();
    expect(screen.getByText("Den TV was approved.")).toBeVisible();
  });

  it("preserves denial when its snapshot refresh fails", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(refreshFailure);
    await login(client);
    const kitchen = screen.getAllByTestId("request-card").find(card => within(card).queryByText("Kitchen"))!;
    fireEvent.click(within(kitchen).getByRole("button", { name: "Deny Kitchen" }));

    await waitFor(() => expect(screen.queryByText("Kitchen")).not.toBeInTheDocument());
    expect(screen.getByText("Kitchen was denied.")).toBeVisible();
    expect(screen.getByText(/Change saved, but the household ledger could not be refreshed/)).toBeVisible();
  });

  it("preserves device edits and closes the editor when its snapshot refresh fails", async () => {
    const client = api();
    vi.mocked(client.updateDevice).mockResolvedValueOnce({ device: { ...device, name: "Family TV" } });
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(refreshFailure);
    await login(client); go("Devices");
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Edit device" })).getByLabelText("Device name"), { target: { value: "Family TV" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit device" })).getByRole("button", { name: "Save device" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit device" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Family TV" })).toBeVisible();
    expect(screen.getByText("Device updated.")).toBeVisible();
    expect(screen.getByText(/Change saved, but the household ledger could not be refreshed/)).toBeVisible();
  });

  it("closes device editing immediately while the committed refresh remains pending", async () => {
    const client = api();
    vi.mocked(client.updateDevice).mockResolvedValueOnce({ device: { ...device, name: "Family TV" } });
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockReturnValueOnce(never());
    await login(client); go("Devices");
    fireEvent.click(screen.getByRole("button", { name: "Edit Living Room" }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Edit device" })).getByLabelText("Device name"), { target: { value: "Family TV" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Edit device" })).getByRole("button", { name: "Save device" }));

    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog", { name: "Edit device" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Family TV" })).toBeVisible();
  });

  it("preserves revocation and closes confirmation when its snapshot refresh fails", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(refreshFailure);
    await login(client); go("Devices");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Living Room" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Revoke device" })).getByRole("button", { name: "Revoke permanently" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Revoke device" })).not.toBeInTheDocument());
    expect(screen.getByText("No approved devices")).toBeVisible();
    expect(screen.getByText("Living Room was revoked.")).toBeVisible();
    expect(screen.getByText(/Change saved, but the household ledger could not be refreshed/)).toBeVisible();
  });

  it("closes revocation immediately while the committed refresh remains pending", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockReturnValueOnce(never());
    await login(client); go("Devices");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Living Room" }));
    fireEvent.click(within(screen.getByRole("alertdialog", { name: "Revoke device" })).getByRole("button", { name: "Revoke permanently" }));

    await waitFor(() => expect(client.snapshot).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alertdialog", { name: "Revoke device" })).not.toBeInTheDocument();
    expect(screen.getByText("No approved devices")).toBeVisible();
  });

  it("preserves settings when its snapshot refresh fails", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(refreshFailure);
    await login(client); go("Settings");
    fireEvent.click(screen.getByLabelText("Allow new device requests"));
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    expect(await screen.findByText("Household defaults saved.")).toBeVisible();
    expect(screen.getByText(/Change saved, but the household ledger could not be refreshed/)).toBeVisible();
    expect(screen.getByLabelText("Allow new device requests")).not.toBeChecked();
  });

  it("keeps the live provider workbench in layout with exact immediate-access copy", async () => {
    await login(api()); go("Sources");
    const trigger = screen.getByRole("button", { name: "Browse & choose folders" }); fireEvent.click(trigger);
    const workbench = await screen.findByRole("region", { name: "Choose source folders" });
    expect(workbench).toHaveTextContent("Browse the provider live. Folders added to the household program are available to assigned televisions immediately.");
    expect(screen.queryByRole("dialog", { name: "Choose source folders" })).not.toBeInTheDocument();
    fireEvent.keyDown(workbench, { key: "Escape" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Browse & choose folders" })).toHaveFocus());
  });

  it("refreshes once before leaving for provider authorization", async () => {
    const client = api(); const navigate = vi.fn();
    render(<AdminApp api={client} navigate={navigate} checkSession={false} />);
    fireEvent.change(screen.getByLabelText("Admin passphrase"), { target: { value: "a very long household passphrase" } }); fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByRole("heading", { name: "Device requests" }); go("Sources");
    fireEvent.click(screen.getByRole("button", { name: "Connect OneDrive" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=test"));
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  });

  it("closes source removal after the focused mutation and one refresh", async () => {
    const client = api();
    await login(client); go("Sources");
    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove source" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove source permanently" }));
    await waitFor(() => expect(client.removeSource).toHaveBeenCalledWith(source.id));
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove source" })).not.toBeInTheDocument());
  });

  it("preserves source removal and closes confirmation when its snapshot refresh fails", async () => {
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockRejectedValueOnce(refreshFailure);
    await login(client); go("Sources");
    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove source" })).getByRole("button", { name: "Remove source permanently" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove source" })).not.toBeInTheDocument());
    expect(screen.getByText("No cloud sources")).toBeVisible();
    expect(screen.getByText("Source removed. Television access was removed immediately.")).toBeVisible();
    expect(screen.getByText(/Change saved, but the household ledger could not be refreshed/)).toBeVisible();
  });

  it("ignores stale snapshot responses and updates after unmount", async () => {
    let resolveOld!: (value: AdminSnapshotResponse) => void;
    const old = new Promise<AdminSnapshotResponse>(resolve => { resolveOld = resolve; });
    const client = api();
    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot).mockReturnValueOnce(old).mockResolvedValueOnce({ ...snapshot, revision: 9, pendingRequests: [] });
    await login(client);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Attention" })).toHaveTextContent("The booth is quiet"));
    resolveOld(snapshot);
    await Promise.resolve();
    expect(screen.getByRole("region", { name: "Attention" })).toHaveTextContent("The booth is quiet");
    cleanup();
    expect(() => resolveOld(snapshot)).not.toThrow();
  });

  it("returns to login on an expired snapshot session and exposes safe errors", async () => {
    const client = api(); await login(client);
    vi.mocked(client.snapshot).mockRejectedValueOnce(new AdminApiError(401, "ADMIN_UNAUTHORIZED", "Your admin session expired. Sign in again."));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("heading", { name: "Household admin" })).toBeVisible();
  });

  it("keeps mobile navigation, focus targets, and the direction contract", async () => {
    await login(api());
    expect(within(screen.getByRole("navigation", { name: "Mobile admin sections" })).getAllByRole("button")).toHaveLength(4);
    expect(CONTROL_HIT_TARGET).toBe(44); expect(CHECKED_CONTROL_SELECTORS).toHaveLength(2);
    const adminRoot = document.querySelector(".admin-root")!;
    expect(adminRoot.firstChild?.nodeType).toBe(Node.COMMENT_NODE); expect(adminRoot.firstChild?.textContent).toContain(DIRECTION_SEED);
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAccessibleName();
  });
});
