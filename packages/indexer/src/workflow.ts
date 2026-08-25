export type SyncMode = "initial" | "delta" | "reconcile";

export interface WorkflowLauncher {
  start(
    sourceId: string,
    mode: SyncMode,
    leaseOwner: string
  ): Promise<{ runId: string }>;
}

export interface SyncWorkflowRunner {
  runNext(
    sourceId: string,
    mode: SyncMode,
    leaseOwner: string
  ): Promise<{ complete: boolean }>;
}

let createRunner: (() => SyncWorkflowRunner) | null = null;

export function configureSyncSourceWorkflow(
  factory: () => SyncWorkflowRunner
): void {
  createRunner = factory;
}

export async function syncSourceWorkflow(
  sourceId: string,
  mode: SyncMode,
  leaseOwner: string
): Promise<void> {
  "use workflow";
  while (!(await runSyncStep(sourceId, mode, leaseOwner)).complete) {
    // Each loop is one bounded provider page persisted by the injected runner.
  }
}

async function runSyncStep(
  sourceId: string,
  mode: SyncMode,
  leaseOwner: string
) {
  "use step";
  if (!createRunner) {
    throw new Error("Sync workflow runner is not configured.");
  }
  return createRunner().runNext(sourceId, mode, leaseOwner);
}

export function createInjectedWorkflowLauncher(
  launch: (
    sourceId: string,
    mode: SyncMode,
    leaseOwner: string
  ) => Promise<{ runId: string }>
): WorkflowLauncher {
  return { start: launch };
}
