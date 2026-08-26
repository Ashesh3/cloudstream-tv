import type { AssignedRootDto, DeviceRequestDto, SourceDto } from "@cloudframe/shared";

export function Requests({ requests, roots, sources, disabled, pendingId, onApprove, onDeny }: {
  requests: DeviceRequestDto[];
  roots: AssignedRootDto[];
  sources: SourceDto[];
  disabled: boolean;
  pendingId: string | null;
  onApprove(request: DeviceRequestDto): void;
  onDeny(request: DeviceRequestDto): void;
}) {
  const sorted = [...requests].filter(request => request.status === "pending").sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return <section aria-labelledby="device-requests-title">
    <PageHeader eyebrow="Enrollment" title="Device requests" description="Approve a television and choose exactly which cloud folders it can browse." />
    {disabled && <div className="notice warning"><strong>New requests are paused</strong><span>Turn them on in Settings when you are ready to add another TV.</span></div>}
    {!sorted.length ? <Empty title="No pending requests" body="New televisions will appear here for 30 minutes after they request access." /> : <div className="card-list">{sorted.map(request => <article data-testid="request-card" className="request-card" key={request.id}>
      <div className="device-avatar" aria-hidden="true">TV</div>
      <div className="card-copy"><div className="card-title-row"><h2>{request.requestedName}</h2><span className="status pending">Pending</span></div><p>Requested {relativeTime(request.createdAt)} · Expires {relativeTime(request.expiresAt)}</p><small>{roots.filter(root => root.enabled).length} available roots across {sources.length} sources</small></div>
      <div className="card-actions"><button className="button secondary" disabled={pendingId === request.id} aria-label={`Deny ${request.requestedName}`} onClick={() => onDeny(request)}>{pendingId === request.id ? "Denying…" : "Deny"}</button><button className="button primary" aria-label={`Approve ${request.requestedName}`} onClick={() => onApprove(request)}>Approve</button></div>
    </article>)}</div>}
  </section>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1 id={`${title.toLowerCase().replace(/\s/g, "-")}-title`}>{title}</h1><p>{description}</p></div>{action}</header>;
}
export function Empty({ title, body }: { title: string; body: string }) { return <div className="empty-state"><div aria-hidden="true" className="empty-art"><i /><i /><i /></div><h2>{title}</h2><p>{body}</p></div>; }
export function relativeTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
