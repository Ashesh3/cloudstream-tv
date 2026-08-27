import { timingSafeEqual } from "node:crypto";

import type { Source } from "@cloudframe/shared";
import type { SyncMode, WorkflowLauncher } from "@cloudframe/indexer";
import type { AppRepository } from "../firestore/repository";

export interface IndexingServiceDependencies {
  repository: AppRepository;
  workflowLauncher: WorkflowLauncher;
  householdId: string;
  cronSecret: string;
  now?: () => Date;
  createOwner?: () => string;
}

export function createIndexingService(dependencies: IndexingServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const createOwner = dependencies.createOwner ?? (() => `sync-${crypto.randomUUID()}`);

  async function startSource(sourceId: string, requestedMode?: SyncMode) {
    const source = await dependencies.repository.getSource(sourceId);
    if (!source || source.householdId !== dependencies.householdId) {
      throw new IndexingServiceError("SOURCE_NOT_FOUND", "Source not found.");
    }
    const enabledRootCount = (await dependencies.repository.listRootsForSource(sourceId))
      .filter(root => root.enabled).length;
    const mode = requestedMode === "initial"
      ? "initial"
      : chooseSyncMode(source, enabledRootCount);
    const owner = createOwner();
    const startedAt = now();
    const leased = await dependencies.repository.acquireSyncLease({
      sourceId,
      owner,
      now: startedAt,
      expiresAt: new Date(startedAt.getTime() + 10 * 60 * 1000)
    });
    if (!leased) return { started: false, sourceId };
    try {
      const run = await dependencies.workflowLauncher.start(
        sourceId,
        mode,
        owner
      );
      const marked = await dependencies.repository.markSyncRunStarted({ sourceId, leaseOwner: owner, runId: run.runId, startedAt });
      return { started: marked, sourceId, ...(marked ? { runId: run.runId } : {}) };
    } catch (error) {
      await dependencies.repository.releaseSyncLease(sourceId, owner);
      throw error;
    }
  }

  async function startDueSources(authorization: string | null, limit = 10) {
    verifyCronSecret(authorization, dependencies.cronSecret);
    const current = now();
    const leaseOwner = createOwner();
    const sources = await dependencies.repository.leaseDueSources({
      householdId: dependencies.householdId,
      owner: leaseOwner,
      now: current,
      expiresAt: new Date(current.getTime() + 10 * 60 * 1000),
      limit: Math.max(1, Math.min(20, limit))
    });
    const results: Array<{ sourceId: string; started: boolean }> = [];
    for (const source of sources) {
      const owner = source.leaseOwner!;
      try {
        const enabledRootCount = (await dependencies.repository.listRootsForSource(source.id))
          .filter(root => root.enabled).length;
        const run = await dependencies.workflowLauncher.start(
          source.id,
          chooseSyncMode(source, enabledRootCount),
          owner
        );
        const marked = await dependencies.repository.markSyncRunStarted({ sourceId: source.id, leaseOwner: owner, runId: run.runId, startedAt: current });
        results.push({ sourceId: source.id, started: marked });
      } catch {
        await dependencies.repository.releaseSyncLease(source.id, owner);
        results.push({ sourceId: source.id, started: false });
      }
    }
    return {
      leased: sources.length,
      started: results.filter(value => value.started).length,
      failed: results.filter(value => !value.started).length
    };
  }

  return { startSource, startDueSources };
}

export function chooseSyncMode(
  source: Source,
  enabledRootCount: number
): SyncMode {
  if (enabledRootCount === 0) return "initial";
  if (source.crawlCheckpoint?.mode === "reconcile") return "reconcile";
  return "initial";
}

function verifyCronSecret(value: string | null, secret: string): void {
  const presented = value?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = Buffer.from(presented);
  const expected = Buffer.from(secret);
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    throw new IndexingServiceError("CRON_UNAUTHORIZED", "Cron authentication failed.");
  }
}

export type IndexingServiceErrorCode = "SOURCE_NOT_FOUND" | "CRON_UNAUTHORIZED" | "INDEXING_UNAVAILABLE";

export class IndexingServiceError extends Error {
  constructor(readonly code: IndexingServiceErrorCode, message: string) {
    super(message);
    this.name = "IndexingServiceError";
  }
}

export class IndexingUnavailableError extends IndexingServiceError {
  constructor(message = "Durable indexing is not configured for this deployment.") {
    super("INDEXING_UNAVAILABLE", message);
    this.name = "IndexingUnavailableError";
  }
}

export type { Source };
