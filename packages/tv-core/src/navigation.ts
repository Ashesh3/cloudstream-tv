export interface NavigationEntry {
  folderId: string | null;
  focusedItemId: string | null;
  focusedIndex: number;
  scrollTop: number;
  loadedPageCursors: (string | null)[];
}

export interface RestoredNavigationEntry extends NavigationEntry {
  focusedItemId: string | null;
}

export function pushNavigationEntry(
  stack: readonly NavigationEntry[],
  entry: NavigationEntry
): NavigationEntry[] {
  return [...stack, { ...entry }];
}

export function restoreNavigationEntry(
  entry: NavigationEntry,
  itemIds: readonly string[]
): RestoredNavigationEntry {
  if (itemIds.length === 0) {
    return { ...entry, focusedIndex: 0, focusedItemId: null };
  }
  const found = entry.focusedItemId ? itemIds.indexOf(entry.focusedItemId) : -1;
  const focusedIndex = found >= 0
    ? found
    : Math.min(Math.max(entry.focusedIndex, 0), itemIds.length - 1);
  return { ...entry, focusedIndex, focusedItemId: itemIds[focusedIndex] ?? null };
}

export function popNavigationEntry(stack: readonly NavigationEntry[]): {
  entry: NavigationEntry | null;
  stack: NavigationEntry[];
} {
  if (stack.length === 0) return { entry: null, stack: [] };
  return {
    entry: { ...stack[stack.length - 1]! },
    stack: stack.slice(0, -1).map(entry => ({ ...entry }))
  };
}
