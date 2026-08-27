import { createHash } from "node:crypto";

import type {
  IndexCheckpoint,
  MediaNode,
  Source
} from "@cloudframe/shared";
import type {
  ChangesPage,
  Page,
  ProviderNode
} from "@cloudframe/providers";

export const MAX_INDEX_BATCH_SIZE = 200;

export interface IndexBatchRepository {
  getSource(id: string): Promise<Source | null>;
  getNodeByProviderId(sourceId: string, providerNodeId: string): Promise<MediaNode | null>;
  commitIndexBatch(input: IndexBatchCommitInput): Promise<number>;
}

export interface IndexBatchContext {
  repository: IndexBatchRepository;
  sourceId: string;
  mode: "initial" | "delta";
  generation: string;
  now: Date;
  checkpointPatch?: Partial<IndexCheckpoint>;
  complete?: boolean;
  leaseOwner?: string;
}

export interface IndexBatchCommitInput {
  sourceId: string;
  mode: "initial" | "delta";
  generation: string;
  checkpoint: IndexCheckpoint;
  deltaCursor?: string | null;
  nodes: MediaNode[];
  removedNodeIds: string[];
  affectedAncestorNodeIds: string[];
  completedAt: Date | null;
  expectedLeaseOwner?: string;
  expectedPreviousCheckpoint?: IndexCheckpoint | null;
  leaseExpiresAt?: Date;
  committedAt: Date;
}

export interface IndexBatchResult {
  totalNodeCount: number;
  checkpoint: IndexCheckpoint;
  affectedAncestorNodeIds: string[];
}

export function applyIndexRemovals(
  nodes: Map<string, MediaNode>,
  removedNodeIds: readonly string[],
  indexedAt?: Date
): string[] {
  const removed = new Set<string>();
  const removedFolderIds = new Set<string>();
  for (const id of removedNodeIds) {
    const node = nodes.get(id);
    if (!node) continue;
    nodes.set(id, {
      ...node,
      available: false,
      ...(indexedAt ? { indexedAt } : {})
    });
    removed.add(id);
    if (node.kind === "folder") removedFolderIds.add(id);
  }
  if (removedFolderIds.size === 0) return [...removed];
  for (const node of nodes.values()) {
    if (
      node.available &&
      node.ancestorNodeIds.some(id => removedFolderIds.has(id))
    ) {
      nodes.set(node.id, {
        ...node,
        available: false,
        ...(indexedAt ? { indexedAt } : {})
      });
      removed.add(node.id);
    }
  }
  return [...removed];
}

export async function filterDeltaPageToEnabledRoots(
  page: ChangesPage,
  roots: Array<{ providerNodeId: string }>,
  repository: Pick<IndexBatchRepository, "getNodeByProviderId">,
  sourceId: string
): Promise<ChangesPage> {
  const rootIds = new Set(roots.map(root => root.providerNodeId));
  const rootNodeIds = new Set(
    roots.map(root => deterministicNodeId(sourceId, root.providerNodeId))
  );
  const changesById = new Map(
    page.changes
      .filter(change => !change.removed && change.node)
      .map(change => [change.providerNodeId, change])
  );
  const removedIds = new Set(
    page.changes.filter(change => change.removed).map(change => change.providerNodeId)
  );
  const accepted = new Map<string, boolean>();

  async function belongsToEnabledRoot(
    providerNodeId: string,
    visiting: Set<string>
  ): Promise<boolean> {
    if (rootIds.has(providerNodeId)) return true;
    if (removedIds.has(providerNodeId)) return false;
    const cached = accepted.get(providerNodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(providerNodeId)) return false;
    visiting.add(providerNodeId);

    const changed = changesById.get(providerNodeId);
    const parentProviderId = changed?.node?.parentProviderId ?? null;
    let belongs = false;
    if (parentProviderId !== null) {
      if (
        changesById.has(parentProviderId) ||
        removedIds.has(parentProviderId) ||
        rootIds.has(parentProviderId)
      ) {
        belongs = await belongsToEnabledRoot(parentProviderId, visiting);
      } else {
        const indexedParent = await repository.getNodeByProviderId(sourceId, parentProviderId);
        belongs = Boolean(
          indexedParent?.available && (
            rootNodeIds.has(indexedParent.id) ||
            indexedParent.ancestorNodeIds.some(id => rootNodeIds.has(id))
          )
        );
      }
    }
    visiting.delete(providerNodeId);
    accepted.set(providerNodeId, belongs);
    return belongs;
  }

  const filtered: ChangesPage["changes"] = [];
  for (const change of page.changes) {
    const existing = await repository.getNodeByProviderId(sourceId, change.providerNodeId);
    if (change.removed) {
      if (existing) filtered.push(change);
      continue;
    }
    if (await belongsToEnabledRoot(change.providerNodeId, new Set())) {
      filtered.push(change);
    } else if (existing) {
      filtered.push({ providerNodeId: change.providerNodeId, removed: true, node: null });
    }
  }
  return { ...page, changes: filtered };
}

