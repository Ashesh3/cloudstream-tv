import { StatePanel } from "./device-request";

export function WaitingScreen({ name, expiresAt }: { name: string; expiresAt: string }) {
  return (
    <StatePanel
      eyebrow={name}
      title="Waiting for approval"
      body="Open Cloudframe Admin on your phone, choose this TV, and assign at least one folder."
    >
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
