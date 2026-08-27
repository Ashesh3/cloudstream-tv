import type { TvBrowseItemDto } from "./api";
import type { MediaNode, MediaOrder } from "./contracts";

const collator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true
});

type SortableBrowseItem = Pick<
  TvBrowseItemDto,
  | "kind"
  | "name"
  | "capturedAt"
  | "createdAtProvider"
  | "modifiedAtProvider"
>;

function effectiveBrowseTime(item: SortableBrowseItem): number {
  const value =
    item.capturedAt ?? item.createdAtProvider ?? item.modifiedAtProvider;
  return value === null ? 0 : Date.parse(value);
}

function effectiveMediaTime(node: MediaNode): number {
  return (
    node.capturedAt ??
    node.createdAtProvider ??
    node.modifiedAtProvider ??
    new Date(0)
  ).getTime();
}

function compareName(left: SortableBrowseItem, right: SortableBrowseItem): number {
  return collator.compare(left.name, right.name);
}

function compareBrowseMedia(
  left: SortableBrowseItem,
  right: SortableBrowseItem,
  order: MediaOrder
): number {
  if (order === "name-asc") {
    return compareName(left, right);
  }

  const difference = effectiveBrowseTime(left) - effectiveBrowseTime(right);
  return order === "captured-desc" ? -difference : difference;
}

export function sortBrowseItems<T extends SortableBrowseItem>(
  items: readonly T[],
  order: MediaOrder
): T[] {
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

export function selectFolderCoverNodeIds(
  descendants: readonly MediaNode[],
  limit = 3
): string[] {
  const requestedLimit = Math.max(0, limit);
  if (requestedLimit === 0) return [];

  const sorted = descendants
    .filter(
      node =>
        node.kind !== "folder" &&
        node.available &&
        node.hasPreview
    )
    .sort((left, right) => {
      const newestFirst = effectiveMediaTime(right) - effectiveMediaTime(left);
      const providerOrder =
        left.providerNodeId < right.providerNodeId
          ? -1
          : left.providerNodeId > right.providerNodeId
            ? 1
            : 0;
      return newestFirst || providerOrder;
    });
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const node of sorted) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    selected.push(node.id);
    if (selected.length === requestedLimit) break;
  }

  return selected;
}
