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

export type WorkflowStep = (
  sourceId: string,
  mode: SyncMode,
  leaseOwner: string
) => Promise<{ complete: boolean }>;

export function createWorkflowStep(
  factory: () => SyncWorkflowRunner
): WorkflowStep {
  return (sourceId, mode, leaseOwner) =>
    factory().runNext(sourceId, mode, leaseOwner);
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

export interface WorkflowStartApi {
  (
    workflow: { workflowId: string },
    args: unknown[]
  ): Promise<{ runId: string }>;
}

export function createWorkflowApiLauncher(
  workflowId: string,
  startWorkflow: WorkflowStartApi
): WorkflowLauncher {
  if (!workflowId.includes("syncSourceWorkflow")) {
    throw new Error("Sync workflow metadata is invalid");
  }
  return {
    start(sourceId, mode, leaseOwner) {
      return startWorkflow({ workflowId }, [sourceId, mode, leaseOwner]);
    }
  };
}
