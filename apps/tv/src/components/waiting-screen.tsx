import { StatePanel } from "./device-request";

export function WaitingScreen({ name, expiresAt }: { name: string; expiresAt: string }) {
  return (
    <StatePanel
      eyebrow={name}
      title="Waiting for approval"
      body="Open Cloudframe Admin on your phone, review this request, and choose at least one folder."
    >
      <div className="request-sent"><span aria-hidden="true">✓</span><div><strong>Request sent securely</strong><small>Keep this screen open while your household admin approves access.</small></div></div>
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
