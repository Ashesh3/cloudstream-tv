import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AssignedRootDto, DeviceDto, SourceDto } from "@cloudframe/shared";
import { ArrowLeftIcon } from "lucide-react";
import type { AdminApi } from "../api/client";
import { Dialog } from "./dialog";
import { HouseholdProgram } from "./household-program";
import { ProviderFolderStage } from "./provider-folder-stage";
import { Button } from "./ui/button";

export interface SourceWorkbenchProps {
  source: SourceDto;
  roots: AssignedRootDto[];
  devices?: DeviceDto[];
  api: AdminApi;
  onChanged(): Promise<void>;
  onClose(): void;
}

export function SourceWorkbench({ source, roots, devices = [], api, onChanged, onClose }: SourceWorkbenchProps) {
  const [programRoots, setProgramRoots] = useState(() => roots.filter(root => root.enabled));
  const [removeRoot, setRemoveRoot] = useState<AssignedRootDto | null>(null);
  const [impact, setImpact] = useState<{ devices: DeviceDto[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const workbenchRef = useRef<HTMLElement>(null);
  const impactRequest = useRef<{ generation: number; rootId: string | null }>({ generation: 0, rootId: null });
  useEffect(() => {
    setProgramRoots(roots.filter(root => root.enabled));
  }, [roots]);
  useEffect(() => () => {
    impactRequest.current = { generation: impactRequest.current.generation + 1, rootId: null };
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => workbenchRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus());
    return () => window.clearTimeout(timer);
  }, []);

  const invalidateImpactRequest = () => {
    impactRequest.current = { generation: impactRequest.current.generation + 1, rootId: null };
  };
  const closeRemoval = () => {
    if (pending) return;
    invalidateImpactRequest();
    setRemoveRoot(null); setImpact(null); setError("");
  };

  const reviewRemoval = async (root: AssignedRootDto) => {
    const generation = impactRequest.current.generation + 1;
    impactRequest.current = { generation, rootId: root.id };
    setRemoveRoot(root); setImpact(null); setError("");
    try {
      const nextImpact = await api.rootImpact(root.id);
      if (impactRequest.current.generation === generation && impactRequest.current.rootId === root.id) setImpact(nextImpact);
    } catch (cause) {
      if (impactRequest.current.generation === generation && impactRequest.current.rootId === root.id) setError(cause instanceof Error ? cause.message : "Removal impact could not be loaded.");
    }
  };
  const remove = async () => {
    if (!removeRoot) return;
    setPending(true); setError("");
    try {
      await api.removeRoot(removeRoot.id);
      invalidateImpactRequest();
      setProgramRoots(value => value.filter(root => root.id !== removeRoot.id));
      setRemoveRoot(null); setImpact(null);
      await onChanged();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Folder could not be removed."); }
    finally { setPending(false); }
  };

  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || removeRoot) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  const removalName = removeRoot
    ? removeRoot.providerNodeId === source.providerRootId
      ? `Entire ${source.provider === "google" ? "My Drive" : "OneDrive"}`
      : removeRoot.displayName
    : "";

  return <>
    <section
      ref={workbenchRef}
      className="source-workbench-shell"
      role="region"
      aria-labelledby="source-workbench-title"
      data-workbench="source-folders"
      data-material="program-stock"
      tabIndex={-1}
      onKeyDown={keyDown}
    >
      <header className="source-workbench-taskbar">
        <Button variant="ghost" size="sm" data-autofocus onClick={onClose}><ArrowLeftIcon />Back to sources</Button>
        <div className="workbench-account" data-provider={source.provider}>
          <span className="provider-mark" aria-hidden="true">{source.provider === "google" ? "G" : "1"}</span>
          <div><strong>{source.accountLabel}</strong><span>{source.provider === "google" ? "Google Drive" : "OneDrive"}</span></div>
        </div>
        <div className="workbench-selection" aria-label={`${programRoots.length} selected program folders`}>
          <span>{programRoots.length}</span><strong>{programRoots.length === 1 ? "folder selected" : "folders selected"}</strong>
        </div>
      </header>
      <div className="source-workbench">
        <div className="workbench-heading">
          <div><h1 id="source-workbench-title">Choose source folders</h1><p>Browse the provider live. Only folders moved into the household program are indexed and made available to televisions.</p></div>
          <div className="workbench-cue" aria-hidden="true"><span /><i /><span /></div>
        </div>
        {notice && <p className="workbench-warning" role="status">{notice}</p>}
        <div className="workbench-planes">
          <div className="stage-plane provider-stage-plane" data-workbench-plane="live-provider"><ProviderFolderStage api={api} source={source} selectedProviderNodeIds={new Set(programRoots.map(root => root.providerNodeId))} onRootAdded={root => { setProgramRoots(value => [...new Map([...value, root].map(item => [item.id, item])).values()]); setNotice(""); void onChanged().catch(() => setNotice(`${root.displayName} was added, but the household ledger could not refresh. The selection is preserved.`)); }} onClose={onClose} /></div>
          <div className="stage-plane program-stage-plane" data-workbench-plane="household-program"><HouseholdProgram source={source} roots={programRoots} devices={devices} onRemove={root => void reviewRemoval(root)} /></div>
        </div>
      </div>
    </section>
    {removeRoot && <Dialog label="Remove folder from household program" onClose={closeRemoval}>
      <header className="dialog-header"><div><h2 className="font-heading text-lg font-medium">Remove {removalName}?</h2><p className="mt-1 text-sm text-muted-foreground">This immediately removes the folder from every assigned television. Reconciliation will then remove out-of-program metadata.</p></div></header>
      <div className="dialog-scroll">
        {!impact && !error && <p aria-live="polite">Loading affected televisions…</p>}
        {impact && (impact.devices.length ? <><p className="font-medium">Affected televisions</p><ul className="mt-2 list-disc space-y-1 pl-5">{impact.devices.map(device => <li key={device.id}>{device.name}</li>)}</ul></> : <p>No televisions currently use this folder.</p>)}
        {error && <p className="error-banner" role="alert">{error}</p>}
      </div>
      <footer className="dialog-actions"><Button variant="outline" disabled={pending} onClick={closeRemoval}>Cancel</Button><Button variant="destructive" disabled={!impact || pending} onClick={() => void remove()}>{pending ? "Removing…" : `Remove ${removalName}`}</Button></footer>
    </Dialog>}
  </>;
}
