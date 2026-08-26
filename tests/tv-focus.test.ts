import { describe, expect, it } from "vitest";

import {
  moveFocus,
  normalizeTvKey,
  popNavigationEntry,
  pushNavigationEntry,
  restoreNavigationEntry,
  resizeFocus,
  shouldHandleTvKey
} from "@cloudframe/tv-core";

describe("TV remote key normalization", () => {
  it.each([
    [{ key: "ArrowLeft" }, "left"],
    [{ keyCode: 39 }, "right"],
    [{ keyCode: 65362 }, "up"],
    [{ keyCode: 65364 }, "down"],
    [{ key: "Enter" }, "enter"],
    [{ keyCode: 13 }, "enter"],
    [{ key: "Escape" }, "back"],
    [{ key: "Backspace" }, "back"],
    [{ keyCode: 461 }, "back"],
    [{ keyCode: 10009 }, "back"],
    [{ keyCode: 10182 }, "exit"],
    [{ keyCode: 457 }, "menu"],
    [{ keyCode: 415 }, "play"],
    [{ keyCode: 19 }, "pause"],
    [{ keyCode: 10252 }, "play-pause"]
  ] as const)("normalizes %#", (event, action) => {
    expect(normalizeTvKey(event)).toBe(action);
  });

  it("allows repeated movement but suppresses repeated actions", () => {
    expect(shouldHandleTvKey("left", true)).toBe(true);
    expect(shouldHandleTvKey("enter", true)).toBe(false);
    expect(shouldHandleTvKey("back", true)).toBe(false);
    expect(shouldHandleTvKey("menu", true)).toBe(false);
    expect(shouldHandleTvKey("play-pause", true)).toBe(false);
  });
});

describe("explicit grid focus", () => {
  const start = { index: 5, itemCount: 10, columns: 4 };

  it("moves spatially without wrapping rows", () => {
    expect(moveFocus(start, "left").index).toBe(4);
    expect(moveFocus(start, "right").index).toBe(6);
    expect(moveFocus({ ...start, index: 4 }, "left").index).toBe(4);
    expect(moveFocus({ ...start, index: 7 }, "right").index).toBe(7);
  });

  it("clamps incomplete-row vertical movement to the final item", () => {
    expect(moveFocus({ ...start, index: 6 }, "down").index).toBe(9);
    expect(moveFocus({ ...start, index: 9 }, "up").index).toBe(5);
    expect(moveFocus({ ...start, index: 1 }, "up").index).toBe(1);
  });

  it("requests one page extension only when moving down from the final row", () => {
    expect(moveFocus({ ...start, index: 9 }, "down")).toMatchObject({
      index: 9,
      needsPageExtension: true
    });
    expect(moveFocus({ ...start, index: 4 }, "down").needsPageExtension).toBe(false);
  });

  it("requests the missing same-column destination from any incomplete final-row cell", () => {
    expect(moveFocus({ ...start, index: 8, hasNextPage: true }, "down")).toMatchObject({
      index: 8,
      needsPageExtension: true,
      pendingIndex: 12
    });
    expect(moveFocus({ ...start, index: 9, hasNextPage: true }, "down")).toMatchObject({
      index: 9,
      needsPageExtension: true,
      pendingIndex: 13
    });
  });

  it("preserves the focused item across column changes", () => {
    const result = resizeFocus(
      { index: 7, itemId: "node-7", itemCount: 12, columns: 4 },
      3,
      Array.from({ length: 12 }, (_, index) => `node-${index}`)
    );
    expect(result).toMatchObject({ index: 7, itemId: "node-7", columns: 3 });
  });
});

describe("folder navigation restoration", () => {
  it("pops the newest folder while preserving older history", () => {
    expect(popNavigationEntry([
      { folderId: null, focusedItemId: "a", focusedIndex: 0, scrollTop: 0, loadedPageCursors: [] },
      { folderId: "a", focusedItemId: "b", focusedIndex: 4, scrollTop: 300, loadedPageCursors: [null, "page"] }
    ])).toMatchObject({
      entry: { folderId: "a", focusedItemId: "b" },
      stack: [{ folderId: null, focusedItemId: "a" }]
    });
  });

  it("records exact focus, scroll, and loaded-page cursor", () => {
    const stack = pushNavigationEntry([], {
      folderId: "root-a",
      focusedItemId: "folder-child",
      focusedIndex: 8,
      scrollTop: 720,
      loadedPageCursors: [null, "page-1", "page-2"]
    });
    expect(stack).toEqual([{
      folderId: "root-a",
      focusedItemId: "folder-child",
      focusedIndex: 8,
      scrollTop: 720,
      loadedPageCursors: [null, "page-1", "page-2"]
    }]);
  });

  it("restores by item ID when content order changes", () => {
    expect(restoreNavigationEntry({
      folderId: "root-a",
      focusedItemId: "folder-child",
      focusedIndex: 8,
      scrollTop: 720,
      loadedPageCursors: [null, "page-1", "page-2"]
    }, ["other", "folder-child", "later"])).toMatchObject({
      focusedIndex: 1,
      focusedItemId: "folder-child",
      scrollTop: 720,
      loadedPageCursors: [null, "page-1", "page-2"]
    });
  });

  it("falls back to the saved index when the item disappeared", () => {
    expect(restoreNavigationEntry({
      folderId: "root-a",
      focusedItemId: "gone",
      focusedIndex: 8,
      scrollTop: 720,
      loadedPageCursors: [null]
    }, ["a", "b", "c"])).toMatchObject({ focusedIndex: 2, focusedItemId: "c" });
  });
});
