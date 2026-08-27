import { describe, expect, it, vi } from "vitest";

import {
  MAX_INDEX_BATCH_SIZE,
  createInjectedWorkflowLauncher,
  createIndexOrchestrator,
  createWorkflowApiLauncher,
  createWorkflowStep,
  deterministicNodeId,
  type LegacyChangesPage,
  runIndexBatch,
  runReconciliationBatch
} from "@cloudframe/indexer";
import { createIndexingService, MemoryRepository } from "@cloudframe/server";
import { sourceIndexStateKind, type AssignedRoot, type Source } from "@cloudframe/shared";
import {
  createGoogleDriveAdapter,
  ProviderError,
  type ProviderAdapter,
  type ProviderNode
} from "@cloudframe/providers";

const now = new Date("2026-08-26T00:00:00.000Z");

describe("bounded resumable indexing", () => {
  it("derives stable collision-safe node identities from source and provider ids", () => {
    expect(deterministicNodeId("ab", "c")).toBe(
      deterministicNodeId("ab", "c")
    );
    expect(deterministicNodeId("ab", "c")).not.toBe(
      deterministicNodeId("a", "bc")
    );
  });

  it("replays the same provider page without duplicating nodes or checkpoints", async () => {
    const repository = await seededRepository();
    const page = {
      items: [folder("trips", "Trips"), image("photo", "Photo.jpg", "trips")],
      nextCursor: "page-2"
    };

    const first = await runIndexBatch(batchContext(repository), page);
    const second = await runIndexBatch(batchContext(repository), page);

    expect(second.totalNodeCount).toBe(first.totalNodeCount);
    expect(second.checkpoint).toEqual(first.checkpoint);
    expect(await repository.getNode(deterministicNodeId("s1", "photo"))).toMatchObject({
      parentNodeId: deterministicNodeId("s1", "trips"),
      ancestorNodeIds: [deterministicNodeId("s1", "root-provider"), deterministicNodeId("s1", "trips")]
    });
  });

  it("persists nodes and checkpoint atomically so a simulated pre-commit crash resumes cleanly", async () => {
    const repository = await seededRepository();
    repository.failNextIndexCommitForTest();

    await expect(
      runIndexBatch(batchContext(repository), {
        items: [image("photo", "Photo.jpg", "root-provider")],
        nextCursor: "resume-here"
      })
    ).rejects.toThrow(/simulated/i);

    expect(await repository.getNode(deterministicNodeId("s1", "photo"))).toBeNull();
    expect((await repository.getSource("s1"))?.crawlCheckpoint).toBeNull();

    await runIndexBatch(batchContext(repository), {
      items: [image("photo", "Photo.jpg", "root-provider")],
      nextCursor: "resume-here"
    });
    expect((await repository.getSource("s1"))?.crawlCheckpoint?.providerPageCursor).toBe("resume-here");
  });

  it("applies moves and deletes idempotently while keeping unavailable history targets", async () => {
    const repository = await seededRepository();
    await runIndexBatch(batchContext(repository), {
      items: [folder("a", "A"), folder("b", "B"), image("photo", "Photo.jpg", "a")],
      nextCursor: null
    });
    await runIndexBatch(batchContext(repository, "delta"), {
      changes: [
        { providerNodeId: "photo", removed: false, node: image("photo", "Renamed.jpg", "b") }
      ],
      nextCursor: "delta-2",
      deltaCursor: null
    });
    expect(await repository.getNode(deterministicNodeId("s1", "photo"))).toMatchObject({
      name: "Renamed.jpg",
      parentNodeId: deterministicNodeId("s1", "b"),
      available: true
    });

    await runIndexBatch(batchContext(repository, "delta"), {
      changes: [{ providerNodeId: "photo", removed: true, node: null }],
      nextCursor: null,
      deltaCursor: "delta-final"
    });
    expect(await repository.getNode(deterministicNodeId("s1", "photo"))).toMatchObject({
      available: false
    });
    expect((await repository.getSource("s1"))?.deltaCursor).toBe("delta-final");
    expect(await repository.getNode(deterministicNodeId("s1", "a"))).toMatchObject({ childMediaCount: 0, folderCoverNodeIds: [] });
  });

  it("reconciles stale generations in bounded batches instead of deleting nodes", async () => {
    const repository = await seededRepository();
    await runIndexBatch(batchContext(repository, "initial", "generation-old"), {
      items: [image("old-1", "Old 1.jpg", "root-provider"), image("old-2", "Old 2.jpg", "root-provider")],
      nextCursor: null
    });
    await runIndexBatch(batchContext(repository, "initial", "generation-new"), {
      items: [image("old-1", "Old 1.jpg", "root-provider")],
      nextCursor: null
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "reconciler", now, expiresAt: later() });

    const first = await runReconciliationBatch({
      repository,
      sourceId: "s1",
      generation: "generation-new",
      now,
      limit: 1,
      leaseOwner: "reconciler"
    });
    expect(first.processed).toBe(1);
    expect(first.complete).toBe(true);
    expect(await repository.getNode(deterministicNodeId("s1", "old-2"))).toMatchObject({
      available: false
    });
  });

  it("reconciliation removes stale media from ancestor counts and covers", async () => {
    const repository = await seededRepository();
    await runIndexBatch(batchContext(repository, "initial", "old"), {
      items: [folder("trips", "Trips"), image("old", "Old.jpg", "trips")],
      nextCursor: null
    });
    const folderId = deterministicNodeId("s1", "trips");
    expect(await repository.getNode(folderId)).toMatchObject({ childMediaCount: 1, folderCoverNodeIds: [deterministicNodeId("s1", "old")] });
    const source = (await repository.getSource("s1"))!;
    await repository.putSource({ ...source, crawlCheckpoint: { mode: "reconcile", providerPageCursor: null, processedNodeCount: 0, generation: "new", reconciliationCursor: null } });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "reconciler", now, expiresAt: later() });
    await runReconciliationBatch({ repository, sourceId: "s1", generation: "new", now, limit: 10, leaseOwner: "reconciler" });
    expect(await repository.getNode(folderId)).toMatchObject({ childMediaCount: 0, folderCoverNodeIds: [] });
  });

  it("recomputes only affected ancestor covers deterministically with unique preview media", async () => {
    const repository = await seededRepository();
    await runIndexBatch(batchContext(repository), {
      items: [
        image("older", "Older.jpg", "trips", "2026-01-01T00:00:00Z"),
        image("newer-b", "Newer B.jpg", "trips", "2026-02-01T00:00:00Z"),
        image("newer-a", "Newer A.jpg", "trips", "2026-02-01T00:00:00Z"),
        folder("trips", "Trips")
      ],
      nextCursor: null
    });

    expect(await repository.getNode(deterministicNodeId("s1", "trips"))).toMatchObject({
      folderCoverNodeIds: [
        deterministicNodeId("s1", "newer-a"),
        deterministicNodeId("s1", "newer-b"),
        deterministicNodeId("s1", "older")
      ],
      childMediaCount: 3
    });
  });

  it("enforces a fixed provider-page bound", async () => {
    const repository = await seededRepository();
    const items = Array.from({ length: MAX_INDEX_BATCH_SIZE + 1 }, (_, index) =>
      image(`p-${index}`, `${index}.jpg`, "root-provider")
    );
    await expect(
      runIndexBatch(batchContext(repository), { items, nextCursor: null })
    ).rejects.toThrow(/batch/i);
  });

  it("allows only one active source lease owner", async () => {
    const repository = await seededRepository();
    const [first, second] = await Promise.all([
      repository.acquireSyncLease({ sourceId: "s1", owner: "a", now, expiresAt: new Date(now.getTime() + 60_000) }),
      repository.acquireSyncLease({ sourceId: "s1", owner: "b", now, expiresAt: new Date(now.getTime() + 60_000) })
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("normalizes source index state independently of API encoding", () => {
    expect(sourceIndexStateKind(source(), 0)).toBe("unselected");
    expect(sourceIndexStateKind(source(), 1)).toBe("queued");
    expect(sourceIndexStateKind({ ...source(), activeWorkflowRunId: "run-1" }, 1)).toBe("indexing");
    expect(sourceIndexStateKind({ ...source(), status: "healthy", deltaCursor: "delta-1" }, 1)).toBe("healthy");
  });

  it.each([
    ["initial", { status: "healthy" as const, deltaCursor: null, crawlCheckpoint: null }],
    ["reconcile", {
      status: "syncing" as const,
      deltaCursor: "delta-1",
      crawlCheckpoint: {
        mode: "reconcile" as const,
        providerPageCursor: null,
        processedNodeCount: 4,
        generation: "generation-reconcile",
        reconciliationCursor: "node-4"
      }
    }],
    ["initial", { status: "error" as const, deltaCursor: "delta-1", crawlCheckpoint: null }]
  ])("manual Sync now selects %s from persisted source state", async (expectedMode, patch) => {
    const repository = await seededRepository();
    const current = (await repository.getSource("s1"))!;
    await repository.putSource({ ...current, ...patch });
    const launches: string[] = [];
    const indexing = createIndexingService({
      repository,
      workflowLauncher: {
        async start(_sourceId, mode) {
          launches.push(mode);
          return { runId: `run-${mode}` };
        }
      },
      householdId: "h1",
      cronSecret: "cron",
      now: () => now,
      createOwner: () => `manual-${expectedMode}`
    });

    await expect(indexing.startSource("s1")).resolves.toMatchObject({ started: true });
    expect(launches).toEqual([expectedMode]);
  });

  it.each([
    ["initial", { status: "healthy" as const, deltaCursor: null, crawlCheckpoint: null }],
    ["reconcile", {
      status: "syncing" as const,
      deltaCursor: "delta-1",
      crawlCheckpoint: {
        mode: "reconcile" as const,
        providerPageCursor: null,
        processedNodeCount: 4,
        generation: "generation-reconcile",
        reconciliationCursor: "node-4"
      }
    }],
    ["initial", { status: "error" as const, deltaCursor: "delta-1", crawlCheckpoint: null }]
  ])("due-source launch selects %s from persisted source state", async (expectedMode, patch) => {
    const repository = await seededRepository();
    const current = (await repository.getSource("s1"))!;
    await repository.putSource({ ...current, ...patch });
    const launches: string[] = [];
    const indexing = createIndexingService({
      repository,
      workflowLauncher: {
        async start(_sourceId, mode) {
          launches.push(mode);
          return { runId: `run-${mode}` };
        }
      },
      householdId: "h1",
      cronSecret: "cron",
      now: () => now,
      createOwner: () => `due-${expectedMode}`
    });

    await expect(indexing.startDueSources("Bearer cron", 1)).resolves.toEqual({
      leased: 1,
      started: 1,
      failed: 0
    });
    expect(launches).toEqual([expectedMode]);
  });

  it("uses an injected workflow launcher and leases only a bounded due-source set", async () => {
    const repository = await seededRepository();
    const starts: string[] = [];
    const indexing = createIndexingService({
      repository,
      workflowLauncher: {
        async start(sourceId, mode) {
          starts.push(`${sourceId}:${mode}`);
          return { runId: `run-${sourceId}` };
        }
      },
      householdId: "h1",
      cronSecret: "cron-secret",
      now: () => now,
      createOwner: () => "cron-owner"
    });
    const result = await indexing.startDueSources("Bearer cron-secret", 1);
    expect(result).toEqual({ leased: 1, started: 1, failed: 0 });
    expect(starts).toEqual(["s1:initial"]);
    expect((await repository.getSource("s1"))?.activeWorkflowRunId).toBe("run-s1");
  });

  it("does not resurrect syncing state when a fast workflow finishes before start returns", async () => {
    const repository = await seededRepository();
    const indexing = createIndexingService({
      repository,
      workflowLauncher: {
        async start(sourceId, _mode, owner) {
          await repository.completeSyncRun({ sourceId, leaseOwner: owner, completedAt: now, nextSyncAt: later() });
          return { runId: "already-finished" };
        }
      },
      householdId: "h1", cronSecret: "cron", now: () => now, createOwner: () => "fast-owner"
    });
    await expect(indexing.startSource("s1", "delta")).resolves.toMatchObject({ started: false });
    expect(await repository.getSource("s1")).toMatchObject({ status: "healthy", activeWorkflowRunId: null, leaseOwner: null });
  });

  it("keeps a selected root in recoverable queued state when workflow launch fails", async () => {
    const repository = await seededRepository();
    await repository.enableRootAndResetInitial({
      root: root(),
      sourceId: "s1",
      resetAt: now
    });
    const indexing = createIndexingService({
      repository,
      workflowLauncher: {
        async start() { throw new Error("workflow unavailable"); }
      },
      householdId: "h1",
      cronSecret: "cron",
      now: () => now,
      createOwner: () => "failed-owner"
    });

    await expect(indexing.startSource("s1", "initial")).rejects.toThrow("workflow unavailable");
    expect(await repository.getSource("s1")).toMatchObject({
      status: "syncing",
      deltaCursor: null,
      crawlCheckpoint: null,
      activeWorkflowRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastSyncErrorCode: null
    });
  });

  it("rejects invalid cron secrets without leasing work", async () => {
    const repository = await seededRepository();
    const indexing = createIndexingService({
      repository,
      workflowLauncher: { start: async () => ({ runId: "never" }) },
      householdId: "h1",
      cronSecret: "cron-secret",
      now: () => now
    });
    await expect(indexing.startDueSources("Bearer wrong-secret")).rejects.toMatchObject({ code: "CRON_UNAUTHORIZED" });
    expect((await repository.getSource("s1"))?.leaseOwner).toBeNull();
  });

  it("keeps workflow launch injected until the production transformer is configured", async () => {
    const launches: Array<[string, string]> = [];
    const launcher = createInjectedWorkflowLauncher(async (sourceId, mode) => {
      launches.push([sourceId, mode]);
      return { runId: "run-1" };
    });
    await expect(launcher.start("s1", "initial", "owner-1")).resolves.toEqual({ runId: "run-1" });
    expect(launches).toEqual([["s1", "initial"]]);
  });

  it("starts transformed workflows through workflow/api metadata", async () => {
    const calls: Array<{ workflowId: string; args: unknown[] }> = [];
    const launcher = createWorkflowApiLauncher("workflow//test//syncSourceWorkflow", async (workflow, args) => {
      calls.push({ workflowId: workflow.workflowId, args });
      return { runId: "wrun-1" };
    });
    await expect(launcher.start("s1", "delta", "lease-1")).resolves.toEqual({ runId: "wrun-1" });
    expect(calls).toEqual([{
      workflowId: expect.stringContaining("syncSourceWorkflow"),
      args: ["s1", "delta", "lease-1"]
    }]);
  });

  it("creates each durable step runner at the step execution boundary", async () => {
    let factories = 0;
    const step = createWorkflowStep(() => {
      factories += 1;
      return { runNext: async () => ({ complete: factories === 2 }) };
    });
    await expect(step("s1", "initial", "lease-1")).resolves.toEqual({ complete: false });
    await expect(step("s1", "initial", "lease-1")).resolves.toEqual({ complete: true });
    expect(factories).toBe(2);
  });

  it("contains transformable workflow and step directives for Task 9 integration", async () => {
    const source = await import("node:fs/promises").then(fs => fs.readFile("workflows/sync-source.ts", "utf8"));
    expect(source).toContain('"use workflow"');
    expect(source).toContain('"use step"');
    expect(source).toMatch(/syncSourceWorkflow\(\s*sourceId: string/);
  });

  it("resumes initial crawl folder queues and transitions through reconciliation", async () => {
    const repository = await seededRepository();
    const pages = [
      { items: [folder("trips", "Trips")], nextCursor: null },
      { items: [image("photo", "Photo.jpg", "trips")], nextCursor: null }
    ];
    const adapter = {
      listFolder: async () => pages.shift() ?? { items: [], nextCursor: null }
    } as unknown as ProviderAdapter;
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => adapter },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now,
      createGeneration: () => "generation-crawl",
      pageSize: 10
    });

    await repository.acquireSyncLease({ sourceId: "s1", owner: "crawl-owner", now, expiresAt: later() });
    expect(await orchestrator.runNext("s1", "initial", "crawl-owner")).toEqual({ complete: false });
    expect(await repository.getNodeByProviderId("s1", "root-provider")).toMatchObject({
      kind: "folder",
      available: true,
      parentNodeId: null
    });
    expect((await repository.getSource("s1"))?.crawlCheckpoint).toMatchObject({
      currentProviderFolderId: "trips",
      pendingProviderFolderIds: ["trips"]
    });
    expect(await orchestrator.runNext("s1", "initial", "crawl-owner")).toEqual({ complete: false });
    expect((await repository.getSource("s1"))?.crawlCheckpoint?.mode).toBe("reconcile");
    expect(await orchestrator.runNext("s1", "initial", "crawl-owner")).toEqual({ complete: true });
    expect((await repository.getSource("s1"))?.crawlCheckpoint).toBeNull();
    expect(await repository.getSource("s1")).toMatchObject({
      status: "healthy",
      activeWorkflowRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null
    });
  });

  it("rejects a paused stale reconcile transition after a new root resets initial state", async () => {
    const repository = await seededRepository();
    const current = (await repository.getSource("s1"))!;
    await repository.putSource({
      ...current,
      crawlCheckpoint: {
        mode: "initial",
        providerPageCursor: null,
        processedNodeCount: 12,
        generation: "generation-old",
        rootProviderIds: ["root-provider"],
        currentProviderFolderId: null,
        pendingProviderFolderIds: [],
        pageFingerprint: "finished-old-page"
      },
      activeWorkflowRunId: "old-run"
    });
    await repository.acquireSyncLease({
      sourceId: "s1",
      owner: "old-owner",
      now,
      expiresAt: later()
    });
    const paused = pauseAfterRootSnapshot(repository);
    const orchestrator = createIndexOrchestrator({
      repository: paused.repository,
      providers: { get: () => ({}) as ProviderAdapter },
      getCredentials: async () => ({
        accessToken: "a",
        refreshToken: "r",
        accessTokenExpiresAt: later()
      }),
      now: () => now
    });

    const oldRun = orchestrator.runNext("s1", "initial", "old-owner");
    await paused.entered;
    await repository.enableRootAndResetInitial({
      root: {
        ...root(),
        id: "new-root",
        providerNodeId: "new-root-provider",
        displayName: "New root"
      },
      sourceId: "s1",
      resetAt: now
    });
    const resetSource = await repository.getSource("s1");
    paused.resume();

    await expect(oldRun).rejects.toMatchObject({ code: "SYNC_CHECKPOINT_STALE" });
    expect(await repository.getSource("s1")).toEqual(resetSource);
    expect(await repository.listRootsForSource("s1")).toHaveLength(2);
  });

  it("restarts an active initial crawl when its enabled root set changes", async () => {
    const repository = await seededRepository();
    await repository.putRoot({
      id: "root-removed",
      householdId: "h1",
      sourceId: "s1",
      providerNodeId: "movies",
      displayName: "Movies",
      ancestryProviderIds: [],
      enabled: true,
      createdAt: now
    });
    const keptRoot = indexedNode("root-provider", "folder", null, []);
    const removedRoot = indexedNode("movies", "folder", null, []);
    await repository.putNode(keptRoot);
    await repository.putNode(removedRoot);
    await repository.putNode(indexedNode(
      "removed-child",
      "folder",
      removedRoot.id,
      [removedRoot.id]
    ));
    await repository.putNode(indexedNode(
      "removed-photo",
      "image",
      deterministicNodeId("s1", "removed-child"),
      [removedRoot.id, deterministicNodeId("s1", "removed-child")]
    ));
    const active = (await repository.getSource("s1"))!;
    await repository.putSource({
      ...active,
      crawlCheckpoint: {
        mode: "initial",
        providerPageCursor: null,
        processedNodeCount: 12,
        generation: "generation-old",
        currentProviderFolderId: "removed-child",
        pendingProviderFolderIds: ["removed-child", "root-provider"],
        rootProviderIds: ["movies", "root-provider"]
      },
      activeWorkflowRunId: "run-1"
    });
    await repository.disableRoot({ householdId: "h1", rootId: "root-removed" });
    const listedFolders: string[] = [];
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: {
        get: () => ({
          async listFolder(input: { folderId: string }) {
            listedFolders.push(input.folderId);
            return {
              items: input.folderId === "root-provider"
                ? [image("kept-photo", "Kept.jpg", "root-provider")]
                : [],
              nextCursor: null
            };
          }
        } as unknown as ProviderAdapter)
      },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now,
      createGeneration: () => "generation-restarted"
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: false });
    expect(listedFolders).toEqual(["root-provider"]);
    expect(await repository.getSource("s1")).toMatchObject({
      crawlCheckpoint: {
        mode: "reconcile",
        generation: "generation-restarted"
      },
      leaseOwner: "owner",
      activeWorkflowRunId: "run-1"
    });
    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: true });
    expect(await repository.getNodeByProviderId("s1", "removed-child")).toMatchObject({ available: false });
    expect(await repository.getNodeByProviderId("s1", "removed-photo")).toMatchObject({ available: false });
  });

  it("restarts legacy initial checkpoints that lack an enabled-root snapshot", async () => {
    const repository = await seededRepository();
    const active = (await repository.getSource("s1"))!;
    await repository.putSource({
      ...active,
      crawlCheckpoint: {
        mode: "initial",
        providerPageCursor: null,
        processedNodeCount: 7,
        generation: "generation-legacy",
        currentProviderFolderId: "legacy-child",
        pendingProviderFolderIds: ["legacy-child"]
      }
    });
    const listedFolders: string[] = [];
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: {
        get: () => ({
          async listFolder(input: { folderId: string }) {
            listedFolders.push(input.folderId);
            return { items: [], nextCursor: null };
          }
        } as unknown as ProviderAdapter)
      },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now,
      createGeneration: () => "generation-restarted"
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "initial", "owner");
    expect(listedFolders).toEqual(["root-provider"]);
    expect(await repository.getSource("s1")).toMatchObject({
      crawlCheckpoint: { mode: "reconcile", generation: "generation-restarted" }
    });
  });

  it("reconciles all prior metadata without provider work when the last root is disabled mid-initial", async () => {
    const repository = await seededRepository();
    const rootNode = indexedNode("root-provider", "folder", null, []);
    await repository.putNode(rootNode);
    await repository.putNode(indexedNode("old-photo", "image", rootNode.id, [rootNode.id]));
    const active = (await repository.getSource("s1"))!;
    await repository.putSource({
      ...active,
      syncGeneration: "generation-old",
      crawlCheckpoint: {
        mode: "initial",
        providerPageCursor: null,
        processedNodeCount: 3,
        generation: "generation-old",
        currentProviderFolderId: "root-provider",
        pendingProviderFolderIds: ["root-provider"],
        rootProviderIds: ["root-provider"]
      }
    });
    await repository.disableRoot({ householdId: "h1", rootId: "root-1" });
    const listFolder = vi.fn();
    const getCredentials = vi.fn();
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ listFolder } as unknown as ProviderAdapter) },
      getCredentials,
      now: () => now,
      createGeneration: () => "generation-empty"
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: false });
    expect(await repository.getSource("s1")).toMatchObject({
      crawlCheckpoint: { mode: "reconcile", generation: "generation-empty" }
    });
    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: true });
    expect(listFolder).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
    expect(await repository.getNodeByProviderId("s1", "old-photo")).toMatchObject({ available: false });
  });

  it("performs no provider crawl when a source has no enabled roots", async () => {
    const repository = await seededRepository();
    await repository.disableRoot({ householdId: "h1", rootId: "root-1" });
    const listFolder = vi.fn(async () => ({ items: [], nextCursor: null }));
    const getCredentials = vi.fn(async () => ({
      accessToken: "a",
      refreshToken: "r",
      accessTokenExpiresAt: later()
    }));
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ listFolder } as unknown as ProviderAdapter) },
      getCredentials,
      now: () => now
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: true });
    expect(listFolder).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("stops an already-launched delta workflow without provider work after its last root is disabled", async () => {
    const repository = await seededRepository();
    const current = (await repository.getSource("s1"))!;
    await repository.putSource({ ...current, deltaCursor: "delta-1" });
    await repository.disableRoot({ householdId: "h1", rootId: "root-1" });
    const getChanges = vi.fn(async () => ({ changes: [], nextCursor: null, deltaCursor: "delta-2" }));
    const getCredentials = vi.fn(async () => ({
      accessToken: "a",
      refreshToken: "r",
      accessTokenExpiresAt: later()
    }));
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ getChanges } as unknown as ProviderAdapter) },
      getCredentials,
      now: () => now
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "delta", "owner")).resolves.toEqual({ complete: true });
    expect(getChanges).not.toHaveBeenCalled();
    expect(getCredentials).not.toHaveBeenCalled();
  });

  it("falls back from a queued delta run to a fresh initial scan with a live-only adapter", async () => {
    const repository = await seededRepository();
    const current = (await repository.getSource("s1"))!;
    await repository.putSource({ ...current, deltaCursor: "delta-1" });
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/files")) {
        return new Response(JSON.stringify({ files: [] }), {
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(null, { status: 500 });
    });
    const adapter = createGoogleDriveAdapter({
      clientId: "client",
      clientSecret: "secret",
      fetch,
      now: () => now
    });
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => adapter },
      getCredentials: async () => ({
        accessToken: "access",
        refreshToken: null,
        accessTokenExpiresAt: later()
      }),
      now: () => now,
      createGeneration: () => "generation-fallback"
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "delta", "owner")).resolves.toEqual({ complete: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await repository.getSource("s1")).toMatchObject({
      crawlCheckpoint: {
        mode: "reconcile",
        generation: "generation-fallback"
      }
    });
  });

  it("drops delta nodes outside every enabled root", async () => {
    const repository = await seededRepository();
    await repository.putNode(indexedNode("root-provider", "folder", null, []));
    const getChanges = vi.fn(async () => ({
      changes: [
        change(image("inside", "Inside.jpg", "root-provider")),
        change(image("outside", "Outside.jpg", "unselected"))
      ],
      nextCursor: null,
      deltaCursor: "next"
    }));
    const orchestrator = deltaOrchestrator(repository, getChanges);
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "delta", "owner");
    expect(await repository.getNodeByProviderId("s1", "inside")).not.toBeNull();
    expect(await repository.getNodeByProviderId("s1", "outside")).toBeNull();
  });

  it("resolves delta ancestry independently of provider change ordering", async () => {
    const repository = await seededRepository();
    await repository.putNode(indexedNode("root-provider", "folder", null, []));
    const getChanges = vi.fn(async () => ({
      changes: [
        change(image("child", "Child.jpg", "new-parent")),
        change(folder("new-parent", "New parent"))
      ],
      nextCursor: null,
      deltaCursor: "next"
    }));
    const orchestrator = deltaOrchestrator(repository, getChanges);
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "delta", "owner");
    expect(await repository.getNodeByProviderId("s1", "child")).toMatchObject({
      parentNodeId: deterministicNodeId("s1", "new-parent"),
      available: true
    });
  });

  it("does not admit a delta child through a parent removed in the same page", async () => {
    const repository = await seededRepository();
    const rootNode = indexedNode("root-provider", "folder", null, []);
    const removedParent = indexedNode("removed-parent", "folder", rootNode.id, [rootNode.id]);
    await repository.putNode(rootNode);
    await repository.putNode(removedParent);
    const getChanges = vi.fn(async () => ({
      changes: [
        change(image("orphan", "Orphan.jpg", "removed-parent")),
        { providerNodeId: "removed-parent", removed: true, node: null }
      ],
      nextCursor: null,
      deltaCursor: "next"
    }));
    const orchestrator = deltaOrchestrator(repository, getChanges);
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "delta", "owner");
    expect(await repository.getNodeByProviderId("s1", "orphan")).toBeNull();
    expect(await repository.getNodeByProviderId("s1", "removed-parent")).toMatchObject({ available: false });
  });

  it("cascades a removed folder to all available descendants and availability counts", async () => {
    const repository = await seededRepository();
    await runIndexBatch(batchContext(repository, "initial", "generation-old"), {
      items: [
        folder("album", "Album"),
        folder("nested", "Nested", "album"),
        image("nested-photo", "Nested.jpg", "nested"),
        image("root-photo", "Root.jpg", "root-provider")
      ],
      nextCursor: null
    });

    await runIndexBatch(batchContext(repository, "delta", "generation-delta"), {
      changes: [{ providerNodeId: "album", removed: true, node: null }],
      nextCursor: null,
      deltaCursor: "delta-next"
    });

    expect(await repository.getNodeByProviderId("s1", "album")).toMatchObject({ available: false });
    expect(await repository.getNodeByProviderId("s1", "nested")).toMatchObject({ available: false });
    expect(await repository.getNodeByProviderId("s1", "nested-photo")).toMatchObject({ available: false });
    expect(await repository.getNodeByProviderId("s1", "root-photo")).toMatchObject({ available: true });
    expect(await repository.countNodesForHousehold("h1")).toEqual({ total: 4, available: 1 });
  });

  it("does not cascade removal of a non-folder node", async () => {
    const repository = await seededRepository();
    const imageNode = indexedNode("image-parent", "image", null, []);
    const malformedChild = indexedNode("malformed-child", "image", imageNode.id, [imageNode.id]);
    await repository.putNode(imageNode);
    await repository.putNode(malformedChild);

    await runIndexBatch(batchContext(repository, "delta", "generation-delta"), {
      changes: [{ providerNodeId: "image-parent", removed: true, node: null }],
      nextCursor: null,
      deltaCursor: "delta-next"
    });

    expect(await repository.getNodeByProviderId("s1", "image-parent")).toMatchObject({ available: false });
    expect(await repository.getNodeByProviderId("s1", "malformed-child")).toMatchObject({ available: true });
  });

  it("does not trust an available indexed parent outside selected-root ancestry", async () => {
    const repository = await seededRepository();
    await repository.putNode(indexedNode("outside-parent", "folder", null, []));
    const getChanges = vi.fn(async () => ({
      changes: [change(image("outside-child", "Outside child.jpg", "outside-parent"))],
      nextCursor: null,
      deltaCursor: "next"
    }));
    const orchestrator = deltaOrchestrator(repository, getChanges);
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "delta", "owner");
    expect(await repository.getNodeByProviderId("s1", "outside-child")).toBeNull();
  });

  it("treats a move out of every selected root as a removal", async () => {
    const repository = await seededRepository();
    const rootNode = indexedNode("root-provider", "folder", null, []);
    const photo = indexedNode("photo", "image", rootNode.id, [rootNode.id]);
    await repository.putNode(rootNode);
    await repository.putNode(photo);
    const getChanges = vi.fn(async () => ({
      changes: [change(image("photo", "Moved.jpg", "outside-parent"))],
      nextCursor: null,
      deltaCursor: "next"
    }));
    const orchestrator = deltaOrchestrator(repository, getChanges);
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "delta", "owner");
    expect(await repository.getNodeByProviderId("s1", "photo")).toMatchObject({
      parentNodeId: rootNode.id,
      available: false
    });
  });

  it("cascades descendants when a folder moves out of every selected root", async () => {
    const repository = await seededRepository();
    const rootNode = indexedNode("root-provider", "folder", null, []);
    const movedFolder = indexedNode("moved-folder", "folder", rootNode.id, [rootNode.id]);
    const child = indexedNode("moved-child", "image", movedFolder.id, [rootNode.id, movedFolder.id]);
    await repository.putNode(rootNode);
    await repository.putNode(movedFolder);
    await repository.putNode(child);
    const orchestrator = deltaOrchestrator(repository, async () => ({
      changes: [change(folder("moved-folder", "Moved", "outside-parent"))],
      nextCursor: null,
      deltaCursor: "next"
    }));
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await orchestrator.runNext("s1", "delta", "owner");
    expect(await repository.getNodeByProviderId("s1", "moved-folder")).toMatchObject({ available: false });
    expect(await repository.getNodeByProviderId("s1", "moved-child")).toMatchObject({ available: false });
  });

  it("marks nodes from a removed root unavailable during reconciliation", async () => {
    const repository = await seededRepository();
    await repository.putRoot({
      id: "root-removed",
      householdId: "h1",
      sourceId: "s1",
      providerNodeId: "movies",
      displayName: "Movies",
      ancestryProviderIds: [],
      enabled: true,
      createdAt: now
    });
    const keptRoot = indexedNode("root-provider", "folder", null, []);
    const removedRoot = indexedNode("movies", "folder", null, []);
    await repository.putNode(keptRoot);
    await repository.putNode(indexedNode("kept-child", "image", keptRoot.id, [keptRoot.id]));
    await repository.putNode(removedRoot);
    await repository.putNode(indexedNode("removed-child", "image", removedRoot.id, [removedRoot.id]));
    await repository.disableRoot({ householdId: "h1", rootId: "root-removed" });
    const listFolder = vi.fn(async () => ({
      items: [image("kept-child", "Kept.jpg", "root-provider")],
      nextCursor: null
    }));
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ listFolder } as unknown as ProviderAdapter) },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now,
      createGeneration: () => "generation-new"
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: false });
    await expect(orchestrator.runNext("s1", "initial", "owner")).resolves.toEqual({ complete: true });
    expect(await repository.getNodeByProviderId("s1", "removed-child")).toMatchObject({ available: false });
  });

  it("records Firestore quota exhaustion as a recoverable terminal index state", async () => {
    const repository = await seededRepository();
    const quotaError = Object.assign(new Error("Quota exceeded"), { code: 8 });
    vi.spyOn(repository, "commitIndexBatch").mockRejectedValueOnce(quotaError);
    const recordFailure = vi.spyOn(repository, "recordSyncFailure");
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: {
        get: () => ({
          listFolder: async () => ({ items: [], nextCursor: null })
        } as unknown as ProviderAdapter)
      },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "initial", "owner")).rejects.toThrow("Quota exceeded");
    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "s1",
      status: "error",
      errorCode: "RESOURCE_EXHAUSTED",
      nextSyncAt: null
    }));
    expect(await repository.getSource("s1")).toMatchObject({
      status: "error",
      lastSyncErrorCode: "RESOURCE_EXHAUSTED",
      nextSyncAt: null,
      leaseOwner: null,
      leaseExpiresAt: null
    });
  });

  it("records quota exhaustion against a checkpoint advanced earlier in the same step", async () => {
    const repository = await seededRepository();
    const current = (await repository.getSource("s1"))!;
    await repository.putSource({ ...current, deltaCursor: "delta-1" });
    await repository.putNode(indexedNode("root-provider", "folder", null, []));
    const quotaError = Object.assign(new Error("Completion quota exceeded"), { code: "RESOURCE_EXHAUSTED" });
    vi.spyOn(repository, "completeSyncRun").mockRejectedValueOnce(quotaError);
    const orchestrator = deltaOrchestrator(repository, async () => ({
      changes: [],
      nextCursor: null,
      deltaCursor: "delta-2"
    }));
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "delta", "owner")).rejects.toBe(quotaError);
    expect(await repository.getSource("s1")).toMatchObject({
      status: "error",
      deltaCursor: "delta-2",
      crawlCheckpoint: { mode: "delta", generation: "generation-delta" },
      lastSyncErrorCode: "RESOURCE_EXHAUSTED",
      nextSyncAt: null,
      leaseOwner: null
    });
  });

  it("does not mask the original quota error when quota-state persistence also fails", async () => {
    const repository = await seededRepository();
    const quotaError = Object.assign(new Error("Original quota exceeded"), { code: 8 });
    vi.spyOn(repository, "commitIndexBatch").mockRejectedValueOnce(quotaError);
    vi.spyOn(repository, "recordSyncFailure").mockRejectedValueOnce(
      Object.assign(new Error("Failure-state write also exhausted quota"), { code: 8 })
    );
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: {
        get: () => ({
          listFolder: async () => ({ items: [], nextCursor: null })
        } as unknown as ProviderAdapter)
      },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });

    await expect(orchestrator.runNext("s1", "initial", "owner")).rejects.toBe(quotaError);
  });

  it("records throttling cadence and reauthentication without deleting metadata", async () => {
    const repository = await seededRepository();
    const throttled = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ getChanges: async () => { throw new ProviderError("PROVIDER_THROTTLED", "slow", { retryable: true, retryAfterSeconds: 90 }); } } as unknown as ProviderAdapter) },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now
    });
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });
    await expect(throttled.runNext("s1", "delta", "owner")).rejects.toMatchObject({ code: "PROVIDER_THROTTLED" });
    expect(await repository.getSource("s1")).toMatchObject({
      status: "error",
      lastSyncErrorCode: "PROVIDER_THROTTLED",
      nextSyncAt: new Date(now.getTime() + 90_000)
    });

    const reauth = createIndexOrchestrator({
      repository,
      providers: { get: () => ({}) as ProviderAdapter },
      getCredentials: async () => { throw new ProviderError("PROVIDER_REAUTH_REQUIRED", "reauth", { retryable: false }); },
      now: () => now
    });
    await repository.putNode(indexedFixtureNode());
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner", now, expiresAt: later() });
    await expect(reauth.runNext("s1", "delta", "owner")).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(await repository.getSource("s1")).toMatchObject({ status: "reauth-required" });
    expect(await repository.listNodesForSource("s1")).not.toEqual([]);
  });

  it("ignores a stale provider failure after a newer owner advances the source", async () => {
    const repository = await seededRepository();
    await repository.acquireSyncLease({ sourceId: "s1", owner: "old-owner", now, expiresAt: later() });
    let rejectBlocked!: (error: unknown) => void;
    const blocked = new Promise<never>((_resolve, reject) => { rejectBlocked = reject; });
    const orchestrator = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ getChanges: () => blocked } as unknown as ProviderAdapter) },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now
    });
    const oldRun = orchestrator.runNext("s1", "delta", "old-owner");
    await Promise.resolve();
    await repository.releaseSyncLease("s1", "old-owner");
    await repository.acquireSyncLease({ sourceId: "s1", owner: "new-owner", now, expiresAt: later() });
    const advanced = (await repository.getSource("s1"))!;
    const newCheckpoint = { mode: "delta" as const, providerPageCursor: "new-page", processedNodeCount: 99, generation: "new-generation" };
    await repository.putSource({ ...advanced, crawlCheckpoint: newCheckpoint, deltaCursor: "new-delta", activeWorkflowRunId: "new-run" });
    rejectBlocked(new ProviderError("PROVIDER_THROTTLED", "late", { retryable: true, retryAfterSeconds: 90 }));
    await expect(oldRun).rejects.toMatchObject({ code: "PROVIDER_THROTTLED" });
    expect(await repository.getSource("s1")).toMatchObject({
      leaseOwner: "new-owner",
      crawlCheckpoint: newCheckpoint,
      deltaCursor: "new-delta",
      activeWorkflowRunId: "new-run",
      lastSyncErrorCode: null
    });
  });

  it("ignores a provider failure after the same owner's lease expires", async () => {
    const repository = await seededRepository();
    await repository.acquireSyncLease({
      sourceId: "s1",
      owner: "expired-owner",
      now,
      expiresAt: new Date(now.getTime() + 1_000)
    });
    const source = (await repository.getSource("s1"))!;
    await expect(repository.recordSyncFailure({
      sourceId: "s1",
      expectedLeaseOwner: "expired-owner",
      expectedCheckpoint: source.crawlCheckpoint,
      failedAt: new Date(now.getTime() + 2_000),
      status: "error",
      errorCode: "PROVIDER_TIMEOUT",
      nextSyncAt: new Date(now.getTime() + 60_000)
    })).resolves.toBe(false);
    expect(await repository.getSource("s1")).toMatchObject({
      status: "syncing",
      leaseOwner: "expired-owner",
      lastSyncErrorCode: null
    });
  });

  it("rejects stale lease owners and expired long-running batches", async () => {
    const repository = await seededRepository();
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner-a", now, expiresAt: new Date(now.getTime() + 1_000) });
    await expect(runIndexBatch({ ...batchContext(repository), leaseOwner: "owner-b" }, { items: [], nextCursor: "next" })).rejects.toMatchObject({ code: "SYNC_LEASE_STALE" });
    await expect(runIndexBatch({ ...batchContext(repository), now: new Date(now.getTime() + 2_000), leaseOwner: "owner-a" }, { items: [], nextCursor: "next" })).rejects.toMatchObject({ code: "SYNC_LEASE_STALE" });
  });

  it("renews the same lease owner on every bounded index step", async () => {
    const repository = await seededRepository();
    await repository.acquireSyncLease({ sourceId: "s1", owner: "owner-a", now, expiresAt: new Date(now.getTime() + 1_000) });
    await runIndexBatch({ ...batchContext(repository), leaseOwner: "owner-a" }, { items: [], nextCursor: "next" });
    expect(await repository.getSource("s1")).toMatchObject({
      leaseOwner: "owner-a",
      leaseExpiresAt: new Date(now.getTime() + 10 * 60 * 1000)
    });
  });
});

