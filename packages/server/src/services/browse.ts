import { createHmac, timingSafeEqual } from "node:crypto";

import {
  type AssignedRoot,
  type Device,
  type Household,
  type MediaNode,
  type MediaOrder,
  type WatchHistory
} from "@cloudframe/shared";
import type { AppRepository } from "../firestore/repository";

const MAX_PAGE_SIZE = 100;
const MAX_HISTORY_SECONDS = 366 * 24 * 60 * 60;

export interface BrowseServiceDependencies {
  repository: AppRepository;
  cursorSecret: string;
  now?: () => Date;
}

export interface FolderPageInput {
  cursor: string | null;
  limit: number;
}

export function createBrowseService(dependencies: BrowseServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());

  async function currentDevice(device: Device, household: Household): Promise<Device> {
    const current = await dependencies.repository.getDevice(device.id);
    if (
      !current ||
      current.householdId !== household.id ||
      household.id !== device.householdId ||
      !current.enabled ||
      current.revokedAt
    ) {
      throw new BrowseServiceError("DEVICE_UNAUTHORIZED", "Device is unavailable.");
    }
    return current;
  }

  async function assignedRoots(
    device: Device,
    household: Household
  ): Promise<AssignedRoot[]> {
    const current = await currentDevice(device, household);
    const roots = await dependencies.repository.listRootsByIds(
      current.assignedRootIds
    );
    const available: AssignedRoot[] = [];
    for (const root of roots) {
      if (!root.enabled || root.householdId !== household.id) continue;
      const source = await dependencies.repository.getSource(root.sourceId);
      if (!source || source.householdId !== household.id || source.status === "disabled") {
        continue;
      }
      available.push(root);
    }
    return available;
  }

  async function authorizeNode(
    device: Device,
    household: Household,
    nodeId: string
  ): Promise<MediaNode> {
    const node = await dependencies.repository.getNode(nodeId);
    if (!node || !node.available || node.householdId !== household.id) {
      throw notFound();
    }
    const roots = await assignedRoots(device, household);
    const rootIds = new Set<string>();
    for (const root of roots) {
      if (root.sourceId !== node.sourceId) continue;
      const indexedRoot = await dependencies.repository.getNodeByProviderId(root.sourceId, root.providerNodeId);
      if (indexedRoot?.available) rootIds.add(indexedRoot.id);
    }
    let current: MediaNode | null = node;
    const seen = new Set<string>();
    while (current && seen.size < 256) {
      if (
        seen.has(current.id) ||
        !current.available ||
        current.householdId !== household.id ||
        current.sourceId !== node.sourceId
      ) break;
      seen.add(current.id);
      if (rootIds.has(current.id)) return node;
      current = current.parentNodeId
        ? await dependencies.repository.getNode(current.parentNodeId)
        : null;
    }
    throw notFound();
  }

  async function home(device: Device, household?: Household) {
    const resolvedHousehold = household ?? await requireHousehold(device.householdId);
    const roots = await assignedRoots(device, resolvedHousehold);
    const cards = [];
    for (const root of roots) {
      const [source, node] = await Promise.all([
        dependencies.repository.getSource(root.sourceId),
        dependencies.repository.getNodeByProviderId(root.sourceId, root.providerNodeId)
      ]);
      if (!source || !node || !node.available) continue;
      cards.push({
        id: root.id,
        sourceId: root.sourceId,
        displayName: root.displayName,
        provider: source.provider,
        accountLabel: source.accountLabel,
        nodeId: node.id,
        folderCoverNodeIds: [...node.folderCoverNodeIds],
        childFolderCount: node.childFolderCount,
        childMediaCount: node.childMediaCount
      });
    }
    return { roots: cards };
  }

  async function folder(
    device: Device,
    household: Household,
    nodeId: string,
    page: FolderPageInput
  ) {
    const parent = await authorizeNode(device, household, nodeId);
    if (parent.kind !== "folder") {
      throw new BrowseServiceError("FOLDER_NOT_FOUND", "Folder not found.");
    }
    const limit = normalizePageSize(page.limit);
    const order = device.mediaOrder ?? household.defaultMediaOrder;
    const children = (await dependencies.repository.listChildNodes(parent.id, [parent.sourceId]))
      .filter(node => node.available && node.householdId === household.id)
      .sort((left, right) => compareBrowseNodes(left, right, order));
    const cursor = page.cursor
      ? decodeCursor(page.cursor, dependencies.cursorSecret)
      : null;
    validateCursor(cursor, device, household, parent.id, order);
    const start = cursor ? findCursorIndex(children, cursor) + 1 : 0;
    const items = children.slice(start, start + limit);
    const nextCursor = start + items.length < children.length && items.length > 0
      ? encodeCursor({
          householdId: household.id,
          deviceId: device.id,
          parentNodeId: parent.id,
          order,
          lastNodeId: items.at(-1)!.id,
          lastSortKey: sortKey(items.at(-1)!, order)
        }, dependencies.cursorSecret)
      : null;
    const breadcrumbs = await currentBreadcrumbs(dependencies.repository, parent);
    return { parent, breadcrumbs, children: items, nextCursor };
  }

  async function saveHistory(
    device: Device,
    household: Household,
    nodeId: string,
    value: Pick<WatchHistory, "positionSeconds" | "durationSeconds" | "completed">
  ): Promise<WatchHistory> {
    const node = await authorizeNode(device, household, nodeId);
    if (node.kind === "folder") throw invalidHistory();
    validateHistory(value);
    const history: WatchHistory = {
      id: `${device.id}_${node.id}`,
      householdId: household.id,
      deviceId: device.id,
      nodeId: node.id,
      positionSeconds: value.positionSeconds,
      durationSeconds: value.durationSeconds,
      completed: value.completed,
      updatedAt: now()
    };
    await dependencies.repository.putWatchHistory(history);
    return history;
  }

  async function history(device: Device, household: Household) {
    await currentDevice(device, household);
    const values = await dependencies.repository.listWatchHistory({
      householdId: household.id,
      deviceId: device.id
    });
    const authorized: WatchHistory[] = [];
    for (const value of values) {
      try {
        await authorizeNode(device, household, value.nodeId);
        authorized.push(value);
      } catch (error) {
        if (!(error instanceof BrowseServiceError)) throw error;
      }
    }
    return authorized.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async function requireHousehold(id: string): Promise<Household> {
    const household = await dependencies.repository.getHousehold(id);
    if (!household) {
      throw new BrowseServiceError("DEVICE_UNAUTHORIZED", "Device is unavailable.");
    }
    return household;
  }

  return { home, folder, authorizeNode, saveHistory, history };
}