export function deterministicNodeId(
  sourceId: string,
  providerNodeId: string
): string {
  return `node_${createHash("sha256")
    .update(`${sourceId.length}:${sourceId}${providerNodeId.length}:${providerNodeId}`)
    .digest("base64url")}`;
}

export async function runIndexBatch(
  context: IndexBatchContext,
  page: Page<ProviderNode> | ChangesPage
): Promise<IndexBatchResult> {
  const source = await context.repository.getSource(context.sourceId);
  if (!source) throw new Error("Source not found");
  const entries = isChangesPage(page)
    ? page.changes
    : page.items.map(node => ({ providerNodeId: node.providerNodeId, removed: false, node }));
  if (entries.length > MAX_INDEX_BATCH_SIZE) {
    throw new Error(`Index batch exceeds ${MAX_INDEX_BATCH_SIZE} nodes`);
  }

  const nodes: MediaNode[] = [];
  const removedNodeIds: string[] = [];
  const affected = new Set<string>();
  const pageNodes = new Map(
    entries
      .filter(entry => !entry.removed && entry.node)
      .map(entry => [entry.providerNodeId, entry.node!])
  );
  const convertedPageNodes = new Map<string, MediaNode>();
  for (const entry of entries) {
    if (entry.removed || !entry.node) {
      const existing = await context.repository.getNodeByProviderId(
        context.sourceId,
        entry.providerNodeId
      );
      if (existing) {
        removedNodeIds.push(existing.id);
        for (const ancestor of existing.ancestorNodeIds) affected.add(ancestor);
        if (existing.parentNodeId) affected.add(existing.parentNodeId);
      }
      continue;
    }
    const existing = await context.repository.getNodeByProviderId(
      context.sourceId,
      entry.providerNodeId
    );
    if (existing) {
      for (const ancestor of existing.ancestorNodeIds) affected.add(ancestor);
      if (existing.parentNodeId) affected.add(existing.parentNodeId);
    }
    const converted = await convertProviderNode(
      context,
      source,
      entry.node,
      pageNodes,
      convertedPageNodes,
      new Set()
    );
    nodes.push(converted);
    for (const ancestor of converted.ancestorNodeIds) affected.add(ancestor);
    if (converted.parentNodeId) affected.add(converted.parentNodeId);
  }

  const pageFingerprint = fingerprintPage(entries, page.nextCursor);
  const replayingSamePage =
    source.crawlCheckpoint?.generation === context.generation &&
    source.crawlCheckpoint.mode === context.mode &&
    source.crawlCheckpoint.pageFingerprint === pageFingerprint;
  const previousCount =
    source.crawlCheckpoint?.generation === context.generation &&
    source.crawlCheckpoint.mode === context.mode
      ? source.crawlCheckpoint.processedNodeCount
      : 0;
  const checkpoint: IndexCheckpoint = {
    ...context.checkpointPatch,
    mode: context.mode,
    providerPageCursor: page.nextCursor,
    processedNodeCount: replayingSamePage ? previousCount : previousCount + entries.length,
    generation: context.generation,
    pageFingerprint
  };
  const completedAt = (context.complete ?? page.nextCursor === null) ? context.now : null;
  const totalNodeCount = await context.repository.commitIndexBatch({
    sourceId: context.sourceId,
    mode: context.mode,
    generation: context.generation,
    checkpoint,
    deltaCursor: isChangesPage(page) ? page.deltaCursor : undefined,
    nodes,
    removedNodeIds,
    affectedAncestorNodeIds: [...affected],
    completedAt,
    committedAt: context.now,
    expectedLeaseOwner: context.leaseOwner,
    expectedPreviousCheckpoint: source.crawlCheckpoint,
    leaseExpiresAt: context.leaseOwner
      ? new Date(context.now.getTime() + 10 * 60 * 1000)
      : undefined
  });
  return { totalNodeCount, checkpoint, affectedAncestorNodeIds: [...affected] };
}

