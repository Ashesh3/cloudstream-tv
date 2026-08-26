import { useState } from "react";
import type { AssignedRootDto, DeviceDto, SourceDto } from "@cloudframe/shared";
import type { AdminApi, AdminSource } from "../api/client";
import { Dialog } from "./dialog";
import { FolderPicker } from "./folder-picker";
import { Empty, PageHeader, relativeTime } from "./requests";
import { CloudIcon, FolderCogIcon, RefreshCwIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { IndexStatus } from "./index-status";

export function Sources({ sources, allRoots, devices, api, onRefresh, onAuthorize }: {
  sources: AdminSource[];
  allRoots: AssignedRootDto[];
  devices: DeviceDto[];
  api: AdminApi;
  onRefresh(): Promise<void>;
  onAuthorize(provider: "google" | "onedrive", reconnect?: string): Promise<void>;
}) {
  const [pickerId, setPicker] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AdminSource | null>(null);
  const [impact, setImpact] = useState<{ roots: AssignedRootDto[]; devices: DeviceDto[] } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const sync = async (source: AdminSource) => { setPending(`sync-${source.id}`); setError(""); try { await api.syncSource(source.id); setMessage(`${source.accountLabel} sync was queued.`); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Sync could not be queued."); } finally { setPending(null); } };
  const previewRemoval = async (source: AdminSource) => { setRemoving(source); setImpact(null); setError(""); try { setImpact(await api.sourceImpact(source.id)); } catch (cause) { setRemoving(null); setError(cause instanceof Error ? cause.message : "Removal impact could not be loaded."); } };
  const remove = async () => { if (!removing) return; setPending(`remove-${removing.id}`); try { await api.removeSource(removing.id); setRemoving(null); setImpact(null); setMessage("Source removed."); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Source could not be removed."); } finally { setPending(null); } };
  return <section className="flex flex-col gap-5"><PageHeader eyebrow="Cloud library" title="Sources" description="Connect accounts globally, index their folders, and expose only the roots you choose." action={<div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void onAuthorize("google")}><CloudIcon data-icon="inline-start" />Connect Google Drive</Button><Button onClick={() => void onAuthorize("onedrive")}><CloudIcon data-icon="inline-start" />Connect OneDrive</Button></div>} />
    {message && <p className="notice success" role="status">{message}</p>}{error && <p className="error-banner" role="alert">{error}</p>}
    {!sources.length ? <Empty title="No cloud sources" body="Connect Google Drive or OneDrive to browse and choose household folders." icon={<CloudIcon />} /> : <div className="source-ledger">{sources.map(source => <Card className="source-entry" key={source.id} data-index-state={source.indexState.kind}>
      <CardHeader><div className="flex items-center gap-3"><span className={`provider-icon ${source.provider}`} aria-hidden="true">{source.provider === "google" ? "G" : "1"}</span><div><CardTitle><h2 className="text-base font-medium">{source.accountLabel}</h2></CardTitle><CardDescription>{source.provider === "google" ? "Google Drive" : "OneDrive"}</CardDescription></div></div><CardAction><Badge variant={source.status === "healthy" ? "secondary" : source.status === "error" || source.status === "reauth-required" ? "destructive" : "outline"}>{statusLabel(source.status)}</Badge></CardAction></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3"><SourceStat label="Last success" value={source.lastSyncCompletedAt ? relativeTime(source.lastSyncCompletedAt) : "Not yet"} /><SourceStat label="Next sync" value={source.nextSyncAt ? relativeTime(source.nextSyncAt) : "Manual"} /><SourceStat label="Program folders" value={source.roots.filter(root => root.enabled).length.toString()} /></CardContent>
      <CardContent><IndexStatus state={source.indexState} /></CardContent>
      <CardContent className="flex flex-wrap gap-2">{source.roots.filter(root => root.enabled).map(root => <Badge variant="outline" key={root.id}>{root.displayName}</Badge>)}</CardContent>
      <CardFooter className="flex-wrap gap-2"><Button variant="outline" onClick={() => setPicker(source.id)}><FolderCogIcon data-icon="inline-start" />Browse &amp; choose folders</Button><Button variant="outline" aria-label={`Sync ${source.accountLabel}`} disabled={pending === `sync-${source.id}`} onClick={() => void sync(source)}><RefreshCwIcon data-icon="inline-start" />{pending === `sync-${source.id}` ? "Queuing…" : "Sync now"}</Button><Button variant="outline" aria-label={`Reconnect ${source.accountLabel}`} onClick={() => void onAuthorize(source.provider, source.id)}><RotateCwIcon data-icon="inline-start" />Reconnect</Button><Button variant="destructive" className="sm:ml-auto" aria-label={`Remove ${source.accountLabel}`} onClick={() => void previewRemoval(source)}><Trash2Icon data-icon="inline-start" />Remove</Button></CardFooter>
    </Card>)}</div>}
    {pickerId && sources.find(source => source.id === pickerId) && <FolderPicker source={sources.find(source => source.id === pickerId)!} roots={allRoots.filter(root => root.sourceId === pickerId)} devices={devices} api={api} onChanged={onRefresh} onClose={() => setPicker(null)} />}
    {removing && <Dialog label="Remove source" onClose={() => { setRemoving(null); setImpact(null); }}><header className="dialog-header"><div><p className="eyebrow">Permanent removal</p><h2>Remove source</h2></div><button className="icon-button" onClick={() => setRemoving(null)} aria-label="Close">×</button></header><div className="dialog-scroll"><p>Removing <strong>{removing.accountLabel}</strong> disables its roots and removes them from every television.</p>{!impact ? <p>Loading impact…</p> : <><h3>Affected roots</h3>{impact.roots.length ? <ul>{impact.roots.map(root => <li key={root.id}>{root.displayName}</li>)}</ul> : <p>None</p>}<h3>Affected devices</h3>{impact.devices.length ? <ul>{impact.devices.map(device => <li key={device.id}>{device.name}</li>)}</ul> : <p>None</p>}</>}</div><footer className="dialog-actions"><button className="button secondary" onClick={() => setRemoving(null)}>Cancel</button><button className="button danger" disabled={!impact || pending === `remove-${removing.id}`} onClick={() => void remove()}>Remove source permanently</button></footer></Dialog>}
  </section>;
}
function SourceStat({ label, value }: { label: string; value: string }) { return <div className="ledger-stat"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-medium tabular-nums">{value}</p></div>; }
function statusLabel(status: SourceDto["status"]) { return status === "reauth-required" ? "Reconnect needed" : status[0]!.toUpperCase() + status.slice(1); }
