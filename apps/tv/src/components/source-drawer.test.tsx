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

describe("source drawer remote focus", () => {
  it("focuses the first action and traps directional focus within the drawer", async () => {
    render(<SourceDrawer open roots={roots} onClose={vi.fn()} onHome={vi.fn()} onSelect={vi.fn()} />);
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
});