async function convertProviderNode(
  context: IndexBatchContext,
  source: Source,
  node: ProviderNode,
  pageNodes: Map<string, ProviderNode>,
  convertedPageNodes: Map<string, MediaNode>,
  visiting: Set<string>
): Promise<MediaNode> {
  const cached = convertedPageNodes.get(node.providerNodeId);
  if (cached) return cached;
  if (visiting.has(node.providerNodeId)) throw new Error("Provider ancestry cycle detected");
  visiting.add(node.providerNodeId);
  const pageParent = node.parentProviderId ? pageNodes.get(node.parentProviderId) : undefined;
  const parent = pageParent
    ? await convertProviderNode(context, source, pageParent, pageNodes, convertedPageNodes, visiting)
    : node.parentProviderId
      ? await context.repository.getNodeByProviderId(context.sourceId, node.parentProviderId)
      : null;
  const parentNodeId = node.parentProviderId
    ? parent?.id ?? deterministicNodeId(context.sourceId, node.parentProviderId)
    : null;
  const converted: MediaNode = {
    id: deterministicNodeId(context.sourceId, node.providerNodeId),
    householdId: source.householdId,
    sourceId: context.sourceId,
    provider: source.provider,
    providerNodeId: node.providerNodeId,
    parentNodeId,
    ancestorNodeIds: parentNodeId
      ? [...(parent?.ancestorNodeIds ?? []), parentNodeId]
      : [],
    name: node.name,
    normalizedName: node.name.normalize("NFKC").toLocaleLowerCase("en"),
    kind: node.kind,
    mimeType: node.mimeType,
    size: node.size,
    width: node.width,
    height: node.height,
    capturedAt: node.capturedAt,
    createdAtProvider: node.createdAt,
    modifiedAtProvider: node.modifiedAt,
    thumbnailRevision: node.thumbnailRevision,
    hasPreview: node.hasPreview,
    folderCoverNodeIds: [],
    childFolderCount: 0,
    childMediaCount: 0,
    available: true,
    indexedAt: context.now,
    syncGeneration: context.generation
  };
  convertedPageNodes.set(node.providerNodeId, converted);
  visiting.delete(node.providerNodeId);
  return converted;
}

function isChangesPage(
  page: Page<ProviderNode> | ChangesPage
): page is ChangesPage {
  return "changes" in page;
}

function fingerprintPage(
  entries: Array<{ providerNodeId: string; removed: boolean; node: ProviderNode | null }>,
  nextCursor: string | null
): string {
  const stable = entries.map(entry => ({
    id: entry.providerNodeId,
    removed: entry.removed,
    parent: entry.node?.parentProviderId ?? null,
    name: entry.node?.name ?? null,
    revision: entry.node?.thumbnailRevision ?? null
  }));
  return createHash("sha256")
    .update(JSON.stringify({ stable, nextCursor }))
    .digest("base64url");
}
