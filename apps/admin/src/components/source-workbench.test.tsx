// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminProviderFolderPageResponse, AssignedRootDto, DeviceDto, ProviderFolderDto, SourceDto } from "@cloudframe/shared";
import type { AdminApi } from "../api/client";
import { SourceWorkbench } from "./source-workbench";

afterEach(cleanup);
beforeEach(() => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 }); });

const source: SourceDto = {
  id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", accessTokenExpiresAt: null, nextSyncAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null, indexProgress: null,
  createdAt: "2026-08-20T00:00:00.000Z", providerRootId: "provider-root", indexState: { kind: "healthy", processedNodeCount: 12, pendingFolderCount: 0, recoverable: false, errorCode: null }
};
const rootFolder: ProviderFolderDto = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
const albums: ProviderFolderDto = { providerNodeId: "albums", parentProviderId: "provider-root", name: "Albums", assignedRootId: null };
const trips: ProviderFolderDto = { providerNodeId: "trips", parentProviderId: "provider-root", name: "Trips", assignedRootId: null };
const archive: ProviderFolderDto = { providerNodeId: "archive", parentProviderId: "provider-root", name: "Archive", assignedRootId: null };
const addedRoot: AssignedRootDto = { id: "root-trips", sourceId: source.id, providerNodeId: trips.providerNodeId, displayName: trips.name, ancestryProviderIds: [source.providerRootId!], enabled: true, createdAt: source.createdAt };
const device: DeviceDto = { id: "tv-1", name: "Living Room", enabled: true, assignedRootIds: [addedRoot.id], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, lastSeenAt: source.createdAt, revokedAt: null };

function page(current: ProviderFolderDto, breadcrumbs: ProviderFolderDto[], folders: ProviderFolderDto[], nextCursor: string | null = null): AdminProviderFolderPageResponse {
  return { source, current, breadcrumbs, folders, nextCursor };
}

function workbenchApi(): AdminApi {
  return {
    login: vi.fn(), logout: vi.fn(), overview: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), settings: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), sources: vi.fn(), authorizeSource: vi.fn(), syncSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(), sourceTree: vi.fn(), thumbnailUrls: vi.fn(),
    providerFolders: vi.fn(async (_sourceId: string, input) => {
      if (input.providerFolderId === albums.providerNodeId) return page(albums, [rootFolder, albums], [{ providerNodeId: "family", parentProviderId: albums.providerNodeId, name: "Family", assignedRootId: null }]);
      if (input.cursor === "page-2") return page(rootFolder, [rootFolder], [trips, archive]);
      return page(rootFolder, [rootFolder], [albums, trips], "page-2");
    }),
    createRoot: vi.fn().mockResolvedValue({ root: addedRoot }),
    rootImpact: vi.fn().mockResolvedValue({ roots: [addedRoot], devices: [device] }),
    removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [addedRoot], devices: [device] })
  };
}

describe("source workbench", () => {
  it("navigates breadcrumbs, pages without duplicates, and preserves a selection while browsing", async () => {
    const api = workbenchApi();
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<SourceWorkbench source={source} roots={[]} devices={[device]} api={api} onChanged={changed} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more folders" }));
    expect(await screen.findByRole("button", { name: "Open Archive" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Open Trips" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Add Trips to household program" }));
    await waitFor(() => expect(api.createRoot).toHaveBeenCalledWith(source.id, { providerNodeId: trips.providerNodeId }));
    expect(changed).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open Albums" }));
    expect(await screen.findByRole("button", { name: "Open Family" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "My Drive" }));
    expect(await screen.findByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
  });

  it("loads removal impact and removes a selected root only after confirmation", async () => {
    const api = workbenchApi();
    const changed = vi.fn().mockResolvedValue(undefined);
    render(<SourceWorkbench source={source} roots={[addedRoot]} devices={[device]} api={api} onChanged={changed} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    const confirmation = await screen.findByRole("dialog", { name: "Remove folder from household program" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(confirmation).getByText("Living Room")).toBeVisible();
    fireEvent.click(within(confirmation).getByRole("button", { name: "Remove Trips" }));

    await waitFor(() => expect(api.removeRoot).toHaveBeenCalledWith(addedRoot.id));
    expect(changed).toHaveBeenCalled();
    expect(await screen.findByText("No folders in the household program")).toBeVisible();
  });

  it("uses mobile Back for folder ancestry and closes only from the provider root", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 500 });
    const api = workbenchApi();
    const onClose = vi.fn();
    render(<SourceWorkbench source={source} roots={[]} devices={[]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} onClose={onClose} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Albums" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Open Albums" })).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to sources" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
