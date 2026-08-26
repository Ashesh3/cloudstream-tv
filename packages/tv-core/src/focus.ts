export type FocusDirection = "left" | "right" | "up" | "down";

export interface GridFocusState {
  index: number;
  itemId?: string | null;
  itemCount: number;
  columns: number;
  hasNextPage?: boolean;
  needsPageExtension?: boolean;
  pendingIndex?: number;
}

export function moveFocus(state: GridFocusState, direction: FocusDirection): GridFocusState {
  const itemCount = Math.max(0, state.itemCount);
  const columns = Math.max(1, state.columns);
  if (itemCount === 0) return { ...state, index: 0, needsPageExtension: false };
  const index = clamp(state.index, 0, itemCount - 1);
  const column = index % columns;
  let next = index;
  let needsPageExtension = false;
  if (direction === "left" && column > 0) next -= 1;
  if (direction === "right" && column < columns - 1 && index + 1 < itemCount) next += 1;
  if (direction === "up" && index >= columns) next -= columns;
  if (direction === "down") {
    if (index + columns < itemCount) next += columns;
    else if (state.hasNextPage) {
      needsPageExtension = true;
      return { ...state, index, needsPageExtension, pendingIndex: index + columns };
    } else if (Math.floor(index / columns) < Math.floor((itemCount - 1) / columns)) next = itemCount - 1;
    else if (index === itemCount - 1) needsPageExtension = true;
  }
  return { ...state, index: next, needsPageExtension, pendingIndex: undefined };
}

export function resizeFocus(
  state: GridFocusState,
  columns: number,
  itemIds: readonly string[]
): GridFocusState {
  const itemId = state.itemId ?? itemIds[state.index] ?? null;
  const found = itemId ? itemIds.indexOf(itemId) : -1;
  const index = itemIds.length === 0
    ? 0
    : found >= 0
      ? found
      : clamp(state.index, 0, itemIds.length - 1);
  return {
    ...state,
    columns: Math.max(1, columns),
    itemCount: itemIds.length,
    index,
    itemId: itemIds[index] ?? null,
    needsPageExtension: false
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
