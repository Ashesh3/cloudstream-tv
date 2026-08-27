// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach } from "vitest";
import { describe, expect, it, vi } from "vitest";

import { FolderCard } from "./folder-card";
import { MediaCard } from "./media-card";
import { VirtualGrid, calculateVirtualWindow } from "./virtual-grid";

const items = Array.from({ length: 30 }, (_, index) => ({
  id: `item-${index}`,
  label: `Item ${index}`
}));

afterEach(cleanup);

describe("virtualized TV grid", () => {
  it("renders the visible rows plus two overscan rows", () => {
    expect(calculateVirtualWindow({
      itemCount: 30,
      columns: 4,
      rowHeight: 200,
      viewportHeight: 400,
      scrollTop: 600,
      overscanRows: 2,
      focusedIndex: 13
    })).toEqual({ startIndex: 4, endIndex: 28, totalRows: 8 });
  });

  it("always mounts a focused destination outside the current window", () => {
    const window = calculateVirtualWindow({
      itemCount: 100,
      columns: 5,
      rowHeight: 180,
      viewportHeight: 360,
      scrollTop: 0,
      overscanRows: 2,
      focusedIndex: 73
    });
    expect(window.startIndex).toBeLessThanOrEqual(73);
    expect(window.endIndex).toBeGreaterThan(73);
  });

  it("reports mounted IDs and keyboard focus changes", () => {
    const mounted = vi.fn();
    const focus = vi.fn();
    const { rerender } = render(
      <VirtualGrid
        ariaLabel="Media"
        items={items}
        focusedIndex={0}
        columns={4}
        rowHeight={200}
        viewportHeight={400}
        scrollTop={0}
        onMountedItemsChange={mounted}
        onFocusedIndexChange={focus}
        renderItem={(item, state) => (
          <button data-testid={item.id} data-focused={state.focused}>{item.label}</button>
        )}
      />
    );
    expect(mounted.mock.calls.at(-1)?.[0]).toEqual(items.slice(0, 16).map(item => item.id));
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowRight" });
    expect(focus).toHaveBeenCalledWith(1);

    rerender(
      <VirtualGrid
        ariaLabel="Media"
        items={items}
        focusedIndex={20}
        columns={4}
        rowHeight={200}
        viewportHeight={400}
        scrollTop={0}
        onMountedItemsChange={mounted}
        onFocusedIndexChange={focus}
        renderItem={(item, state) => (
          <button data-testid={item.id} data-focused={state.focused}>{item.label}</button>
        )}
      />
    );
    expect(screen.getByTestId("item-20")).toBeInTheDocument();
  });

  it("requests a page when Down has no loaded destination in an incomplete final row", () => {
    const focus = vi.fn();
    render(
      <VirtualGrid
        ariaLabel="Media"
        items={items.slice(0, 10)}
        focusedIndex={8}
        columns={4}
        rowHeight={200}
        viewportHeight={400}
        hasNextPage
        onFocusedIndexChange={focus}
        renderItem={(item, state) => <button data-focused={state.focused}>{item.label}</button>}
      />
    );
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    expect(focus).toHaveBeenCalledWith(8, true, 12);
  });
});

describe("folder artwork and media cards", () => {
  it("uses stable static collection artwork without preview mosaics", () => {
    render(<FolderCard name="Trips" focused={false} />);
    const card = screen.getByRole("button", { name: /Trips/ });
    expect(card.querySelector(".folder-art")).toBeInTheDocument();
    expect(card.querySelector(".folder-mosaic")).not.toBeInTheDocument();
    expect(card.querySelectorAll("img")).toHaveLength(0);
  });

  it("shows video identity and resume progress without hover", () => {
    render(
      <MediaCard
        name="Sunset clip"
        kind="video"
        thumbnailUrl="preview"
        focused
        resumeProgress={0.35}
      />
    );
    expect(screen.getByText("Video")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "35");
  });

  it("uses no-referrer thumbnails and recovers when a fresh URL replaces a failed one", () => {
    const view = render(<MediaCard name="Lake" kind="image" thumbnailUrl="https://provider.example/old" focused={false} />);
    const oldImage = document.querySelector("img")!;
    expect(oldImage).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.error(oldImage);
    expect(document.querySelector("img")).not.toBeInTheDocument();

    view.rerender(<MediaCard name="Lake" kind="image" thumbnailUrl="https://provider.example/fresh" focused={false} />);
    expect(document.querySelector("img")).toHaveAttribute("src", "https://provider.example/fresh");
  });
});
