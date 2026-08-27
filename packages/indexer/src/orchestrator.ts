import { ProviderError, type ProviderRegistry } from "@cloudframe/providers";
import type { IndexCheckpoint, Source } from "@cloudframe/shared";
import {
  filterDeltaPageToEnabledRoots,
  runIndexBatch,
  type IndexBatchRepository
} from "./batch";
import { runReconciliationBatch, type ReconciliationRepository } from "./reconcile";
import type { SyncMode, SyncWorkflowRunner } from "./workflow";

export interface IndexOrchestratorRepository
  extends IndexBatchRepository,
    ReconciliationRepository {
  listRootsForSource(sourceId: string): Promise<Array<{ providerNodeId: string; enabled: boolean }>>;
  releaseSyncLease(sourceId: string, owner: string): Promise<boolean>;
  transitionToReconcileIfCurrent(input: TransitionToReconcileInput): Promise<boolean>;
  completeSyncRun(input: {
    sourceId: string;
    leaseOwner: string;
    completedAt: Date;
    nextSyncAt: Date;
  }): Promise<void>;
  recordSyncFailure(input: {
    sourceId: string;
    expectedLeaseOwner: string;
    expectedCheckpoint: IndexCheckpoint | null;
    failedAt: Date;
    status: "reauth-required" | "error";
    errorCode: string;
    nextSyncAt: Date | null;
  }): Promise<boolean>;
}

export interface TransitionToReconcileInput {
  sourceId: string;
  expectedLeaseOwner: string;
  expectedPreviousCheckpoint: IndexCheckpoint | null;
  changedAt: Date;
  newCheckpoint: IndexCheckpoint;
  leaseExpiresAt: Date;
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
        const enabledRoots = (await dependencies.repository.listRootsForSource(sourceId))
          .filter(root => root.enabled);
        const roots = enabledRoots
          .map(root => root.providerNodeId)
          .sort((left, right) => left.localeCompare(right));
        const restartInitial = mode === "initial" && (
          source.crawlCheckpoint?.mode !== "initial" ||
          !sameRootProviderIds(source.crawlCheckpoint.rootProviderIds, roots)
        );
        const generation = restartInitial
          ? createGeneration()
          : source.crawlCheckpoint?.generation ?? createGeneration();
        if (
          roots.length === 0 &&
          mode !== "reconcile" &&
          source.crawlCheckpoint?.mode !== "initial"
        ) {
          await finishSource(dependencies.repository, sourceId, leaseOwner, now());
          return { complete: true };
        }
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

        if (mode === "initial" && roots.length === 0) {
          await transitionToReconcile(
            dependencies.repository,
            source,
            initialCheckpoint(generation, roots),
            leaseOwner,
            now()
          );
          return { complete: false };
        }

        const credentials = await dependencies.getCredentials(sourceId, source.householdId);
        if (mode === "delta") {
          const cursor = source.crawlCheckpoint?.providerPageCursor ?? source.deltaCursor;
          const page = await dependencies.providers.get(source.provider).getChanges({
            credentials,
            cursor,
            pageSize
          });
          const filteredPage = await filterDeltaPageToEnabledRoots(
            page,
            enabledRoots,
            dependencies.repository,
            sourceId
          );
          const complete = page.nextCursor === null;
          await runIndexBatch({
            repository: dependencies.repository,
            sourceId,
            mode,
            generation,
            now: now(),
            complete,
            leaseOwner
          }, filteredPage);
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

        const rootSeed = roots.map(rootProviderId =>
          syntheticRootProviderNode(source, rootProviderId)
        );
        const checkpoint = !restartInitial && source.crawlCheckpoint?.mode === "initial"
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
          items: restartInitial
            ? [...rootSeed, ...providerPage.items]
            : providerPage.items
        };
        const folders = providerPage.items
          .filter(item => item.kind === "folder")
          .map(item => item.providerNodeId);
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
            rootProviderIds: roots,
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
        try {
          await recordProviderFailure(
            dependencies.repository,
            source,
            leaseOwner,
            error,
            now()
          );
        } catch {
          // Preserve the provider or quota failure that caused this step to fail.
        }
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
  const transitioned = await repository.transitionToReconcileIfCurrent({
    sourceId: source.id,
    expectedLeaseOwner: leaseOwner,
    expectedPreviousCheckpoint: source.crawlCheckpoint,
    changedAt,
    newCheckpoint: {
      mode: "reconcile",
      providerPageCursor: null,
      processedNodeCount: checkpoint.processedNodeCount,
      generation: checkpoint.generation,
      reconciliationCursor: null
    },
    leaseExpiresAt: new Date(changedAt.getTime() + 10 * 60 * 1000)
  });
  if (!transitioned) {
    throw Object.assign(new Error("Sync checkpoint is stale"), {
      code: "SYNC_CHECKPOINT_STALE" as const
    });
  }
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
  leaseOwner: string,
  error: unknown,
  failedAt: Date
): Promise<void> {
  const current = await repository.getSource(source.id);
  if (!current) return;
  const expectedCheckpoint = current.leaseOwner === leaseOwner
    ? current.crawlCheckpoint
    : source.crawlCheckpoint;
  if (isResourceExhausted(error)) {
    await repository.recordSyncFailure({
      sourceId: source.id,
      expectedLeaseOwner: leaseOwner,
      expectedCheckpoint,
      failedAt,
      status: "error",
      errorCode: "RESOURCE_EXHAUSTED",
      nextSyncAt: null
    });
    return;
  }
  if (!(error instanceof ProviderError)) return;
  await repository.recordSyncFailure({
    sourceId: source.id,
    expectedLeaseOwner: leaseOwner,
    expectedCheckpoint,
    failedAt,
    status: error.code === "PROVIDER_REAUTH_REQUIRED" ? "reauth-required" : "error",
    errorCode: error.code,
    nextSyncAt: error.retryAfterSeconds === null
      ? source.nextSyncAt
      : new Date(failedAt.getTime() + error.retryAfterSeconds * 1000)
  });
}

function isResourceExhausted(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (
    (error as { code?: unknown }).code === 8 ||
    (error as { code?: unknown }).code === "RESOURCE_EXHAUSTED"
  );
}

function initialCheckpoint(generation: string, roots: string[]): IndexCheckpoint {
  return {
    mode: "initial",
    providerPageCursor: null,
    processedNodeCount: 0,
    generation,
    rootProviderIds: roots,
    currentProviderFolderId: roots[0] ?? null,
    pendingProviderFolderIds: roots
  };
}

function sameRootProviderIds(
  checkpointRoots: readonly string[] | undefined,
  enabledRoots: readonly string[]
): boolean {
  return Boolean(
    checkpointRoots &&
    checkpointRoots.length === enabledRoots.length &&
    checkpointRoots.every((root, index) => root === enabledRoots[index])
  );
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
