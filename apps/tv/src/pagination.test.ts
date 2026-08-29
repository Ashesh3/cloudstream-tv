import { describe, expect, it, vi } from "vitest";

import { scheduleIdlePrefetch, shouldPrefetchNextPage } from "./pagination";

describe("next-page proximity", () => {
  it("stays idle in the middle of a loaded folder", () => {
    expect(shouldPrefetchNextPage({
      itemCount: 50,
      columns: 5,
      rowHeight: 200,
      viewportHeight: 400,
      scrollTop: 400,
      focusedIndex: 12,
    })).toBe(false);
  });

  it("prefetches when focus enters the final two loaded rows", () => {
    expect(shouldPrefetchNextPage({
      itemCount: 50,
      columns: 5,
      rowHeight: 200,
      viewportHeight: 400,
      scrollTop: 400,
      focusedIndex: 41,
    })).toBe(true);
  });

  it("prefetches when scrolling exposes the final two loaded rows", () => {
    expect(shouldPrefetchNextPage({
      itemCount: 50,
      columns: 5,
      rowHeight: 200,
      viewportHeight: 400,
      scrollTop: 1_400,
      focusedIndex: 0,
    })).toBe(true);
  });
});

describe("idle page prefetch", () => {
  it("uses requestIdleCallback when available and can cancel it", () => {
    const callback = vi.fn();
    const requestIdleCallback = vi.fn(() => 17);
    const cancelIdleCallback = vi.fn();
    const cancel = scheduleIdlePrefetch(callback, {
      requestIdleCallback,
      cancelIdleCallback,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    });

    expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), { timeout: 1_000 });
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(17);
    expect(callback).not.toHaveBeenCalled();
  });

  it("falls back to a cancellable timeout", () => {
    const callback = vi.fn();
    let scheduled: (() => void) | undefined;
    const clearTimeout = vi.fn();
    const cancel = scheduleIdlePrefetch(callback, {
      setTimeout(handler) {
        scheduled = handler;
        return 9;
      },
      clearTimeout,
    });

    expect(callback).not.toHaveBeenCalled();
    scheduled?.();
    expect(callback).toHaveBeenCalledTimes(1);
    cancel();
    expect(clearTimeout).toHaveBeenCalledWith(9);
  });
});
