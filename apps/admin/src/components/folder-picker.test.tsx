// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminFolderTreeResponse, AssignedRootDto, MediaNodeDto, SourceDto } from "@cloudframe/shared";
import type { AdminApi } from "../api/client";
import { FolderPicker } from "./folder-picker";

afterEach(cleanup);
const source: SourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", accessTokenExpiresAt: null, nextSyncAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null, lastSyncErrorCode: null, createdAt: "2026-08-20T00:00:00.000Z" };
const root: AssignedRootDto = { id: "root-1", sourceId: source.id, providerNodeId: "provider-albums", displayName: "Albums", ancestryProviderIds: [], enabled: true, createdAt: "2026-08-20T00:00:00.000Z" };
const folder = (id: string, name: string, assignedRootId: string | null = null): AdminFolderTreeResponse["folders"][number] => ({ id, sourceId: source.id, provider: "google", parentNodeId: null, name, normalizedName: name.toLowerCase(), kind: "folder", mimeType: null, size: null, width: null, height: null, capturedAt: null, createdAtProvider: null, modifiedAtProvider: null, thumbnailRevision: null, hasPreview: true, folderCoverNodeIds: [`cover-${id}`], childFolderCount: 2, childMediaCount: 8, available: true, assignedRootId });

function pickerApi(): AdminApi {
  const album = folder("node-albums", "Albums", root.id);
  const trips = folder("node-trips", "Trips");
  return {
    login: vi.fn(), logout: vi.fn(), overview: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), settings: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), sources: vi.fn(), authorizeSource: vi.fn(), syncSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(),
    sourceTree: vi.fn().mockImplementation(async (_sourceId: string, parentId?: string) => parentId ? { source, parent: trips as MediaNodeDto, folders: [] } : { source, parent: null, folders: [album, trips] }),
    createRoot: vi.fn().mockResolvedValue({ root }),
    rootImpact: vi.fn().mockResolvedValue({ roots: [root], devices: [{ id: "device-1", name: "Living Room" }] }),
    removeRoot: vi.fn().mockResolvedValue({ removed: true, roots: [root], devices: [] }),
    thumbnailUrls: vi.fn().mockResolvedValue({ items: [{ nodeId: "cover-node-albums", status: "ready", url: "https://images.example/albums.jpg", expiresAt: "2026-08-26T01:00:00.000Z" }] })
  };
}

describe("indexed folder picker", () => {
  it("batches thumbnails, marks server-assigned roots, navigates folders, and adds a root", async () => {
    const api = pickerApi(); const changed = vi.fn().mockResolvedValue(undefined);
    render(<FolderPicker source={source} roots={[root]} api={api} onChanged={changed} onClose={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Open Albums" })).toBeVisible();
    expect(api.thumbnailUrls).toHaveBeenCalledWith(["cover-node-albums", "cover-node-trips"]);
    expect(within(screen.getByRole("button", { name: "Open Albums" }).closest("article")!).getByRole("button", { name: "Added" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open Trips" }));
    await waitFor(() => expect(api.sourceTree).toHaveBeenCalledWith(source.id, "node-trips"));
    fireEvent.click(screen.getByRole("button", { name: "Up one level" }));
    await screen.findByRole("button", { name: "Open Trips" });
    fireEvent.click(within(screen.getByRole("button", { name: "Open Trips" }).closest("article")!).getByRole("button", { name: "Add root" }));
    await waitFor(() => expect(api.createRoot).toHaveBeenCalledWith(source.id, { nodeId: "node-trips" }));
    expect(changed).toHaveBeenCalled();
  });

  it("loads impact, confirms root removal, and restores focus inside the parent sheet", async () => {
    const api = pickerApi(); const changed = vi.fn().mockResolvedValue(undefined);
    render(<FolderPicker source={source} roots={[root]} api={api} onChanged={changed} onClose={vi.fn()} />);
    const remove = await screen.findByRole("button", { name: "Remove root Albums" });
    remove.focus(); fireEvent.click(remove);
    const confirm = await screen.findByRole("dialog", { name: "Remove root" });
    expect(within(confirm).getByText("Living Room")).toBeVisible();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(remove).toHaveFocus());
    expect(screen.getByRole("dialog", { name: "Choose source folders" })).toBeVisible();
    fireEvent.click(remove);
    fireEvent.click((await screen.findByRole("dialog", { name: "Remove root" })).querySelector<HTMLButtonElement>(".danger")!);
    await waitFor(() => expect(api.removeRoot).toHaveBeenCalledWith(root.id));
  });
});

