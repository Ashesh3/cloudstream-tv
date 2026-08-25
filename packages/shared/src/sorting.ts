import type { MediaNode, MediaOrder } from "./contracts";

const collator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true
});

function effectiveMediaTime(node: MediaNode): number {
  return (
    node.capturedAt ??
    node.createdAtProvider ??
    node.modifiedAtProvider ??
    new Date(0)
  ).getTime();
}

function compareName(left: MediaNode, right: MediaNode): number {
  return collator.compare(left.name, right.name);
}

function compareMedia(left: MediaNode, right: MediaNode, order: MediaOrder): number {
  if (order === "name-asc") {
    return compareName(left, right);
  }

  const difference = effectiveMediaTime(left) - effectiveMediaTime(right);
  return order === "captured-desc" ? -difference : difference;
}

export function sortFolderListing(
  nodes: readonly MediaNode[],
  order: MediaOrder
): MediaNode[] {
  return nodes
    .map((node, originalIndex) => ({ node, originalIndex }))
    .sort((left, right) => {
      const leftIsFolder = left.node.kind === "folder";
      const rightIsFolder = right.node.kind === "folder";
      if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1;

      const comparison = leftIsFolder
        ? compareName(left.node, right.node)
        : compareMedia(left.node, right.node, order);
      return comparison || left.originalIndex - right.originalIndex;
    })
    .map(item => item.node);
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
