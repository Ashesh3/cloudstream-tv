import { StatePanel } from "./device-request";

export function WaitingScreen({ name, expiresAt }: { name: string; expiresAt: string }) {
  return <StatePanel title="Waiting for approval" body="Open Cloudframe Admin on your phone, review this television, and choose at least one collection." state="waiting-approval">
    <section className="waiting-status" role="status" aria-label="Approval request pending"><strong>Request sent securely</strong><p>{name} is queued in Cloudframe Admin. Keep this screen open while the household administrator approves its collections.</p><span className="waiting-indicator" aria-hidden="true" /></section>
    <p className="state-detail">Request expires {formatExpiry(expiresAt)}</p>
  </StatePanel>;
}

function formatExpiry(value: string): string {
  try { return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  catch { return "soon"; }
}
