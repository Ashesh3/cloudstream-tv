import type { MediaNode } from "@cloudframe/shared";
import { selectFolderCoverNodeIds } from "@cloudframe/shared";

export function recomputeFolderMetadata(
  folder: MediaNode,
  descendants: readonly MediaNode[]
): MediaNode {
  const direct = descendants.filter(node => node.parentNodeId === folder.id && node.available);
  return {
    ...folder,
    folderCoverNodeIds: selectFolderCoverNodeIds(descendants, 3),
    childFolderCount: direct.filter(node => node.kind === "folder").length,
    childMediaCount: direct.filter(node => node.kind !== "folder").length
  };
}
