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
});

describe("folder mosaics and media cards", () => {
  it.each([
    [3, "three"],
    [2, "two"],
    [1, "one"],
    [0, "zero"]
  ] as const)("uses the %s-preview mosaic without repeating images", (count, variant) => {
    const thumbnails = Array.from({ length: count }, (_, index) => ({
      nodeId: `cover-${index}`,
      url: `https://images.invalid/${index}.jpg`
    }));
    render(<FolderCard name={`Folder ${count}`} thumbnails={thumbnails} focused={false} />);
    const card = screen.getByRole("button", { name: new RegExp(`Folder ${count}`) });
    expect(card).toHaveAttribute("data-mosaic", variant);
    expect(card.querySelectorAll("img")).toHaveLength(count);
  });

  it("keeps a broken cover pane and marks it unavailable", () => {
    render(<FolderCard name="Trips" thumbnails={[{ nodeId: "cover", url: "broken" }]} focused={false} />);
    const image = document.querySelector("img")!;
    fireEvent.error(image);
    expect(image.parentElement).toHaveAttribute("data-preview", "unavailable");
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
});
