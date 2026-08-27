// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceDrawer } from "./source-drawer";

afterEach(cleanup);

const roots = [
  { id: "root-1", sourceId: "s1", displayName: "Family", provider: "google" as const, accountLabel: "Home", nodeId: "n1", folderCoverNodeIds: [], childFolderCount: 1, childMediaCount: 2, readiness: "ready" as const, readinessMessage: "Ready to screen" },
  { id: "root-2", sourceId: "s2", displayName: "Trips", provider: "onedrive" as const, accountLabel: "Cloud", nodeId: "n2", folderCoverNodeIds: [], childFolderCount: 2, childMediaCount: 4, readiness: "ready" as const, readinessMessage: "Ready to screen" }
];

const mixedRoots = [
  { ...roots[0]!, id: "root-preparing", displayName: "Preparing", nodeId: null, readiness: "preparing" as const, readinessMessage: "Preparing this collection" },
  { ...roots[0]!, id: "root-family", displayName: "Family", nodeId: "n-family" },
  { ...roots[1]!, id: "root-blocked", displayName: "Blocked", nodeId: null, readiness: "blocked" as const, readinessMessage: "Indexing is paused by storage quota" },
  { ...roots[1]!, id: "root-trips", displayName: "Trips", nodeId: "n-trips" }
];

describe("source drawer remote focus", () => {
  it("focuses the first action and traps directional focus within the drawer", async () => {
    render(<SourceDrawer open roots={roots} onClose={vi.fn()} onHome={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Choose a collection" })).toBeVisible();
    expect(screen.queryByText("Program desk")).not.toBeInTheDocument();
    const all = screen.getAllByRole("button");
    await waitFor(() => expect(all[0]).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "ArrowDown" });
    expect(all[1]).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Sources" }), { key: "ArrowDown" });
    expect(all.at(-1)).toHaveFocus();
  });

  it("handles Enter and Back without bubbling to the grid", async () => {
    const close = vi.fn();
    const home = vi.fn();
    const bubbled = vi.fn();
    render(<div onKeyDown={bubbled}><SourceDrawer open roots={roots} onClose={close} onHome={home} onSelect={vi.fn()} /></div>);
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    await waitFor(() => expect(screen.getAllByRole("button")[0]).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(2);
    expect(home).not.toHaveBeenCalled();
    expect(bubbled).not.toHaveBeenCalled();
  });

  it("keeps unready programs visible but skips them in remote focus order", async () => {
    const select = vi.fn();
    render(<SourceDrawer open roots={mixedRoots} onClose={vi.fn()} onHome={vi.fn()} onSelect={select} />);
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    const close = screen.getByRole("button", { name: /Close/ });
    const home = screen.getByRole("button", { name: "Household program" });
    const preparing = screen.getByRole("button", { name: /Preparing/ });
    const family = screen.getByRole("button", { name: /Family/ });
    const blocked = screen.getByRole("button", { name: /Blocked/ });
    const trips = screen.getByRole("button", { name: /Trips/ });

    await waitFor(() => expect(close).toHaveFocus());
    expect(preparing).toBeVisible();
    expect(blocked).toBeVisible();
    expect(preparing).toHaveAttribute("tabindex", "-1");
    expect(blocked).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(home).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(family).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(trips).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(family).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "End" });
    expect(trips).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Home" });
    expect(close).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "End" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "root-trips" }));
  });

  it("keeps a zero-ready drawer dismissible without focusing unavailable programs", async () => {
    const close = vi.fn();
    const bubbled = vi.fn();
    const unavailable = mixedRoots.filter(root => root.readiness !== "ready");
    render(<div onKeyDown={bubbled}><SourceDrawer open roots={unavailable} onClose={close} onHome={vi.fn()} onSelect={vi.fn()} /></div>);
    const dialog = screen.getByRole("dialog", { name: "Sources" });
    const closeButton = screen.getByRole("button", { name: /Close/ });
    const home = screen.getByRole("button", { name: "Household program" });

    await waitFor(() => expect(closeButton).toHaveFocus());
    unavailable.forEach(root => {
      expect(screen.getByRole("button", { name: new RegExp(root.displayName) })).toHaveAttribute("tabindex", "-1");
    });
    fireEvent.keyDown(dialog, { key: "End" });
    expect(home).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(home).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(bubbled).not.toHaveBeenCalled();
  });
});
