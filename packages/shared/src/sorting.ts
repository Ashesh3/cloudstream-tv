import type { TvBrowseItemDto } from "./api";
import type { MediaOrder } from "./contracts";

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

type SortableBrowseItem = Pick<TvBrowseItemDto, "kind" | "name" | "capturedAt" | "createdAtProvider" | "modifiedAtProvider">;

function effectiveBrowseTime(item: SortableBrowseItem): number {
  const value = item.capturedAt ?? item.createdAtProvider ?? item.modifiedAtProvider;
  return value === null ? 0 : Date.parse(value);
}

function compareName(left: SortableBrowseItem, right: SortableBrowseItem): number {
  return collator.compare(left.name, right.name);
}

function compareBrowseMedia(left: SortableBrowseItem, right: SortableBrowseItem, order: MediaOrder): number {
  if (order === "name-asc") return compareName(left, right);
  const difference = effectiveBrowseTime(left) - effectiveBrowseTime(right);
  return order === "captured-desc" ? -difference : difference;
}

export function sortBrowseItems<T extends SortableBrowseItem>(items: readonly T[], order: MediaOrder): T[] {
  return items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => {
      const leftIsFolder = left.item.kind === "folder";
      const rightIsFolder = right.item.kind === "folder";
      if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1;
      const comparison = leftIsFolder
        ? compareName(left.item, right.item)
        : compareBrowseMedia(left.item, right.item, order);
      return comparison || left.originalIndex - right.originalIndex;
    })
    .map(entry => entry.item);
}
