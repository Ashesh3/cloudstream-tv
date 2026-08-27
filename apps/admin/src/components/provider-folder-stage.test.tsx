// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminProviderFolderPageResponse, SourceDto, SourceIndexStateDto } from "@cloudframe/shared";
import type { AdminApi } from "../api/client";
import { IndexStatus } from "./index-status";
import { ProviderFolderStage } from "./provider-folder-stage";

afterEach(cleanup);

const source: SourceDto = {
  id: "source-1",
  provider: "google",
  accountLabel: "Home Drive",
  status: "healthy",
  accessTokenExpiresAt: null,
  nextSyncAt: null,
  lastSyncStartedAt: null,
  lastSyncCompletedAt: null,
  lastSyncErrorCode: null,
  indexProgress: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  providerRootId: "provider-root",
  indexState: { kind: "healthy", processedNodeCount: 0, pendingFolderCount: 0, recoverable: false, errorCode: null }
};

function page(overrides: Partial<AdminProviderFolderPageResponse> = {}): AdminProviderFolderPageResponse {
  const current = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
  return { source, current, breadcrumbs: [current], folders: [], nextCursor: null, ...overrides };
}

function apiWithProviderFolders(providerFolders: AdminApi["providerFolders"]): AdminApi {
  return {
    login: vi.fn(), logout: vi.fn(), overview: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), settings: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), sources: vi.fn(), authorizeSource: vi.fn(), syncSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(), sourceTree: vi.fn(), providerFolders,
    createRoot: vi.fn(), rootImpact: vi.fn(), removeRoot: vi.fn(), thumbnailUrls: vi.fn()
  };
}

describe("live provider folder stage", () => {
  it("shows provider-empty only after a successful live empty response", async () => {
    const api = apiWithProviderFolders(vi.fn().mockResolvedValue(page()));
    render(<ProviderFolderStage api={api} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText("This provider folder is empty")).toBeVisible();
    expect(screen.queryByText(/indexing selected folders/i)).not.toBeInTheDocument();
  });

  it("keeps a provider failure distinct from a successful empty response", async () => {
    const api = apiWithProviderFolders(vi.fn().mockRejectedValue(Object.assign(new Error("Provider request failed."), { code: "PROVIDER_UNAVAILABLE" })));
    render(<ProviderFolderStage api={api} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText("Folder listing failed")).toBeVisible();
    expect(screen.queryByText("This provider folder is empty")).not.toBeInTheDocument();
  });

  it("aborts a stale live request when navigation changes", async () => {
    const albums = { providerNodeId: "albums", parentProviderId: "provider-root", name: "Albums", assignedRootId: null };
    let staleSignal: AbortSignal | undefined;
    const providerFolders = vi.fn(async (_sourceId: string, input: Parameters<AdminApi["providerFolders"]>[1]) => {
      if (!input.providerFolderId && !input.cursor) return page({ folders: [albums] });
      staleSignal = input.signal;
      return new Promise<AdminProviderFolderPageResponse>(() => undefined);
    });
    render(<ProviderFolderStage api={apiWithProviderFolders(providerFolders)} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Albums" }));
    await waitFor(() => expect(staleSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "My Drive" }));

    await waitFor(() => expect(staleSignal?.aborted).toBe(true));
  });

  it.each<[SourceIndexStateDto["kind"], string]>([
    ["quota-exhausted", "Cloudframe indexing is paused by Firestore quota"],
    ["indexing", "Indexing selected folders"],
    ["reauth-required", "Reconnect this account"],
    ["provider-error", "Folder listing failed"]
  ])("renders %s separately", (kind, copy) => {
    render(<IndexStatus state={{ kind, processedNodeCount: 42, pendingFolderCount: 3, recoverable: true, errorCode: null }} />);
    expect(screen.getByText(copy)).toBeVisible();
    expect(screen.queryByText("This provider folder is empty")).not.toBeInTheDocument();
  });
});