function later(): Date { return new Date(now.getTime() + 60 * 60 * 1000); }

function batchContext(
  repository: MemoryRepository,
  mode: "initial" | "delta" = "initial",
  generation = "generation-1"
) {
  return { repository, sourceId: "s1", mode, generation, now } as const;
}

function indexedFixtureNode() {
  return {
    id: deterministicNodeId("s1", "kept"), householdId: "h1", sourceId: "s1", provider: "google" as const,
    providerNodeId: "kept", parentNodeId: null, ancestorNodeIds: [], name: "Kept.jpg", normalizedName: "kept.jpg",
    kind: "image" as const, mimeType: "image/jpeg", size: 1, width: 1, height: 1, capturedAt: now,
    createdAtProvider: now, modifiedAtProvider: now, thumbnailRevision: "r", hasPreview: true,
    folderCoverNodeIds: [], childFolderCount: 0, childMediaCount: 0, available: true, indexedAt: now,
    syncGeneration: "old"
  };
}

function indexedNode(
  providerNodeId: string,
  kind: "folder" | "image",
  parentNodeId: string | null,
  ancestorNodeIds: string[]
) {
  return {
    id: deterministicNodeId("s1", providerNodeId),
    householdId: "h1",
    sourceId: "s1",
    provider: "google" as const,
    providerNodeId,
    parentNodeId,
    ancestorNodeIds,
    name: providerNodeId,
    normalizedName: providerNodeId,
    kind,
    mimeType: kind === "folder" ? null : "image/jpeg",
    size: kind === "folder" ? null : 1,
    width: kind === "folder" ? null : 1,
    height: kind === "folder" ? null : 1,
    capturedAt: null,
    createdAtProvider: now,
    modifiedAtProvider: now,
    thumbnailRevision: kind === "folder" ? null : "r",
    hasPreview: kind !== "folder",
    folderCoverNodeIds: [],
    childFolderCount: 0,
    childMediaCount: 0,
    available: true,
    indexedAt: now,
    syncGeneration: "generation-old"
  };
}

