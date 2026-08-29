import type { TranscodeDiagnosticResponse } from "@cloudframe/shared";
import { ActivityIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function TranscodeDiagnostics({ diagnostic, error = "" }: { diagnostic: TranscodeDiagnosticResponse | null; error?: string }) {
  return <Card className="transcode-diagnostics" role="region" aria-label="Transcoder status">
    <CardHeader><CardTitle className="flex items-center gap-2"><ActivityIcon className="size-4" />Transcoder status</CardTitle><CardDescription>Live, secret-safe playback and cache health from this server.</CardDescription></CardHeader>
    <CardContent>
      {error ? <p className="transcode-diagnostics-error" role="status">{error}</p> : diagnostic ? <>
        <div className="transcode-diagnostics-primary">
          <strong>{diagnostic.active ? diagnostic.active.itemName : "Transcoder ready"}</strong>
          <span>{activeDescription(diagnostic)}</span>
        </div>
        <dl className="transcode-diagnostics-grid">
          <Metric label="Queued windows" value={String(diagnostic.queuedDemandedWindows)} />
          <Metric label="Busy rejections" value={String(diagnostic.busyRejections)} />
          <Metric label="Cache" value={formatCache(diagnostic.cacheBytes, diagnostic.cacheMaxBytes)} />
          <Metric label="Last error" value={errorLabel(diagnostic.lastErrorCode)} />
        </dl>
        {diagnostic.busyRejections > 0 ? <p className="transcode-diagnostics-note">{diagnostic.busyRejections} busy {diagnostic.busyRejections === 1 ? "request was" : "requests were"} rejected. Another television currently owns the transcoder.</p> : null}
      </> : <p className="transcode-diagnostics-error" role="status">Loading transcoder status…</p>}
    </CardContent>
  </Card>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function activeDescription(value: TranscodeDiagnosticResponse): string {
  const active = value.active;
  if (!active) return "No active playback.";
  const provider = active.provider === "google" ? "Google Drive" : "OneDrive";
  const device = value.leaseDeviceName ?? "Approved television";
  if (active.stage === "probing") return `Probing from ${provider} for ${device}.`;
  const progress = active.progressPercent === null ? "Progress pending" : `${active.progressPercent}%`;
  const speed = active.speed ? ` at ${active.speed}` : "";
  return `${provider} · ${device} · Encoding window ${(active.windowIndex ?? 0) + 1} · ${progress}${speed}`;
}
function formatCache(used: number, maximum: number): string { return `${binary(used)} of ${binary(maximum)}`; }
function binary(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  return `${amount >= 10 || Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}
function errorLabel(code: string | null): string {
  if (!code) return "None";
  const labels: Record<string, string> = {
    TRANSCODER_BUSY: "Another television currently owns the transcoder",
    TRANSCODER_CACHE_FULL: "The transcode cache cannot safely grow",
    TRANSCODER_SOURCE_UNAVAILABLE: "The source could not be read",
    TRANSCODER_WINDOW_TIMEOUT: "A transcode window timed out",
    TRANSCODER_SESSION_EXPIRED: "A playback session expired",
    TRANSCODER_UNSUPPORTED: "The media format is unsupported",
    TRANSCODER_FAILED: "The last transcode failed",
  };
  return labels[code] ?? code;
}
