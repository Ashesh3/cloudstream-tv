import { describe, expect, it } from "vitest";

import {
  MAX_INDEX_BATCH_SIZE,
  createInjectedWorkflowLauncher,
  createIndexOrchestrator,
  deterministicNodeId,
  runIndexBatch,
  runReconciliationBatch
} from "@cloudframe/indexer";
import { createIndexingService, MemoryRepository } from "@cloudframe/server";
import type { AssignedRoot, Source } from "@cloudframe/shared";
import { ProviderError, type ProviderAdapter, type ProviderNode } from "@cloudframe/providers";

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
    expect(starts).toEqual(["s1:delta"]);
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

  it("contains transformable workflow and step directives for Task 9 integration", async () => {
    const source = await import("node:fs/promises").then(fs => fs.readFile("packages/indexer/src/workflow.ts", "utf8"));
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

  it("records throttling cadence and reauthentication without deleting metadata", async () => {
    const repository = await seededRepository();
    const throttled = createIndexOrchestrator({
      repository,
      providers: { get: () => ({ getChanges: async () => { throw new ProviderError("PROVIDER_THROTTLED", "slow", { retryable: true, retryAfterSeconds: 90 }); } } as unknown as ProviderAdapter) },
      getCredentials: async () => ({ accessToken: "a", refreshToken: "r", accessTokenExpiresAt: later() }),
      now: () => now
    });
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
    await expect(reauth.runNext("s1", "delta", "owner")).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(await repository.getSource("s1")).toMatchObject({ status: "reauth-required" });
    expect(await repository.listNodesForSource("s1")).not.toEqual([]);
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

async function seededRepository(): Promise<MemoryRepository> {
  const repository = new MemoryRepository();
  await repository.putSource(source());
  await repository.putRoot(root());
  return repository;
}

function source(): Source {
  return {
    id: "s1", householdId: "h1", provider: "google", providerAccountId: "account-1", accountLabel: "Family",
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
