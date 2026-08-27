import { StatePanel } from "./device-request";

export function WaitingScreen({ name, expiresAt }: { name: string; expiresAt: string }) {
  return (
    <StatePanel
      title="Waiting for approval"
      body="Open Cloudframe Admin on your phone, review this television, and choose at least one collection for its program."
      state="waiting-approval"
    >
      <p className="request-identity">{name} is queued in the household program ledger.</p>
      <div className="request-sent"><span aria-hidden="true"><i /></span><div><strong>Request sent securely</strong><small>Keep this screen open while the household administrator approves its program.</small></div></div>
      <div className="waiting-pulse" aria-label="Approval request pending"><i /><i /><i /></div>
      <p className="state-detail">Request expires {formatExpiry(expiresAt)}</p>
    </StatePanel>
  );
}

function formatExpiry(value: string): string {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "soon";
  }
}