function change(value: ProviderNode) {
  return { providerNodeId: value.providerNodeId, removed: false, node: value };
}

function deltaOrchestrator(
  repository: MemoryRepository,
  getChanges: () => Promise<LegacyChangesPage>
) {
  return createIndexOrchestrator({
    repository,
    providers: { get: () => ({ getChanges } as unknown as ProviderAdapter) },
    getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
    now: () => now,
    createGeneration: () => "generation-delta"
  });
}

function pauseAfterRootSnapshot(repository: MemoryRepository): {
  repository: MemoryRepository;
  entered: Promise<void>;
  resume(): void;
} {
  let markEntered!: () => void;
  let resume!: () => void;
  let paused = false;
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  return {
    repository: new Proxy(repository, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "listRootsForSource" && typeof value === "function") {
          return async (...args: unknown[]) => {
            const roots = await Reflect.apply(value, target, args);
            if (!paused) {
              paused = true;
              markEntered();
              await gate;
            }
            return roots;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      }
    }),
    entered,
    resume
  };
}

async function seededRepository(): Promise<MemoryRepository> {
  const repository = new MemoryRepository();
  await repository.putSource(source());
  await repository.putRoot(root());
  return repository;
}

function source(): Source {
  return {
    id: "s1", householdId: "h1", provider: "google", providerAccountId: "account-1", providerRootId: null, accountLabel: "Family",
    encryptedRefreshToken: { keyVersion: "1", iv: "iv", ciphertext: "refresh", authTag: "tag" },
    encryptedAccessToken: null, accessTokenExpiresAt: null, status: "syncing", deltaCursor: null,
    crawlCheckpoint: null, activeWorkflowRunId: null, syncGeneration: null, nextSyncAt: null,
    leaseOwner: null, leaseExpiresAt: null, lastSyncStartedAt: null, lastSyncCompletedAt: null,
    lastSyncErrorCode: null, createdAt: now
  };
}

