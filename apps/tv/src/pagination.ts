export interface PageProximityInput {
  itemCount: number;
  columns: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  focusedIndex: number;
}

export function shouldPrefetchNextPage(input: PageProximityInput): boolean {
  const columns = Math.max(1, input.columns);
  const totalRows = Math.ceil(Math.max(0, input.itemCount) / columns);
  if (totalRows === 0) return false;
  const thresholdRow = Math.max(0, totalRows - 2);
  const rowHeight = Math.max(1, input.rowHeight);
  const visibleStart = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
  const visibleRows = Math.max(1, Math.ceil(Math.max(1, input.viewportHeight) / rowHeight));
  const visibleEnd = Math.min(totalRows - 1, visibleStart + visibleRows - 1);
  const focusedRow = Math.floor(
    Math.max(0, Math.min(input.focusedIndex, Math.max(0, input.itemCount - 1))) /
      columns,
  );
  return focusedRow >= thresholdRow || visibleEnd >= thresholdRow;
}

interface IdlePrefetchScheduler {
  requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout(callback: () => void, delay: number): number;
  clearTimeout(handle: number): void;
}

export function scheduleIdlePrefetch(
  callback: () => void,
  scheduler: IdlePrefetchScheduler = browserScheduler(),
): () => void {
  if (scheduler.requestIdleCallback && scheduler.cancelIdleCallback) {
    const handle = scheduler.requestIdleCallback(callback, { timeout: 1_000 });
    return () => scheduler.cancelIdleCallback?.(handle);
  }
  const handle = scheduler.setTimeout(callback, 250);
  return () => scheduler.clearTimeout(handle);
}

function browserScheduler(): IdlePrefetchScheduler {
  const host = window as Window & {
    requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  return {
    requestIdleCallback: host.requestIdleCallback?.bind(host),
    cancelIdleCallback: host.cancelIdleCallback?.bind(host),
    setTimeout: host.setTimeout.bind(host),
    clearTimeout: host.clearTimeout.bind(host),
  };
}
