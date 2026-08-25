import { ProviderError, type ProviderRegistry } from "@cloudframe/providers";
import type { IndexCheckpoint, Source } from "@cloudframe/shared";
import { runIndexBatch, type IndexBatchRepository } from "./batch";
import { runReconciliationBatch, type ReconciliationRepository } from "./reconcile";
import type { SyncMode, SyncWorkflowRunner } from "./workflow";

export interface IndexOrchestratorRepository
  extends IndexBatchRepository,
    ReconciliationRepository {
  putSource(source: Source): Promise<void>;
  listRootsForSource(sourceId: string): Promise<Array<{ providerNodeId: string; enabled: boolean }>>;
  releaseSyncLease(sourceId: string, owner: string): Promise<boolean>;
  completeSyncRun(input: {
    sourceId: string;
    leaseOwner: string;
    completedAt: Date;
    nextSyncAt: Date;
  }): Promise<void>;
}

export interface IndexOrchestratorDependencies {
  repository: IndexOrchestratorRepository;
  providers: ProviderRegistry;
  getCredentials(sourceId: string, householdId: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    accessTokenExpiresAt: Date;
  }>;
  now?: () => Date;
  createGeneration?: () => string;
  pageSize?: number;
}

export function createIndexOrchestrator(
  dependencies: IndexOrchestratorDependencies
): SyncWorkflowRunner {
  const now = dependencies.now ?? (() => new Date());
  const createGeneration = dependencies.createGeneration ?? (() => crypto.randomUUID());
  const pageSize = Math.max(1, Math.min(200, dependencies.pageSize ?? 200));

  return {
    async runNext(
      sourceId: string,
      requestedMode: SyncMode,
      leaseOwner: string
    ) {
      const source = await dependencies.repository.getSource(sourceId);
      if (!source) throw new Error("Source not found");
      try {
        const mode = source.crawlCheckpoint?.mode ?? requestedMode;
        const generation = source.crawlCheckpoint?.generation ?? createGeneration();
        if (mode === "reconcile") {
          const result = await runReconciliationBatch({
            repository: dependencies.repository,
            sourceId,
            generation,
            cursor: source.crawlCheckpoint?.reconciliationCursor ?? null,
            limit: pageSize,
            now: now(),
            leaseOwner
          });
          if (result.complete) {
            await finishSource(
              dependencies.repository,
              sourceId,
              leaseOwner,
              now()
            );
          }
          return { complete: result.complete };
        }

        const credentials = await dependencies.getCredentials(sourceId, source.householdId);
        if (mode === "delta") {
          const cursor = source.crawlCheckpoint?.providerPageCursor ?? source.deltaCursor;
          const page = await dependencies.providers.get(source.provider).getChanges({
            credentials,
            cursor,
            pageSize
          });
          const complete = page.nextCursor === null;
          await runIndexBatch({
          repository: dependencies.repository,
          sourceId,
          mode,
          generation,
            now: now(),
          complete,
          leaseOwner
        }, page);
          if (complete) {
          await finishSource(
            dependencies.repository,
            sourceId,
            leaseOwner,
            now()
          );
        }
          return { complete };
        }

      const roots = (await dependencies.repository.listRootsForSource(sourceId))
        .filter(root => root.enabled)
        .map(root => root.providerNodeId);
      const rootSeed = roots.map(rootProviderId =>
        syntheticRootProviderNode(source, rootProviderId)
      );
      const checkpoint = source.crawlCheckpoint?.mode === "initial"
        ? source.crawlCheckpoint
        : initialCheckpoint(generation, roots);
      const currentFolder = checkpoint.currentProviderFolderId ?? checkpoint.pendingProviderFolderIds?.[0];
      if (!currentFolder) {
        await transitionToReconcile(
          dependencies.repository,
          source,
          checkpoint,
          leaseOwner,
          now()
        );
        return { complete: false };
      }
      const providerPage = await dependencies.providers.get(source.provider).listFolder({
        credentials,
        folderId: currentFolder,
        cursor: checkpoint.providerPageCursor,
        pageSize
      });
      const page = {
        ...providerPage,
        items: source.crawlCheckpoint?.mode === "initial"
          ? providerPage.items
          : [...rootSeed, ...providerPage.items]
      };
      const folders = providerPage.items.filter(item => item.kind === "folder").map(item => item.providerNodeId);
      const pending = [...(checkpoint.pendingProviderFolderIds ?? roots)];
      if (page.nextCursor === null) pending.shift();
      pending.push(...folders.filter(id => !pending.includes(id)));
      await runIndexBatch({
        repository: dependencies.repository,
        sourceId,
        mode: "initial",
        generation,
        now: now(),
        complete: false,
        leaseOwner,
        checkpointPatch: {
          currentProviderFolderId: page.nextCursor ? currentFolder : pending[0] ?? null,
          pendingProviderFolderIds: pending
        }
      }, page);
      if (page.nextCursor === null && pending.length === 0) {
        const updated = await dependencies.repository.getSource(sourceId);
        if (updated) {
          await transitionToReconcile(
            dependencies.repository,
            updated,
            updated.crawlCheckpoint ?? checkpoint,
            leaseOwner,
            now()
          );
        }
      }
        return { complete: false };
      } catch (error) {
        await recordProviderFailure(dependencies.repository, source, error, now());
        throw error;
      }
    }
  };
}

