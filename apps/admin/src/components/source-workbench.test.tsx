// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const albumsRoot: AssignedRootDto = { id: "root-albums", sourceId: source.id, providerNodeId: albums.providerNodeId, displayName: albums.name, ancestryProviderIds: [source.providerRootId!], enabled: true, createdAt: source.createdAt };
const device: DeviceDto = { id: "tv-1", name: "Living Room", enabled: true, assignedRootIds: [addedRoot.id], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, lastSeenAt: source.createdAt, revokedAt: null };

function page(current: ProviderFolderDto, breadcrumbs: ProviderFolderDto[], folders: ProviderFolderDto[], nextCursor: string | null = null): AdminProviderFolderPageResponse {
  return { source, current, breadcrumbs, folders, nextCursor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it("keeps an optimistic root selected and warns when the post-add refresh fails", async () => {
    const api = workbenchApi();
    const changed = vi.fn().mockRejectedValue(new Error("Overview refresh failed."));
    render(<SourceWorkbench source={source} roots={[]} devices={[]} api={api} onChanged={changed} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add Trips to household program" }));

    expect(await screen.findByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
    expect(await screen.findByRole("status")).toHaveTextContent("Trips was added, but the household ledger could not refresh. The selection is preserved.");
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

  it("invalidates a pending impact request when its dialog closes, even if the same root is reopened", async () => {
    const api = workbenchApi();
    const first = deferred<Awaited<ReturnType<AdminApi["rootImpact"]>>>();
    const second = deferred<Awaited<ReturnType<AdminApi["rootImpact"]>>>();
    vi.mocked(api.rootImpact).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    render(<SourceWorkbench source={source} roots={[addedRoot]} devices={[device]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Remove folder from household program" })).getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    const reopened = await screen.findByRole("dialog", { name: "Remove folder from household program" });

    await act(async () => { first.reject(new Error("Stale impact failed.")); await Promise.resolve(); });
    expect(within(reopened).getByText("Loading affected televisions…")).toBeVisible();
    expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(reopened).getByRole("button", { name: "Remove Trips" })).toBeDisabled();

    await act(async () => { second.resolve({ roots: [addedRoot], devices: [device] }); await Promise.resolve(); });
    expect(await within(reopened).findByText("Living Room")).toBeVisible();
  });

  it("does not let root A impact populate or enable root B after out-of-order resolution", async () => {
    const api = workbenchApi();
    const impactA = deferred<Awaited<ReturnType<AdminApi["rootImpact"]>>>();
    const impactB = deferred<Awaited<ReturnType<AdminApi["rootImpact"]>>>();
    vi.mocked(api.rootImpact).mockImplementationOnce(() => impactA.promise).mockImplementationOnce(() => impactB.promise);
    render(<SourceWorkbench source={source} roots={[addedRoot, albumsRoot]} devices={[device]} api={api} onChanged={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Trips" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Remove folder from household program" })).getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Review removal impact for Albums" }));
    const albumsDialog = await screen.findByRole("dialog", { name: "Remove folder from household program" });

    await act(async () => { impactA.resolve({ roots: [addedRoot], devices: [{ ...device, id: "tv-stale", name: "Stale TV" }] }); await Promise.resolve(); });
    expect(within(albumsDialog).getByText("Loading affected televisions…")).toBeVisible();
    expect(within(albumsDialog).queryByText("Stale TV")).not.toBeInTheDocument();
    expect(within(albumsDialog).getByRole("button", { name: "Remove Albums" })).toBeDisabled();

    const albumsDevice = { ...device, id: "tv-albums", name: "Family Room", assignedRootIds: [albumsRoot.id] };
    await act(async () => { impactB.resolve({ roots: [albumsRoot], devices: [albumsDevice] }); await Promise.resolve(); });
    expect(await within(albumsDialog).findByText("Family Room")).toBeVisible();
    expect(within(albumsDialog).getByRole("button", { name: "Remove Albums" })).toBeEnabled();
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
