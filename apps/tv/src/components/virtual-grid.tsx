import type { ComponentChild } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { moveFocus, normalizeTvKey, shouldHandleTvKey } from "@cloudframe/tv-core";

export interface VirtualGridItem {
  id: string;
}

export interface VirtualWindowInput {
  itemCount: number;
  columns: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop: number;
  overscanRows?: number;
  focusedIndex: number;
}

export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  totalRows: number;
}

interface VirtualGridProps<T extends VirtualGridItem> {
  ariaLabel: string;
  items: T[];
  focusedIndex: number;
  columns: number;
  rowHeight: number;
  viewportHeight: number;
  scrollTop?: number;
  hasNextPage?: boolean;
  focusRevision?: number;
  onScrollTopChange?: (value: number) => void;
  onFocusedIndexChange: (index: number, needsPageExtension?: boolean, pendingIndex?: number) => void;
  onMountedItemsChange?: (ids: string[]) => void;
  onSelect?: (item: T, index: number) => void;
  onBack?: () => boolean | void;
  renderItem: (item: T, state: { focused: boolean; index: number }) => ComponentChild;
}

export function calculateVirtualWindow(input: VirtualWindowInput): VirtualWindow {
  const columns = Math.max(1, input.columns);
  const totalRows = Math.ceil(input.itemCount / columns);
  if (totalRows === 0) return { startIndex: 0, endIndex: 0, totalRows: 0 };
  const rowHeight = Math.max(1, input.rowHeight);
  const visibleStart = Math.floor(Math.max(0, input.scrollTop) / rowHeight);
  const visibleRows = Math.max(1, Math.ceil(input.viewportHeight / rowHeight));
  const overscan = input.overscanRows ?? 2;
  let startRow = Math.max(0, visibleStart - overscan);
  let endRow = Math.min(totalRows, visibleStart + visibleRows + overscan);
  const focusedRow = Math.floor(Math.max(0, input.focusedIndex) / columns);
  if (focusedRow < startRow) startRow = focusedRow;
  if (focusedRow >= endRow) endRow = Math.min(totalRows, focusedRow + 1);
  return {
    startIndex: startRow * columns,
    endIndex: Math.min(input.itemCount, endRow * columns),
    totalRows
  };
}

export function VirtualGrid<T extends VirtualGridItem>(props: VirtualGridProps<T>) {
  const container = useRef<HTMLDivElement>(null);
  const scrollTop = props.scrollTop ?? 0;
  const window = calculateVirtualWindow({
    itemCount: props.items.length,
    columns: props.columns,
    rowHeight: props.rowHeight,
    viewportHeight: props.viewportHeight,
    scrollTop,
    focusedIndex: props.focusedIndex,
    overscanRows: 2
  });
  const mounted = props.items.slice(window.startIndex, window.endIndex);
  const startRow = Math.floor(window.startIndex / Math.max(1, props.columns));

  useEffect(() => {
    props.onMountedItemsChange?.(mounted.map(item => item.id));
  }, [window.startIndex, window.endIndex, props.items]);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const focused = host.querySelector<HTMLElement>("[data-grid-focused='true'] button, [data-grid-focused='true'] [tabindex]");
    focused?.focus();
  }, [props.focusedIndex, props.focusRevision, window.startIndex, window.endIndex]);

  return (
    <div
      ref={container}
      className="virtual-grid-viewport"
      role="grid"
      aria-label={props.ariaLabel}
      style={{ height: `${props.viewportHeight}px` }}
      onScroll={event => props.onScrollTopChange?.(event.currentTarget.scrollTop)}
      onKeyDown={event => {
        const action = normalizeTvKey(event);
        if (!action || !shouldHandleTvKey(action, event.repeat)) return;
        if (action === "enter") {
          const item = props.items[props.focusedIndex];
          if (item) props.onSelect?.(item, props.focusedIndex);
        } else if (action === "back") {
          if (!props.onBack || props.onBack() === false) return;
        } else if (action === "left" || action === "right" || action === "up" || action === "down") {
          const next = moveFocus({
            index: props.focusedIndex,
            itemCount: props.items.length,
            columns: props.columns,
            hasNextPage: props.hasNextPage
          }, action);
          if (next.needsPageExtension) props.onFocusedIndexChange(next.index, true, next.pendingIndex);
          else props.onFocusedIndexChange(next.index);
        } else return;
        event.preventDefault();
      }}
    >
      <div className="virtual-grid-spacer" style={{ height: `${window.totalRows * props.rowHeight}px` }}>
        <div
          className="virtual-grid"
          style={{
            gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))`,
            transform: `translateY(${startRow * props.rowHeight}px)`
          }}
        >
          {mounted.map((item, offset) => {
            const index = window.startIndex + offset;
            const focused = index === props.focusedIndex;
            return (
              <div role="gridcell" key={item.id} data-grid-focused={focused ? "true" : "false"}>
                {props.renderItem(item, { focused, index })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
