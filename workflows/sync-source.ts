import { createServerSyncWorkflowRunner } from "@cloudframe/server/runtime/sync-runner";
import type { SyncMode } from "@cloudframe/indexer";

export async function syncSourceWorkflow(
  sourceId: string,
  mode: SyncMode,
  leaseOwner: string
): Promise<void> {
  "use workflow";
  while (!(await runSyncStep(sourceId, mode, leaseOwner)).complete) {
    // One bounded, replay-safe provider page is persisted per durable step.
  }
}

async function runSyncStep(
  sourceId: string,
  mode: SyncMode,
  leaseOwner: string
) {
  "use step";
  return createServerSyncWorkflowRunner().runNext(sourceId, mode, leaseOwner);
}
