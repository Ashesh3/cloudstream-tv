// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto, ProviderFolderDto } from "@cloudframe/shared";
import type { AdminApi } from "../api/client";
import { FolderPicker } from "./folder-picker";

afterEach(cleanup);
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const root: ControlRootDto = { id: "root-1", sourceId: source.id, displayName: "Albums", enabled: true, createdAt: source.createdAt };
const providerRoot: ProviderFolderDto = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
const trips: ProviderFolderDto = { providerNodeId: "provider-trips", parentProviderId: providerRoot.providerNodeId, name: "Trips", assignedRootId: null };
const device: ControlDeviceDto = { id: "device-1", name: "Living Room", enabled: true, assignedRootIds: [root.id], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, revokedAt: null };
function pickerApi(): AdminApi { return { installationStatus: vi.fn(), claimInstallation: vi.fn(), login: vi.fn(), logout: vi.fn(), snapshot: vi.fn(), transcodeStatus: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), authorizeSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(), providerFolders: vi.fn().mockResolvedValue({ source, current: providerRoot, breadcrumbs: [providerRoot], folders: [trips], nextCursor: null }), createRoot: vi.fn().mockResolvedValue({ root: { ...root, id: "root-trips", displayName: "Trips" } }), rootImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [device] }), removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [] }) }; }

describe("folder picker compatibility wrapper", () => {
  it("browses live provider folders and adds a provider folder", async () => {
    const api = pickerApi(); const changed = vi.fn().mockResolvedValue(true);
    render(<FolderPicker source={source} roots={[root]} api={api} onRootAdded={changed} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Trips to household program" }));
    await waitFor(() => expect(api.createRoot).toHaveBeenCalledWith(source.id, { providerNodeId: trips.providerNodeId }));
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("loads impact and confirms root removal without nesting dialogs", async () => {
    const api = pickerApi(); render(<FolderPicker source={source} roots={[root]} devices={[device]} api={api} onRootAdded={vi.fn().mockResolvedValue(true)} onRootRemoved={vi.fn().mockResolvedValue(true)} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Albums" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove folder from household program" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(within(dialog).getByText("Living Room")).toBeVisible();
  });
});
