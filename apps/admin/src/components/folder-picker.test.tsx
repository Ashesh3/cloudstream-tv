// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssignedRootDto, DeviceDto, ProviderFolderDto, SourceDto } from "@cloudframe/shared";
import type { AdminApi } from "../api/client";
import { FolderPicker } from "./folder-picker";

afterEach(cleanup);
const source: SourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", accessTokenExpiresAt: null, nextSyncAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null, indexProgress: null, createdAt: "2026-08-20T00:00:00.000Z", providerRootId: "provider-root", indexState: { kind: "healthy", processedNodeCount: 0, pendingFolderCount: 0, recoverable: false, errorCode: null } };
const root: AssignedRootDto = { id: "root-1", sourceId: source.id, providerNodeId: "provider-albums", displayName: "Albums", ancestryProviderIds: [], enabled: true, createdAt: source.createdAt };
const providerRoot: ProviderFolderDto = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
const albums: ProviderFolderDto = { providerNodeId: "provider-albums", parentProviderId: "provider-root", name: "Albums", assignedRootId: root.id };
const trips: ProviderFolderDto = { providerNodeId: "provider-trips", parentProviderId: "provider-root", name: "Trips", assignedRootId: null };
const device: DeviceDto = { id: "device-1", name: "Living Room", enabled: true, assignedRootIds: [root.id], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, lastSeenAt: source.createdAt, revokedAt: null };

function pickerApi(): AdminApi {
  return {
    login: vi.fn(), logout: vi.fn(), overview: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), settings: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), sources: vi.fn(), authorizeSource: vi.fn(), syncSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(), sourceTree: vi.fn(), thumbnailUrls: vi.fn(),
    providerFolders: vi.fn().mockResolvedValue({ source, current: providerRoot, breadcrumbs: [providerRoot], folders: [albums, trips], nextCursor: null }),
    createRoot: vi.fn().mockResolvedValue({ root: { ...root, id: "root-trips", providerNodeId: trips.providerNodeId, displayName: trips.name } }),
    rootImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [device] }),
    removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [] })
  };
}

describe("folder picker compatibility wrapper", () => {
  it("browses live provider folders, marks selected roots, and adds a provider folder", async () => {
    const api = pickerApi(); const changed = vi.fn().mockResolvedValue(undefined);
    render(<FolderPicker source={source} roots={[root]} api={api} onChanged={changed} onClose={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Open Albums" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Albums is in the household program" })).toBeDisabled();
    expect(api.sourceTree).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add Trips to household program" }));
    await waitFor(() => expect(api.createRoot).toHaveBeenCalledWith(source.id, { providerNodeId: trips.providerNodeId }));
    expect(changed).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
  });

  it("loads impact and confirms root removal without nesting dialogs", async () => {
    const api = pickerApi(); const changed = vi.fn().mockResolvedValue(undefined);
    render(<FolderPicker source={source} roots={[root]} api={api} onChanged={changed} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Albums" }));
    const confirm = await screen.findByRole("dialog", { name: "Remove folder from household program" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(confirm).getByText("Living Room")).toBeVisible();
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove Albums" }));
    await waitFor(() => expect(api.removeRoot).toHaveBeenCalledWith(root.id));
    expect(changed).toHaveBeenCalled();
  });
});
