// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto, ProviderFolderDto } from "@cloudframe/shared";
import { AdminApiError, type AdminApi, type AdminProviderFolderPage } from "../api/client";
import { SourceWorkbench } from "./source-workbench";

afterEach(cleanup); beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); });
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const providerRoot: ProviderFolderDto = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
const trips: ProviderFolderDto = { providerNodeId: "trips", parentProviderId: providerRoot.providerNodeId, name: "Trips", assignedRootId: null };
const archive: ProviderFolderDto = { providerNodeId: "archive", parentProviderId: providerRoot.providerNodeId, name: "Archive", assignedRootId: null };
const tripsRoot: ControlRootDto = { id: "root-trips", sourceId: source.id, displayName: "Trips", enabled: true, createdAt: source.createdAt };
const archiveRoot: ControlRootDto = { id: "root-archive", sourceId: source.id, displayName: "Archive", enabled: true, createdAt: source.createdAt };
const device: ControlDeviceDto = { id: "tv-1", name: "Living Room", enabled: true, assignedRootIds: [tripsRoot.id], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, revokedAt: null };
function page(folders: ProviderFolderDto[] = [trips, archive], nextCursor: string | null = null): AdminProviderFolderPage { return { source, current: providerRoot, breadcrumbs: [providerRoot], folders, nextCursor }; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function workbenchApi(): AdminApi { return { installationStatus: vi.fn(), claimInstallation: vi.fn(), login: vi.fn(), logout: vi.fn(), snapshot: vi.fn(), transcodeStatus: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), authorizeSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(), providerFolders: vi.fn().mockResolvedValue(page()), createRoot: vi.fn().mockResolvedValue({ root: tripsRoot }), rootImpact: vi.fn().mockResolvedValue({ roots: [tripsRoot], devices: [device] }), removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [tripsRoot], devices: [device] }) }; }

describe("source workbench", () => {
  it("renders the exact immediate-access workbench and closes from Escape", async () => {
    const close = vi.fn();
    render(<SourceWorkbench source={source} roots={[]} api={workbenchApi()} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={close} />);
    const workbench = await screen.findByRole("region", { name: "Choose source folders" });
    expect(workbench).toHaveTextContent("Browse the provider live. Folders added to the household program are available to assigned televisions immediately.");
    fireEvent.keyDown(workbench, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
  });

  it("updates the local program immediately, then performs one snapshot refresh", async () => {
    const api = workbenchApi(); const changed = vi.fn().mockResolvedValue(true);
    render(<SourceWorkbench source={source} roots={[]} devices={[device]} api={api} onRootAdded={changed} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Trips to household program" }));
    expect(await screen.findByText("Trips")).toBeVisible();
    expect(screen.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps an optimistic root available when the snapshot refresh fails", async () => {
    const changed = vi.fn().mockResolvedValue(false);
    render(<SourceWorkbench source={source} roots={[]} api={workbenchApi()} onRootAdded={changed} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Trips to household program" }));
    expect(await screen.findByText("Trips was added to the household program.")).toBeVisible();
    expect(screen.getByText("Change saved, but household data could not be refreshed. Refresh to confirm the latest state.")).toBeVisible();
  });

  it("preserves root removal and closes confirmation when its snapshot refresh fails", async () => {
    const api = workbenchApi(); const changed = vi.fn().mockResolvedValue(false);
    render(<SourceWorkbench source={source} roots={[tripsRoot]} devices={[device]} api={api} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={changed} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove folder from household program" })).getByRole("button", { name: "Remove Trips" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove folder from household program" })).not.toBeInTheDocument());
    expect(screen.getByText("No folders in the household program")).toBeVisible();
    expect(screen.getByText("Trips was removed from the household program.")).toBeVisible();
    expect(screen.getByText("Change saved, but household data could not be refreshed. Refresh to confirm the latest state.")).toBeVisible();
  });

  it("loads explicit impact and says access is removed immediately", async () => {
    const api = workbenchApi(); const changed = vi.fn().mockResolvedValue(true);
    render(<SourceWorkbench source={source} roots={[tripsRoot]} devices={[device]} api={api} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={changed} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove folder from household program" });
    expect(dialog).toHaveTextContent("Access is removed immediately from every assigned television.");
    expect(dialog).not.toHaveTextContent(/reconcil|index/i); expect(within(dialog).getByText("Living Room")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove Trips" }));
    await waitFor(() => expect(api.removeRoot).toHaveBeenCalledWith(tripsRoot.id)); expect(changed).toHaveBeenCalledTimes(1);
  });

  it("rejects stale out-of-order impact responses", async () => {
    const api = workbenchApi(); const first = deferred<Awaited<ReturnType<AdminApi["rootImpact"]>>>(); const second = deferred<Awaited<ReturnType<AdminApi["rootImpact"]>>>();
    vi.mocked(api.rootImpact).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    render(<SourceWorkbench source={source} roots={[tripsRoot, archiveRoot]} devices={[device]} api={api} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Review removal impact for Archive" }));
    const dialog = screen.getByRole("dialog");
    await act(async () => { first.resolve({ roots: [tripsRoot], devices: [{ ...device, name: "Stale TV" }] }); await Promise.resolve(); });
    expect(dialog).not.toHaveTextContent("Stale TV"); expect(within(dialog).getByRole("button", { name: "Remove Archive" })).toBeDisabled();
    await act(async () => { second.resolve({ roots: [archiveRoot], devices: [{ ...device, name: "Family Room" }] }); await Promise.resolve(); });
    expect(await within(dialog).findByText("Family Room")).toBeVisible();
  });

  it("restores focus to the removal trigger after cancellation", async () => {
    render(<SourceWorkbench source={source} roots={[tripsRoot]} devices={[device]} api={workbenchApi()} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} />);
    const trigger = await screen.findByRole("button", { name: "Review removal impact for Trips" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove folder from household program" })).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Remove folder from household program" })).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("routes a root-impact 401 through onUnauthorized without a generic error", async () => {
    const api = workbenchApi();
    const onUnauthorized = vi.fn();
    vi.mocked(api.rootImpact).mockRejectedValue(new AdminApiError(401, "ADMIN_UNAUTHORIZED", "Session expired."));
    render(<SourceWorkbench source={source} roots={[tripsRoot]} api={api} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} onUnauthorized={onUnauthorized} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("routes a remove-root 401 through onUnauthorized without a generic error", async () => {
    const api = workbenchApi();
    const onUnauthorized = vi.fn();
    vi.mocked(api.removeRoot).mockRejectedValue(new AdminApiError(401, "ADMIN_UNAUTHORIZED", "Session expired."));
    render(<SourceWorkbench source={source} roots={[tripsRoot]} devices={[device]} api={api} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} onUnauthorized={onUnauthorized} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Remove folder from household program" })).getByRole("button", { name: "Remove Trips" }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
