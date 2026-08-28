import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { ArrowLeftIcon } from "lucide-react";
import type { AdminApi } from "../api/client";
import { Dialog } from "./dialog";
import { HouseholdProgram, type ProgramRoot } from "./household-program";
import { ProviderFolderStage } from "./provider-folder-stage";
import { Button } from "./ui/button";

export interface SourceWorkbenchProps {
  source: ControlSourceDto;
  roots: ControlRootDto[];
  devices?: ControlDeviceDto[];
  api: AdminApi;
  onRootAdded(root: ControlRootDto): Promise<boolean>;
  onRootRemoved(rootId: string): Promise<boolean>;
  onClose(): void;
}

export function SourceWorkbench({ source, roots, devices = [], api, onRootAdded, onRootRemoved, onClose }: SourceWorkbenchProps) {
  const [programRoots, setProgramRoots] = useState<ProgramRoot[]>(roots);
  const [removeRoot, setRemoveRoot] = useState<ProgramRoot | null>(null);
  const [impact, setImpact] = useState<{ devices: ControlDeviceDto[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const workbenchRef = useRef<HTMLElement>(null);
  const impactRequest = useRef<{ generation: number; rootId: string | null }>({ generation: 0, rootId: null });
  useEffect(() => { setProgramRoots(current => roots.map(root => ({ ...root, providerNodeId: current.find(value => value.id === root.id)?.providerNodeId }))); }, [roots]);
  useEffect(() => () => { impactRequest.current = { generation: impactRequest.current.generation + 1, rootId: null }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => workbenchRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus()); return () => window.clearTimeout(timer); }, []);

  const invalidateImpactRequest = () => { impactRequest.current = { generation: impactRequest.current.generation + 1, rootId: null }; };
  const closeRemoval = () => { if (pending) return; invalidateImpactRequest(); setRemoveRoot(null); setImpact(null); setError(""); };
  const reviewRemoval = async (root: ProgramRoot) => {
    const generation = impactRequest.current.generation + 1;
    impactRequest.current = { generation, rootId: root.id };
    setRemoveRoot(root); setImpact(null); setError("");
    try { const nextImpact = await api.rootImpact(root.id); if (impactRequest.current.generation === generation && impactRequest.current.rootId === root.id) setImpact(nextImpact); }
    catch (cause) { if (impactRequest.current.generation === generation && impactRequest.current.rootId === root.id) setError(safeFailure(cause, "Removal impact could not be loaded.")); }
  };
  const remove = async () => {
    if (!removeRoot) return;
    setPending(true); setError("");
    const removedId = removeRoot.id;
    const removedName = removeRoot.displayName;
    try { await api.removeRoot(removedId); }
    catch (cause) { setError(safeFailure(cause, "Folder could not be removed.")); setPending(false); return; }
    invalidateImpactRequest(); setProgramRoots(value => value.filter(root => root.id !== removedId)); setRemoveRoot(null); setImpact(null); setNotice(`${removedName} was removed from the household program.`); setRefreshWarning("");
    try { if (!(await onRootRemoved(removedId))) setRefreshWarning(COMMITTED_REFRESH_WARNING); } catch { /* 401 unmounts the app. */ }
    finally { setPending(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => { if (event.key !== "Escape" || removeRoot) return; event.preventDefault(); event.stopPropagation(); onClose(); };

  return <>
    <section ref={workbenchRef} className="source-workbench-shell" role="region" aria-labelledby="source-workbench-title" data-workbench="source-folders" data-material="program-stock" tabIndex={-1} onKeyDown={keyDown}>
      <header className="source-workbench-taskbar">
        <Button className="workbench-touch-target" variant="ghost" size="sm" data-autofocus onClick={onClose}><ArrowLeftIcon />Back to sources</Button>
        <div className="workbench-account" data-provider={source.provider}><span className="provider-mark" aria-hidden="true">{source.provider === "google" ? "G" : "1"}</span><div><strong>{source.accountLabel}</strong><span>{source.provider === "google" ? "Google Drive" : "OneDrive"}</span></div></div>
        <div className="workbench-selection" aria-label={`${programRoots.filter(root => root.enabled).length} selected program folders`}><span>{programRoots.filter(root => root.enabled).length}</span><strong>{programRoots.filter(root => root.enabled).length === 1 ? "folder selected" : "folders selected"}</strong></div>
      </header>
      <div className="source-workbench">
        <div className="workbench-heading"><div><h1 id="source-workbench-title">Choose source folders</h1><p>Browse the provider live. Folders added to the household program are available to assigned televisions immediately.</p></div><div className="workbench-cue" aria-hidden="true"><span /><i /><span /></div></div>
        {notice && <p className="notice success" role="status">{notice}</p>}
        {refreshWarning && <p className="workbench-warning" role="status">{refreshWarning}</p>}
        <div className="workbench-planes">
          <div className="stage-plane provider-stage-plane" data-workbench-plane="live-provider"><ProviderFolderStage api={api} source={source} selectedProviderNodeIds={new Set(programRoots.flatMap(root => root.providerNodeId ? [root.providerNodeId] : []))} onRootAdded={async (root, providerNodeId) => { setProgramRoots(value => [...new Map([...value, { ...root, providerNodeId }].map(item => [item.id, item])).values()]); setNotice(`${root.displayName} was added to the household program.`); setRefreshWarning(""); try { if (!(await onRootAdded(root))) setRefreshWarning(COMMITTED_REFRESH_WARNING); } catch { /* 401 unmounts the app. */ } }} onClose={onClose} /></div>
          <div className="stage-plane program-stage-plane" data-workbench-plane="household-program"><HouseholdProgram source={source} roots={programRoots} devices={devices} onRemove={root => void reviewRemoval(root)} /></div>
        </div>
      </div>
    </section>
    {removeRoot && <Dialog label="Remove folder from household program" onClose={closeRemoval}>
      <header className="dialog-header"><div><h2 className="font-heading text-lg font-medium">Remove {removeRoot.displayName}?</h2><p className="mt-1 text-sm text-muted-foreground">Access is removed immediately from every assigned television.</p></div></header>
      <div className="dialog-scroll">{!impact && !error && <p aria-live="polite">Loading affected televisions…</p>}{impact && (impact.devices.length ? <><p className="font-medium">Affected televisions</p><ul className="mt-2 list-disc space-y-1 pl-5">{impact.devices.map(device => <li key={device.id}>{device.name}</li>)}</ul></> : <p>No televisions currently use this folder.</p>)}{error && <p className="error-banner" role="alert">{error}</p>}</div>
      <footer className="dialog-actions"><Button variant="outline" disabled={pending} onClick={closeRemoval}>Cancel</Button><Button variant="destructive" disabled={!impact || pending} onClick={() => void remove()}>{pending ? "Removing…" : `Remove ${removeRoot.displayName}`}</Button></footer>
    </Dialog>}
  </>;
}

function safeFailure(cause: unknown, fallback: string) { return cause instanceof Error && cause.name === "AdminApiError" ? cause.message : fallback; }
const COMMITTED_REFRESH_WARNING = "Change saved, but the household ledger could not be refreshed. Refresh to confirm the latest state.";