function root(): AssignedRoot {
  return { id: "root-1", householdId: "h1", sourceId: "s1", providerNodeId: "root-provider", displayName: "Family", ancestryProviderIds: [], enabled: true, createdAt: now };
}

function folder(providerNodeId: string, name: string, parentProviderId = "root-provider"): ProviderNode {
  return node({ providerNodeId, name, parentProviderId, kind: "folder", hasPreview: false });
}

function image(providerNodeId: string, name: string, parentProviderId: string, capturedAt = "2026-01-01T00:00:00Z"): ProviderNode {
  return node({ providerNodeId, name, parentProviderId, kind: "image", capturedAt: new Date(capturedAt), hasPreview: true });
}

function node(overrides: Partial<ProviderNode> & Pick<ProviderNode, "providerNodeId" | "name" | "kind">): ProviderNode {
  return {
    providerNodeId: overrides.providerNodeId, parentProviderId: overrides.parentProviderId ?? null,
    name: overrides.name, kind: overrides.kind, mimeType: overrides.kind === "folder" ? null : "image/jpeg",
    size: 100, width: 1920, height: 1080, capturedAt: overrides.capturedAt ?? null,
    createdAt: now, modifiedAt: now, thumbnailRevision: "r1", hasPreview: overrides.hasPreview ?? true
  };
}