async function currentBreadcrumbs(
  repository: AppRepository,
  node: MediaNode
): Promise<MediaNode[]> {
  const reversed: MediaNode[] = [];
  let parentId = node.parentNodeId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId) && seen.size < 256) {
    seen.add(parentId);
    const parent = await repository.getNode(parentId);
    if (!parent || !parent.available) break;
    reversed.push(parent);
    parentId = parent.parentNodeId;
  }
  return reversed.reverse();
}

interface CursorPayload {
  householdId: string;
  deviceId: string;
  parentNodeId: string;
  order: MediaOrder;
  lastNodeId: string;
  lastSortKey: string;
}

function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function decodeCursor(value: string, secret: string): CursorPayload {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) throw invalidCursor();
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw invalidCursor();
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalidCursor();
  }
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw invalidCursor();
  }
}

function validateCursor(
  cursor: CursorPayload | null,
  device: Device,
  household: Household,
  parentNodeId: string,
  order: MediaOrder
): void {
  if (!cursor) return;
  if (
    cursor.deviceId !== device.id ||
    cursor.householdId !== household.id ||
    cursor.parentNodeId !== parentNodeId ||
    cursor.order !== order
  ) throw invalidCursor();
}

function findCursorIndex(nodes: MediaNode[], cursor: CursorPayload): number {
  const index = nodes.findIndex(node => node.id === cursor.lastNodeId);
  if (index < 0 || sortKey(nodes[index]!, cursor.order) !== cursor.lastSortKey) {
    throw invalidCursor();
  }
  return index;
}

function sortKey(node: MediaNode, order: MediaOrder): string {
  const time = (node.capturedAt ?? node.createdAtProvider ?? node.modifiedAtProvider ?? new Date(0)).getTime();
  return `${node.kind === "folder" ? "0" : "1"}\u0000${order}\u0000${node.normalizedName}\u0000${time}\u0000${node.id}`;
}

function compareBrowseNodes(
  left: MediaNode,
  right: MediaNode,
  order: MediaOrder
): number {
  const leftFolder = left.kind === "folder";
  const rightFolder = right.kind === "folder";
  if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
  let comparison = 0;
  if (leftFolder || order === "name-asc") {
    comparison = left.normalizedName.localeCompare(right.normalizedName, "en", {
      numeric: true,
      sensitivity: "base"
    });
  } else {
    const leftTime = (left.capturedAt ?? left.createdAtProvider ?? left.modifiedAtProvider ?? new Date(0)).getTime();
    const rightTime = (right.capturedAt ?? right.createdAtProvider ?? right.modifiedAtProvider ?? new Date(0)).getTime();
    comparison = order === "captured-desc" ? rightTime - leftTime : leftTime - rightTime;
  }
  return comparison || left.id.localeCompare(right.id);
}

function normalizePageSize(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw new BrowseServiceError("INVALID_PAGE_SIZE", "Page size is invalid.");
  }
  return value;
}

function validateHistory(value: Pick<WatchHistory, "positionSeconds" | "durationSeconds" | "completed">): void {
  if (
    !Number.isFinite(value.positionSeconds) ||
    !Number.isFinite(value.durationSeconds) ||
    value.positionSeconds < 0 ||
    value.durationSeconds < 0 ||
    value.positionSeconds > value.durationSeconds ||
    value.durationSeconds > MAX_HISTORY_SECONDS ||
    typeof value.completed !== "boolean"
  ) throw invalidHistory();
}

function invalidCursor() {
  return new BrowseServiceError("INVALID_CURSOR", "Browse cursor is invalid.");
}

function invalidHistory() {
  return new BrowseServiceError("INVALID_HISTORY", "Watch history is invalid.");
}

function notFound() {
  return new BrowseServiceError("NODE_NOT_FOUND", "Media item not found.");
}

export type BrowseServiceErrorCode =
  | "DEVICE_UNAUTHORIZED"
  | "NODE_NOT_FOUND"
  | "FOLDER_NOT_FOUND"
  | "INVALID_CURSOR"
  | "INVALID_PAGE_SIZE"
  | "INVALID_HISTORY";

export class BrowseServiceError extends Error {
  constructor(readonly code: BrowseServiceErrorCode, message: string) {
    super(message);
    this.name = "BrowseServiceError";
  }
}