async function transitionToReconcile(
  repository: IndexOrchestratorRepository,
  source: Source,
  checkpoint: IndexCheckpoint,
  leaseOwner: string,
  changedAt: Date
): Promise<void> {
  if (
    source.leaseOwner !== leaseOwner ||
    !source.leaseExpiresAt ||
    source.leaseExpiresAt <= changedAt
  ) throw new Error("Sync lease is stale");
  await repository.putSource({
    ...source,
    leaseExpiresAt: new Date(changedAt.getTime() + 10 * 60 * 1000),
    crawlCheckpoint: {
      mode: "reconcile",
      providerPageCursor: null,
      processedNodeCount: checkpoint.processedNodeCount,
      generation: checkpoint.generation,
      reconciliationCursor: null
    }
  });
}

function syntheticRootProviderNode(
  source: Source,
  providerNodeId: string
) {
  return {
    providerNodeId,
    parentProviderId: null,
    name: source.accountLabel,
    kind: "folder" as const,
    mimeType: null,
    size: null,
    width: null,
    height: null,
    capturedAt: null,
    createdAt: null,
    modifiedAt: null,
    thumbnailRevision: null,
    hasPreview: false
  };
}

async function recordProviderFailure(
  repository: IndexOrchestratorRepository,
  source: Source,
  error: unknown,
  failedAt: Date
): Promise<void> {
  if (!(error instanceof ProviderError)) return;
  await repository.putSource({
    ...source,
    status: error.code === "PROVIDER_REAUTH_REQUIRED" ? "reauth-required" : "error",
    lastSyncErrorCode: error.code,
    nextSyncAt: error.retryAfterSeconds === null
      ? source.nextSyncAt
      : new Date(failedAt.getTime() + error.retryAfterSeconds * 1000)
  });
}

function initialCheckpoint(generation: string, roots: string[]): IndexCheckpoint {
  return {
    mode: "initial",
    providerPageCursor: null,
    processedNodeCount: 0,
    generation,
    currentProviderFolderId: roots[0] ?? null,
    pendingProviderFolderIds: roots
  };
}

async function finishSource(
  repository: IndexOrchestratorRepository,
  sourceId: string,
  leaseOwner: string,
  completedAt: Date
): Promise<void> {
  const source = await repository.getSource(sourceId);
  if (!source) throw new Error("Source not found");
  if (source.leaseOwner !== leaseOwner) {
    throw new Error("Sync lease is stale");
  }
  await repository.completeSyncRun({
    sourceId,
    leaseOwner,
    completedAt,
    nextSyncAt: new Date(completedAt.getTime() + 15 * 60 * 1000)
  });
}
