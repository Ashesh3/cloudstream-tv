import type { Source } from "./contracts";

export type SourceIndexStateKind =
  | "unselected"
  | "queued"
  | "indexing"
  | "reconciling"
  | "healthy"
  | "quota-exhausted"
  | "reauth-required"
  | "provider-error";

export function sourceIndexStateKind(
  source: Source,
  enabledRootCount: number
): SourceIndexStateKind {
  if (source.status === "reauth-required") return "reauth-required";
  if (source.lastSyncErrorCode === "RESOURCE_EXHAUSTED") return "quota-exhausted";
  if (source.status === "error") return "provider-error";
  if (enabledRootCount === 0) return "unselected";
  if (!source.activeWorkflowRunId && !source.crawlCheckpoint && !source.deltaCursor) {
    return "queued";
  }
  if (source.crawlCheckpoint?.mode === "reconcile") return "reconciling";
  if (source.crawlCheckpoint?.mode === "initial" || source.status === "syncing") {
    return "indexing";
  }
  return "healthy";
}
