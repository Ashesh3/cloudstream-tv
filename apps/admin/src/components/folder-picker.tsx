import { useEffect, useState } from "react";
import type { AdminFolderTreeResponse, AssignedRootDto, MediaNodeDto, SourceDto, ThumbnailUrlItem } from "@cloudframe/shared";
import type { AdminApi } from "../api/client";
import { Dialog } from "./dialog";

export function FolderPicker({ source, roots, api, onChanged, onClose }: {
  source: SourceDto;
  roots: AssignedRootDto[];
  api: AdminApi;
  onChanged(): Promise<void>;
  onClose(): void;
}) {
  const [folders, setFolders] = useState<AdminFolderTreeResponse["folders"]>([]);
  const [parent, setParent] = useState<MediaNodeDto | null>(null);
  const [trail, setTrail] = useState<Array<MediaNodeDto | null>>([null]);
  const [thumbs, setThumbs] = useState<Record<string, ThumbnailUrlItem>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [removeRoot, setRemoveRoot] = useState<AssignedRootDto | null>(null);
  const [impact, setImpact] = useState<{ devices: Array<{ id: string; name: string }> } | null>(null);

  const load = async (node: MediaNodeDto | null, nextTrail?: Array<MediaNodeDto | null>) => {
    setLoading(true); setError("");
    try {
      const tree = await api.sourceTree(source.id, node?.id);
      setParent(tree.parent); setFolders(tree.folders); if (nextTrail) setTrail(nextTrail);
      const ids = [...new Set(tree.folders.flatMap(folder => folder.folderCoverNodeIds).slice(0, 60))];
      if (ids.length) {
        const result = await api.thumbnailUrls(ids);
        setThumbs(Object.fromEntries(result.items.map(item => [item.nodeId, item])));
      } else setThumbs({});
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Folder list could not be loaded."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(null); }, [source.id]);
  const providerLabel = source.provider === "google" ? "Google Drive" : "OneDrive";
  const open = (folder: MediaNodeDto) => void load(folder, [...trail, folder]);
  const up = () => { const next = trail.slice(0, -1); void load(next.at(-1) ?? null, next.length ? next : [null]); };
  const add = async (folder: MediaNodeDto) => { setPending(folder.id); setError(""); try { await api.createRoot(source.id, { nodeId: folder.id }); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Root could not be added."); } finally { setPending(null); } };
  const previewRemove = async (root: AssignedRootDto) => { setRemoveRoot(root); setImpact(null); try { setImpact(await api.rootImpact(root.id)); } catch (cause) { setError(cause instanceof Error ? cause.message : "Impact could not be loaded."); setRemoveRoot(null); } };
  const confirmRemove = async () => { if (!removeRoot) return; setPending(removeRoot.id); try { await api.removeRoot(removeRoot.id); setRemoveRoot(null); setImpact(null); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Root could not be removed."); } finally { setPending(null); } };

  return <Dialog label="Choose source folders" onClose={onClose} className="folder-sheet">
    <header className="dialog-header"><div><p className="eyebrow">{providerLabel} · {source.accountLabel}</p><h2>Choose source folders</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></header>
    <div className="folder-toolbar"><button className="button secondary" disabled={trail.length <= 1 || loading} onClick={up}>Up one level</button><div className="breadcrumbs" aria-label="Folder path">{trail.map((item, index) => <span key={item?.id ?? "root"}>{index ? " / " : ""}{item?.name ?? providerLabel}</span>)}</div></div>
    <div className="dialog-scroll">
      <section className="assigned-roots"><h3>Assignable roots</h3>{roots.filter(root => root.enabled).length ? roots.filter(root => root.enabled).map(root => <div className="assigned-root" key={root.id}><span className="mini-folder" aria-hidden="true" /><span><strong>{root.displayName}</strong><small>{providerLabel} · {source.accountLabel}</small></span><button className="text-danger" onClick={() => void previewRemove(root)} aria-label={`Remove root ${root.displayName}`}>Remove</button></div>) : <p className="empty-inline">No roots from this source yet.</p>}</section>
      <section aria-live="polite"><h3>{parent ? parent.name : "Indexed folders"}</h3>{loading ? <div className="loading-block">Loading indexed folders…</div> : error ? <div className="error-banner" role="alert">{error}<button className="button secondary" onClick={() => void load(parent)}>Try again</button></div> : !folders.length ? <p className="empty-inline">No indexed folders are available at this level.</p> : <div className="folder-grid">{folders.map(folder => {
        const covers = folder.folderCoverNodeIds.slice(0, 3).map(id => thumbs[id]).filter((item): item is ThumbnailUrlItem => Boolean(item?.url));
        const already = Boolean(folder.assignedRootId);
        return <article className="folder-card" key={folder.id}><button className="folder-preview" aria-label={`Open ${folder.name}`} onClick={() => open(folder)}>{covers.length ? covers.map(item => <img key={item.nodeId} src={item.url} alt="" referrerPolicy="no-referrer" />) : <span className="folder-placeholder" aria-hidden="true" />}</button><div><strong>{folder.name}</strong><small>{folder.childFolderCount} folders · {folder.childMediaCount} media</small></div><button className="button compact" disabled={pending === folder.id || already} onClick={() => void add(folder)}>{already ? "Added" : pending === folder.id ? "Adding…" : "Add root"}</button></article>;
      })}</div>}</section>
    </div>
    {removeRoot && <Dialog label="Remove root" onClose={() => { setRemoveRoot(null); setImpact(null); }}><header className="dialog-header"><div><p className="eyebrow">Access impact</p><h2>Remove root</h2></div></header><div className="dialog-scroll"><p><strong>{removeRoot.displayName}</strong> will no longer be assignable.</p>{!impact ? <p>Loading affected devices…</p> : impact.devices.length ? <><p>Affected televisions:</p><ul>{impact.devices.map(device => <li key={device.id}>{device.name}</li>)}</ul></> : <p>No televisions currently use this root.</p>}</div><footer className="dialog-actions"><button className="button secondary" onClick={() => setRemoveRoot(null)}>Cancel</button><button className="button danger" disabled={!impact || pending === removeRoot.id} onClick={() => void confirmRemove()}>Remove root</button></footer></Dialog>}
  </Dialog>;
}
