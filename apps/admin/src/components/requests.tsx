import type { ReactNode } from "react";
import type { AssignedRootDto, DeviceRequestDto, SourceDto } from "@cloudframe/shared";
import { CheckIcon, Clock3Icon, FolderOpenIcon, MonitorIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty as EmptyPrimitive, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

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
  return <section aria-labelledby="device-requests-title" className="flex flex-col gap-5">
    <PageHeader eyebrow="Enrollment" title="Device requests" description="Review new televisions and choose exactly which cloud folders each device can browse." />
    {disabled && <Alert className="border-amber-200 bg-amber-50 text-amber-950"><ShieldAlertIcon /><AlertTitle>New requests are paused</AlertTitle><AlertDescription>Turn enrollment back on in Settings when you are ready to add another television.</AlertDescription></Alert>}
    {!sorted.length ? <Empty title="No pending requests" body="New televisions will appear here for 30 minutes after they request household access." icon={<MonitorIcon />} /> : <div className="grid gap-3">{sorted.map(request => <Card data-testid="request-card" key={request.id} className="shadow-xs transition-shadow hover:shadow-sm">
      <CardHeader className="items-start gap-3 sm:grid-cols-[auto_1fr]">
        <span className="row-span-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><MonitorIcon /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><CardTitle className="text-base">{request.requestedName}</CardTitle><Badge variant="secondary">Pending</Badge></div>
          <CardDescription className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-1"><Clock3Icon className="size-3.5" />Requested {relativeTime(request.createdAt)}</span>
            <span>Expires {relativeTime(request.expiresAt)}</span>
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><FolderOpenIcon className="size-4" />{roots.filter(root => root.enabled).length} available folders across {sources.length} {sources.length === 1 ? "source" : "sources"}</p>
      </CardContent>
      <CardFooter className="justify-end gap-2"><Button variant="outline" disabled={pendingId === request.id} aria-label={`Deny ${request.requestedName}`} onClick={() => onDeny(request)}><XIcon data-icon="inline-start" />{pendingId === request.id ? "Denying…" : "Deny"}</Button><Button aria-label={`Approve ${request.requestedName}`} onClick={() => onApprove(request)}><CheckIcon data-icon="inline-start" />Review access</Button></CardFooter>
    </Card>)}</div>}
  </section>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="mb-2 text-xs font-semibold uppercase tracking-[.16em] text-primary">{eyebrow}</p><h1 id={`${title.toLowerCase().replace(/\s/g, "-")}-title`} className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">{description}</p></div>{action}</header>;
}
export function Empty({ title, body, icon = <FolderOpenIcon /> }: { title: string; body: string; icon?: ReactNode }) { return <EmptyPrimitive className="min-h-80 border bg-card"><EmptyHeader><EmptyMedia variant="icon" className="size-12 rounded-xl">{icon}</EmptyMedia><EmptyTitle className="text-base">{title}</EmptyTitle><EmptyDescription>{body}</EmptyDescription></EmptyHeader></EmptyPrimitive>; }
export function relativeTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "at an unknown time" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
