// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("keeps deterministic grid cells and exactly one roving focus target", () => {
    render(
      <VirtualGrid
        ariaLabel="Media"
        items={items.slice(0, 4)}
        focusedIndex={2}
        columns={4}
        rowHeight={200}
        viewportHeight={400}
        onFocusedIndexChange={vi.fn()}
        renderItem={(item, state) => (
          <button aria-label={item.label} tabIndex={state.focused ? 0 : -1}>{item.label}</button>
        )}
      />
    );

    const grid = screen.getByRole("grid", { name: "Media" });
    expect(grid.querySelectorAll("[role='gridcell']")).toHaveLength(4);
    expect(grid.querySelectorAll("[data-grid-focused='true']")).toHaveLength(1);
    expect(grid.querySelectorAll("button[tabindex='0']")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Item 2" })).toHaveAttribute("tabindex", "0");
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
  it("keeps the native one-button remote focus contract on collection cards", () => {
    const view = render(<FolderCard name="Trips" subtitle="Google Drive · Home" focused />);
    const card = screen.getByRole("button", { name: "Trips, folder" });

    expect(card).toHaveAttribute("tabindex", "0");
    expect(card).toHaveClass("is-focused");
    expect(card).toHaveClass("cloudframe-card");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText("Google Drive · Home")).toBeVisible();

    view.rerender(<FolderCard name="Trips" subtitle="Google Drive · Home" focused={false} />);
    expect(card).toHaveAttribute("tabindex", "-1");
    expect(card).not.toHaveClass("is-focused");
  });

  it("uses stable static collection artwork without preview mosaics", () => {
    render(<FolderCard name="Trips" focused={false} />);
    const card = screen.getByRole("button", { name: /Trips/ });
    expect(card.querySelector(".folder-art")).toBeInTheDocument();
    expect(card.querySelector(".folder-mosaic")).not.toBeInTheDocument();
    expect(card.querySelectorAll("img")).toHaveLength(0);
  });

  it("renders a no-referrer folder preview and restores stock art after an image failure", () => {
    const view = render(
      <FolderCard
        name="Trips"
        thumbnailUrl="https://provider.example/folder-old"
        focused={false}
      />
    );
    const oldImage = document.querySelector(".folder-art img")!;
    expect(oldImage).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(oldImage).toHaveAttribute("src", "https://provider.example/folder-old");

    fireEvent.error(oldImage);
    expect(document.querySelector(".folder-art img")).not.toBeInTheDocument();
    expect(screen.getByText("Cloudframe folder")).toBeVisible();

    view.rerender(
      <FolderCard
        name="Trips"
        thumbnailUrl="https://provider.example/folder-fresh"
        focused={false}
      />
    );
    expect(document.querySelector(".folder-art img")).toHaveAttribute(
      "src",
      "https://provider.example/folder-fresh",
    );
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
    expect(screen.getByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuemin", "0");
    expect(screen.getByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuemax", "100");
    expect(screen.getByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuenow", "35");
  });

  it("clamps resume progress and omits the indicator at zero", () => {
    const view = render(<MediaCard name="Sunset clip" kind="video" focused resumeProgress={2} />);
    expect(screen.getByRole("progressbar", { name: "Watched" })).toHaveAttribute("aria-valuenow", "100");

    view.rerender(<MediaCard name="Sunset clip" kind="video" focused resumeProgress={-1} />);
    expect(screen.queryByRole("progressbar", { name: "Watched" })).not.toBeInTheDocument();
  });

  it("keeps the native one-button remote focus contract on media cards", () => {
    const view = render(<MediaCard name="Lake" kind="image" focused />);
    const card = screen.getByRole("button", { name: "Lake, image" });

    expect(card).toHaveAttribute("tabindex", "0");
    expect(card).toHaveClass("is-focused");
    expect(card).toHaveClass("cloudframe-card");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getAllByText("Photo").length).toBeGreaterThan(0);

    view.rerender(<MediaCard name="Lake" kind="image" focused={false} />);
    expect(card).toHaveAttribute("tabindex", "-1");
    expect(card).not.toHaveClass("is-focused");
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
