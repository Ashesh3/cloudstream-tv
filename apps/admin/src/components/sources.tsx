import { useState } from "react";
import type { AssignedRootDto, DeviceDto, SourceDto } from "@cloudframe/shared";
import type { AdminApi, AdminSource } from "../api/client";
import { Dialog } from "./dialog";
import { FolderPicker } from "./folder-picker";
import { Empty, PageHeader, relativeTime } from "./requests";

export function Sources({ sources, allRoots, api, onRefresh, onAuthorize }: {
  sources: AdminSource[];
  allRoots: AssignedRootDto[];
  api: AdminApi;
  onRefresh(): Promise<void>;
  onAuthorize(provider: "google" | "onedrive", reconnect?: string): Promise<void>;
}) {
  const [picker, setPicker] = useState<SourceDto | null>(null);
  const [removing, setRemoving] = useState<AdminSource | null>(null);
  const [impact, setImpact] = useState<{ roots: AssignedRootDto[]; devices: DeviceDto[] } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const sync = async (source: AdminSource) => { setPending(`sync-${source.id}`); setError(""); try { await api.syncSource(source.id); setMessage(`${source.accountLabel} sync was queued.`); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Sync could not be queued."); } finally { setPending(null); } };
  const previewRemoval = async (source: AdminSource) => { setRemoving(source); setImpact(null); setError(""); try { setImpact(await api.sourceImpact(source.id)); } catch (cause) { setRemoving(null); setError(cause instanceof Error ? cause.message : "Removal impact could not be loaded."); } };
  const remove = async () => { if (!removing) return; setPending(`remove-${removing.id}`); try { await api.removeSource(removing.id); setRemoving(null); setImpact(null); setMessage("Source removed."); await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Source could not be removed."); } finally { setPending(null); } };
  return <section><PageHeader eyebrow="Cloud library" title="Sources" description="Connect accounts globally, index their folders, and expose only the roots you choose." action={<div className="header-actions"><button className="button secondary" onClick={() => void onAuthorize("google")}>Connect Google Drive</button><button className="button primary" onClick={() => void onAuthorize("onedrive")}>Connect OneDrive</button></div>} />
    {message && <p className="notice success" role="status">{message}</p>}{error && <p className="error-banner" role="alert">{error}</p>}
    {!sources.length ? <Empty title="No cloud sources" body="Connect Google Drive or OneDrive to start indexing folders." /> : <div className="source-list">{sources.map(source => <article className="source-card" key={source.id}><div className={`provider-icon ${source.provider}`} aria-hidden="true">{source.provider === "google" ? "G" : "1"}</div><div className="source-main"><div className="card-title-row"><div><small>{source.provider === "google" ? "Google Drive" : "OneDrive"}</small><h2>{source.accountLabel}</h2></div><span className={`status ${statusClass(source.status)}`}>{statusLabel(source.status)}</span></div><div className="source-meta"><span>Last success <strong>{source.lastSyncCompletedAt ? relativeTime(source.lastSyncCompletedAt) : "Not yet"}</strong></span><span>Next sync <strong>{source.nextSyncAt ? relativeTime(source.nextSyncAt) : "Manual"}</strong></span><span>Roots <strong>{source.roots.filter(root => root.enabled).length}</strong></span></div>{source.lastSyncErrorCode && <p className="source-error">Last error: {source.lastSyncErrorCode}</p>}<div className="root-chips">{source.roots.filter(root => root.enabled).map(root => <span key={root.id}>{root.displayName}</span>)}</div></div><div className="source-actions"><button className="button secondary" onClick={() => setPicker(source)}>Manage folders</button><button className="button secondary" aria-label={`Sync ${source.accountLabel}`} disabled={pending === `sync-${source.id}`} onClick={() => void sync(source)}>{pending === `sync-${source.id}` ? "Queuing…" : "Sync now"}</button><button className="button secondary" aria-label={`Reconnect ${source.accountLabel}`} onClick={() => void onAuthorize(source.provider, source.id)}>Reconnect</button><button className="text-danger" aria-label={`Remove ${source.accountLabel}`} onClick={() => void previewRemoval(source)}>Remove</button></div></article>)}</div>}
    {picker && <FolderPicker source={picker} roots={allRoots.filter(root => root.sourceId === picker.id)} api={api} onChanged={onRefresh} onClose={() => setPicker(null)} />}
    {removing && <Dialog label="Remove source" onClose={() => { setRemoving(null); setImpact(null); }}><header className="dialog-header"><div><p className="eyebrow">Permanent removal</p><h2>Remove source</h2></div><button className="icon-button" onClick={() => setRemoving(null)} aria-label="Close">×</button></header><div className="dialog-scroll"><p>Removing <strong>{removing.accountLabel}</strong> disables its roots and removes them from every television.</p>{!impact ? <p>Loading impact…</p> : <><h3>Affected roots</h3>{impact.roots.length ? <ul>{impact.roots.map(root => <li key={root.id}>{root.displayName}</li>)}</ul> : <p>None</p>}<h3>Affected devices</h3>{impact.devices.length ? <ul>{impact.devices.map(device => <li key={device.id}>{device.name}</li>)}</ul> : <p>None</p>}</>}</div><footer className="dialog-actions"><button className="button secondary" onClick={() => setRemoving(null)}>Cancel</button><button className="button danger" disabled={!impact || pending === `remove-${removing.id}`} onClick={() => void remove()}>Remove source permanently</button></footer></Dialog>}
  </section>;
}
function statusClass(status: SourceDto["status"]) { return status === "healthy" ? "healthy" : status === "syncing" ? "pending" : status === "disabled" ? "disabled" : "error"; }
function statusLabel(status: SourceDto["status"]) { return status === "reauth-required" ? "Reconnect needed" : status[0]!.toUpperCase() + status.slice(1); }

