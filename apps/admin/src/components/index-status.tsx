import type { SourceIndexStateDto } from "@cloudframe/shared";
import { AlertCircleIcon, CircleCheckIcon, Clock3Icon, RefreshCwIcon } from "lucide-react";
import { INDEX_COPY, formatIndexMeasure } from "../design/ledger";

export function IndexStatus({ state }: { state: SourceIndexStateDto }) {
  const copy = INDEX_COPY[state.kind];
  const headline = state.kind === "quota-exhausted"
    ? "Cloudframe indexing is paused by Firestore quota"
    : state.kind === "provider-error"
      ? "Folder listing failed"
      : copy.title;
  const Icon = copy.tone === "danger" || copy.tone === "warning"
    ? AlertCircleIcon
    : copy.tone === "active"
      ? RefreshCwIcon
      : state.kind === "healthy"
        ? CircleCheckIcon
        : Clock3Icon;
  return <section
    className="index-status grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-muted/50 p-3 text-sm"
    data-index-state={state.kind}
    data-tone={copy.tone}
    aria-live={copy.tone === "danger" || copy.tone === "warning" ? "assertive" : "polite"}
  >
    <Icon className="mt-0.5 size-4 text-muted-foreground" aria-hidden="true" />
    <div className="min-w-0">
      <p className="font-medium text-foreground">{headline}</p>
      <p className="mt-1 text-muted-foreground">{copy.description}</p>
      {(state.kind === "indexing" || state.kind === "reconciling" || state.kind === "queued") && <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">{formatIndexMeasure(state.processedNodeCount)} items prepared</span>
        <span className="tabular-nums">{formatIndexMeasure(state.pendingFolderCount)} folders pending</span>
      </p>}
    </div>
  </section>;
}
