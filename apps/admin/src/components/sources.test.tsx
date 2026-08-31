// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { AdminApiError, type AdminApi, type AdminImpact } from "../api/client";
import { Sources } from "./sources";

afterEach(cleanup);
const source: ControlSourceDto = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" };
const root: ControlRootDto = { id: "root-1", sourceId: source.id, displayName: "Family Photos", enabled: true, createdAt: source.createdAt };
const device: ControlDeviceDto = { id: "tv-1", name: "Living Room", enabled: true, assignedRootIds: [root.id], mediaOrder: null, slideshowSeconds: null, createdAt: source.createdAt, approvedAt: source.createdAt, revokedAt: null };
const api = (impact = { roots: [root], devices: [device] }) => ({ sourceImpact: vi.fn().mockResolvedValue(impact) }) as unknown as AdminApi;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function renderSources(overrides: Partial<React.ComponentProps<typeof Sources>> = {}) {
  return render(<Sources sources={[source]} roots={[root]} devices={[device]} api={api()} onRootAdded={vi.fn()} onRootRemoved={vi.fn()} onRemoveSource={vi.fn()} onAuthorize={vi.fn()} {...overrides} />);
}

describe("sources", () => {
  it.each([
    ["healthy", "Connected"],
    ["reauth-required", "Reauthorization required"],
    ["disabled", "Disabled"],
  ] as const)("renders %s as visible status text without a status Badge", (status, label) => {
    render(<Sources sources={[{ ...source, status }]} roots={[root]} devices={[device]} api={api()} onRootAdded={vi.fn()} onRootRemoved={vi.fn()} onRemoveSource={vi.fn()} onAuthorize={vi.fn()} />);
    const row = screen.getByTestId("source-row");
    expect(row).toHaveTextContent(label);
    expect(row).toHaveTextContent("1 approved folder");
    expect(document.querySelector('[data-slot="card"]')).not.toBeInTheDocument();
  });

  it("preserves reconnect identity and source removal impact", async () => {
    const authorize = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    render(<Sources sources={[source]} roots={[root]} devices={[device]} api={api()} onRootAdded={vi.fn()} onRootRemoved={vi.fn()} onRemoveSource={remove} onAuthorize={authorize} />);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect Home Drive" }));
    expect(authorize).toHaveBeenCalledWith("google", source.id);
    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Remove source" });
    expect(dialog).toHaveTextContent("Family Photos");
    expect(dialog).toHaveTextContent("Living Room");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove source permanently" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(source.id));
  });

  it("waits for removal impact before exposing the destructive confirmation", async () => {
    const impact = deferred<AdminImpact>();
    const sourceApi = api();
    vi.mocked(sourceApi.sourceImpact).mockReturnValue(impact.promise);
    renderSources({ api: sourceApi });

    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));

    expect(screen.queryByRole("alertdialog", { name: "Remove source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove source permanently" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading removal impact…")).toBeVisible();

    await act(async () => { impact.resolve({ roots: [root], devices: [device] }); await impact.promise; });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove source" });
    expect(within(dialog).getByRole("button", { name: "Remove source permanently" })).toBeEnabled();
  });

  it("surfaces an impact failure without exposing the destructive confirmation", async () => {
    const sourceApi = api();
    vi.mocked(sourceApi.sourceImpact).mockRejectedValue(new Error("private provider detail"));
    renderSources({ api: sourceApi });

    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Removal impact could not be loaded.");
    expect(screen.queryByRole("alertdialog", { name: "Remove source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove source permanently" })).not.toBeInTheDocument();
  });

  it("ignores a stale source impact response after another source is selected", async () => {
    const secondSource: ControlSourceDto = { ...source, id: "source-2", accountLabel: "Archive Drive" };
    const secondRoot: ControlRootDto = { ...root, id: "root-2", sourceId: secondSource.id, displayName: "Archive Photos" };
    const secondDevice: ControlDeviceDto = { ...device, id: "tv-2", name: "Family Room", assignedRootIds: [secondRoot.id] };
    const first = deferred<AdminImpact>();
    const second = deferred<AdminImpact>();
    const sourceApi = api();
    vi.mocked(sourceApi.sourceImpact).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    renderSources({ sources: [source, secondSource], roots: [root, secondRoot], devices: [device, secondDevice], api: sourceApi });

    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Archive Drive" }));
    await act(async () => { first.resolve({ roots: [root], devices: [{ ...device, name: "Stale TV" }] }); await first.promise; });
    expect(screen.queryByRole("alertdialog", { name: "Remove source" })).not.toBeInTheDocument();
    expect(screen.queryByText("Stale TV")).not.toBeInTheDocument();

    await act(async () => { second.resolve({ roots: [secondRoot], devices: [secondDevice] }); await second.promise; });
    const dialog = await screen.findByRole("alertdialog", { name: "Remove source" });
    expect(dialog).toHaveTextContent("Archive Drive");
    expect(dialog).toHaveTextContent("Archive Photos");
    expect(dialog).toHaveTextContent("Family Room");
    expect(dialog).not.toHaveTextContent("Stale TV");
  });

  it("routes a source-impact 401 through onUnauthorized without a generic error", async () => {
    const sourceApi = api();
    const onUnauthorized = vi.fn();
    vi.mocked(sourceApi.sourceImpact).mockRejectedValue(new AdminApiError(401, "ADMIN_UNAUTHORIZED", "Session expired."));
    renderSources({ api: sourceApi, onUnauthorized });

    fireEvent.click(screen.getByRole("button", { name: "Remove Home Drive" }));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog", { name: "Remove source" })).not.toBeInTheDocument();
  });

  it("moves the open workbench between the shell rail and the inline plane at the responsive boundary", async () => {
    let narrow = false;
    const listeners = new Set<() => void>();
    vi.spyOn(window, "matchMedia").mockImplementation(query => ({
      matches: query === "(max-width: 64rem)" ? narrow : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener as () => void),
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener as () => void),
      dispatchEvent: vi.fn(),
    }));
    const onWorkbenchOpen = vi.fn();
    const onWorkbenchClose = vi.fn();
    const workbenchApi = api() as AdminApi;
    workbenchApi.providerFolders = vi.fn().mockResolvedValue({ source, current: { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null }, breadcrumbs: [], folders: [], nextCursor: null });
    renderSources({ api: workbenchApi, onWorkbenchOpen, onWorkbenchClose });
    fireEvent.click(screen.getByRole("button", { name: "Browse & choose folders" }));
    expect(onWorkbenchOpen).toHaveBeenCalled();

    await act(async () => { narrow = true; listeners.forEach(listener => listener()); });
    expect(onWorkbenchClose).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Household folders" })).toBeVisible();

    await act(async () => { narrow = false; listeners.forEach(listener => listener()); });
    expect(onWorkbenchOpen.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onWorkbenchOpen).toHaveBeenLastCalledWith(expect.objectContaining({ source, roots: [root] }));
  });
});
