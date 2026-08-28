import { useEffect, useRef, useState } from "react";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import type { AdminApi, AdminImpact } from "../api/client";
import { Dialog } from "./dialog";
import { FolderPicker } from "./folder-picker";
import { Empty, PageHeader } from "./requests";
import { CloudIcon, FolderCogIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function Sources({ sources, roots, devices, api, onRootAdded, onRootRemoved, onRemoveSource, onAuthorize }: {
  sources: ControlSourceDto[];
  roots: ControlRootDto[];
  devices: ControlDeviceDto[];
  api: AdminApi;
  onRootAdded(root: ControlRootDto): Promise<boolean>;
  onRootRemoved(rootId: string): Promise<boolean>;
  onRemoveSource(sourceId: string): Promise<void>;
  onAuthorize(provider: "google" | "onedrive", reconnect?: string): Promise<void>;
}) {
  const [pickerId, setPicker] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ControlSourceDto | null>(null);
  const [impact, setImpact] = useState<AdminImpact | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const pickerTrigger = useRef<HTMLButtonElement | null>(null);
  const openedPickerId = useRef<string | null>(null);
  const previousPickerId = useRef<string | null>(null);
  const impactGeneration = useRef(0);
  useEffect(() => { if (previousPickerId.current && !pickerId) pickerTrigger.current?.focus(); previousPickerId.current = pickerId; }, [pickerId]);
  useEffect(() => () => { impactGeneration.current += 1; }, []);

  const previewRemoval = async (source: ControlSourceDto) => {
    const generation = ++impactGeneration.current;
    setRemoving(source); setImpact(null); setError("");
    try { const next = await api.sourceImpact(source.id); if (generation === impactGeneration.current) setImpact(next); }
    catch (cause) { if (generation === impactGeneration.current) { setRemoving(null); setError(safeFailure(cause, "Removal impact could not be loaded.")); } }
  };
  const closeRemoval = () => { if (pending) return; impactGeneration.current += 1; setRemoving(null); setImpact(null); };
  const remove = async () => {
    if (!removing) return;
    setPending(`remove-${removing.id}`); setError("");
    try { await onRemoveSource(removing.id); impactGeneration.current += 1; setRemoving(null); setImpact(null); }
    catch (cause) { setError(safeFailure(cause, "Source could not be removed.")); }
    finally { setPending(null); }
  };
  const pickerSource = pickerId ? sources.find(source => source.id === pickerId) : undefined;
  if (pickerSource) return <section className="source-task-layout"><FolderPicker source={pickerSource} roots={roots.filter(root => root.sourceId === pickerSource.id)} devices={devices} api={api} onRootAdded={onRootAdded} onRootRemoved={onRootRemoved} onClose={() => setPicker(null)} /></section>;
  return <section className="flex flex-col gap-5"><PageHeader context="Cloud library" title="Sources" description="Connect accounts, browse folders live, and expose only the roots you approve." action={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void onAuthorize("google")}><CloudIcon data-icon="inline-start" />Connect Google Drive</Button><Button onClick={() => void onAuthorize("onedrive")}><CloudIcon data-icon="inline-start" />Connect OneDrive</Button></div>} />
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!sources.length ? <Empty title="No cloud sources" body="Connect Google Drive or OneDrive to browse and choose household folders." icon={<CloudIcon />} /> : <div className="source-ledger">{sources.map(source => {
      const sourceRoots = roots.filter(root => root.sourceId === source.id);
      return <Card className="source-entry" key={source.id} data-source-status={source.status}>
        <CardHeader><div className="flex items-center gap-3"><span className={`provider-icon ${source.provider}`} aria-hidden="true">{source.provider === "google" ? "G" : "1"}</span><div><CardTitle><h2 className="text-base font-medium">{source.accountLabel}</h2></CardTitle><CardDescription>{source.provider === "google" ? "Google Drive" : "OneDrive"}</CardDescription></div></div><CardAction><Badge variant={source.status === "healthy" ? "secondary" : source.status === "reauth-required" ? "destructive" : "outline"}>{statusLabel(source.status)}</Badge></CardAction></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2"><SourceStat label="Approved folders" value={sourceRoots.filter(root => root.enabled).length.toString()} /><SourceStat label="Inactive records" value={sourceRoots.filter(root => !root.enabled).length.toString()} /></CardContent>
        <CardContent className="flex flex-wrap gap-2">{sourceRoots.filter(root => root.enabled).map(root => <Badge variant="outline" key={root.id}>{root.displayName}</Badge>)}</CardContent>
        <CardFooter className="flex-wrap gap-2"><Button ref={node => { if (source.id === openedPickerId.current) pickerTrigger.current = node; }} variant="outline" onClick={() => { openedPickerId.current = source.id; setPicker(source.id); }}><FolderCogIcon data-icon="inline-start" />Browse &amp; choose folders</Button><Button variant="outline" aria-label={`Reconnect ${source.accountLabel}`} onClick={() => void onAuthorize(source.provider, source.id)}><RotateCwIcon data-icon="inline-start" />Reconnect</Button><Button variant="destructive" className="sm:ml-auto" aria-label={`Remove ${source.accountLabel}`} onClick={() => void previewRemoval(source)}><Trash2Icon data-icon="inline-start" />Remove</Button></CardFooter>
      </Card>;
    })}</div>}
    {removing && <Dialog label="Remove source" onClose={closeRemoval}><header className="dialog-header"><div><h2>Remove source</h2><p className="mt-1 text-sm text-muted-foreground">Removing <strong>{removing.accountLabel}</strong> removes its folder access from every assigned television immediately.</p></div><button className="icon-button" onClick={closeRemoval} aria-label="Close">×</button></header><div className="dialog-scroll">{!impact ? <p>Loading impact…</p> : <><h3>Affected roots</h3>{impact.roots.length ? <ul>{impact.roots.map(root => <li key={root.id}>{root.displayName}</li>)}</ul> : <p>None</p>}<h3>Affected devices</h3>{impact.devices.length ? <ul>{impact.devices.map(device => <li key={device.id}>{device.name}</li>)}</ul> : <p>None</p>}</>}</div><footer className="dialog-actions"><button className="button secondary" onClick={closeRemoval}>Cancel</button><button className="button danger" disabled={!impact || pending === `remove-${removing.id}`} onClick={() => void remove()}>Remove source permanently</button></footer></Dialog>}
  </section>;
}
function SourceStat({ label, value }: { label: string; value: string }) { return <div className="ledger-stat"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-medium tabular-nums">{value}</p></div>; }
function statusLabel(status: ControlSourceDto["status"]) { return status === "healthy" ? "Connected" : status === "reauth-required" ? "Reauthorization required" : "Disabled"; }
function safeFailure(cause: unknown, fallback: string) { return cause instanceof Error && cause.name === "AdminApiError" ? cause.message : fallback; }
