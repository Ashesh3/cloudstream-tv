// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlSourceDto, ProviderFolderDto } from "@cloudframe/shared";
import type { AdminApi, AdminProviderFolderPage } from "../api/client";
import { AdminApiError } from "../api/client";
import { ProviderFolderStage } from "./provider-folder-stage";

afterEach(cleanup);
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const root: ProviderFolderDto = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
const trips: ProviderFolderDto = { providerNodeId: "provider-trips", parentProviderId: root.providerNodeId, name: "Trips", assignedRootId: null };
function page(overrides: Partial<AdminProviderFolderPage> = {}): AdminProviderFolderPage { return { source, current: root, breadcrumbs: [root], folders: [], nextCursor: null, ...overrides }; }
function apiWithProviderFolders(providerFolders: AdminApi["providerFolders"]): AdminApi { return { installationStatus: vi.fn(), claimInstallation: vi.fn(), login: vi.fn(), logout: vi.fn(), snapshot: vi.fn(), transcodeStatus: vi.fn(), approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(), updateSettings: vi.fn(), rotatePassphrase: vi.fn(), authorizeSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(), providerFolders, createRoot: vi.fn().mockResolvedValue({ root: { id: "root-trips", sourceId: source.id, displayName: trips.name, enabled: true, createdAt: source.createdAt } }), rootImpact: vi.fn(), removeRoot: vi.fn() }; }

describe("provider folder stage", () => {
  it("shows provider-empty only after a successful live empty response", async () => {
    render(<ProviderFolderStage api={apiWithProviderFolders(vi.fn().mockResolvedValue(page()))} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    expect(await screen.findByText("This provider folder is empty")).toBeVisible();
  });

  it("uses a fixed safe transient error without persisting a fourth source state", async () => {
    render(<ProviderFolderStage api={apiWithProviderFolders(vi.fn().mockRejectedValue(new AdminApiError(503, "PROVIDER_UNAVAILABLE", "Provider temporarily unavailable. Try again.")))} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Provider temporarily unavailable");
    expect(screen.queryByText("This provider folder is empty")).not.toBeInTheDocument();
    expect(source.status).toBe("healthy");
  });

  it("aborts a stale live request when navigation changes", async () => {
    const signals: AbortSignal[] = [];
    const providerFolders = vi.fn((_sourceId: string, input: Parameters<AdminApi["providerFolders"]>[1]) => {
      signals.push(input.signal!);
      if (signals.length === 1) return Promise.resolve(page({ folders: [trips] }));
      return new Promise<AdminProviderFolderPage>(() => undefined);
    });
    render(<ProviderFolderStage api={apiWithProviderFolders(providerFolders)} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Trips" }));
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]!.aborted).toBe(true);
  });

  it("creates a root immediately and keeps the provider id only in the authenticated workbench callback", async () => {
    const api = apiWithProviderFolders(vi.fn().mockResolvedValue(page({ folders: [trips] })));
    const added = vi.fn().mockResolvedValue(undefined);
    render(<ProviderFolderStage api={api} source={source} selectedProviderNodeIds={new Set()} onRootAdded={added} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Trips to household program" }));
    await waitFor(() => expect(added).toHaveBeenCalledWith(expect.objectContaining({ id: "root-trips", displayName: "Trips" }), trips.providerNodeId));
    expect(screen.getByRole("button", { name: "Trips is in the household program" })).toBeDisabled();
  });

  it("does not update after unmount", async () => {
    let resolve!: (value: AdminProviderFolderPage) => void;
    const api = apiWithProviderFolders(vi.fn().mockReturnValue(new Promise(value => { resolve = value; })));
    const view = render(<ProviderFolderStage api={api} source={source} selectedProviderNodeIds={new Set()} onRootAdded={vi.fn().mockResolvedValue(undefined)} onClose={vi.fn()} />);
    view.unmount();
    await act(async () => { resolve(page()); await Promise.resolve(); });
  });
});
