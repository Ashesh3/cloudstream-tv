import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlSourceDto, ProviderFolderDto } from "@cloudframe/shared";
import { ChevronRightIcon, FolderIcon, FolderPlusIcon, LoaderCircleIcon, RefreshCwIcon, XIcon } from "lucide-react";
import type { AdminApi, AdminProviderFolderPage } from "../api/client";
import { providerName } from "../design/ledger";
import { AdminApiError } from "../api/client";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

type BrowseLocation = { providerFolderId?: string; name: string };

export function ProviderFolderStage({ api, source, selectedProviderNodeIds, onRootAdded, onClose }: {
  api: AdminApi;
  source: ControlSourceDto;
  selectedProviderNodeIds: ReadonlySet<string>;
  onRootAdded(root: Awaited<ReturnType<AdminApi["createRoot"]>>["root"], providerNodeId: string): void;
  onClose(): void;
}) {
  const providerRootName = source.provider === "google" ? "My Drive" : "OneDrive";
  const [trail, setTrail] = useState<BrowseLocation[]>([{ name: providerRootName }]);
  const [pages, setPages] = useState<ProviderFolderDto[]>([]);
  const [current, setCurrent] = useState<ProviderFolderDto | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<StageError | null>(null);
  const locationId = trail.at(-1)?.providerFolderId;
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async (providerFolderId?: string, cursor?: string | null) => {
    const append = Boolean(cursor);
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    if (append) setPaging(true); else { setLoading(true); setPages([]); }
    setError(null);
    try {
      const response = await api.providerFolders(source.id, { providerFolderId, cursor, limit: 100, signal: controller.signal });
      if (sequence !== requestSequence.current) return;
      applyResponse(response, append, setPages);
      setCurrent(response.current);
      setNextCursor(response.nextCursor);
      if (!append) setTrail(response.breadcrumbs.map((item, index) => ({ providerFolderId: index === 0 ? undefined : item.providerNodeId, name: item.name })));
    } catch (cause) {
      if (controller.signal.aborted || isAbort(cause) || sequence !== requestSequence.current) return;
      setError(stageError(cause));
    } finally {
      if (sequence === requestSequence.current) { setLoading(false); setPaging(false); activeRequest.current = null; }
    }
  }, [api, source.id]);

  useEffect(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true); setPages([]); setCurrent(null); setNextCursor(null); setError(null);
    void api.providerFolders(source.id, { providerFolderId: locationId, cursor: null, limit: 100, signal: controller.signal })
      .then(response => {
        if (sequence !== requestSequence.current) return;
        setPages(uniqueFolders(response.folders)); setCurrent(response.current); setNextCursor(response.nextCursor);
        setTrail(response.breadcrumbs.map((item, index) => ({ providerFolderId: index === 0 ? undefined : item.providerNodeId, name: item.name })));
      })
      .catch(cause => { if (!controller.signal.aborted && sequence === requestSequence.current && !isAbort(cause)) setError(stageError(cause)); })
      .finally(() => { if (sequence === requestSequence.current) { setLoading(false); activeRequest.current = null; } });
    return () => { controller.abort(); if (activeRequest.current === controller) activeRequest.current = null; };
  }, [api, source.id, locationId]);

  const navigate = (folder?: ProviderFolderDto) => {
    const nextId = folder?.providerNodeId;
    if (nextId === locationId) return;
    setTrail(value => folder ? [...value, { providerFolderId: folder.providerNodeId, name: folder.name }] : [{ name: providerRootName }]);
  };
  const navigateBreadcrumb = (index: number) => setTrail(value => value.slice(0, index + 1));
  const add = async (folder: ProviderFolderDto) => {
    setPending(folder.providerNodeId); setError(null);
    try {
      const result = await api.createRoot(source.id, { providerNodeId: folder.providerNodeId });
      onRootAdded(result.root, folder.providerNodeId);
      setPages(value => value.map(item => item.providerNodeId === folder.providerNodeId ? { ...item, assignedRootId: result.root.id } : item));
    } catch (cause) { setError(stageError(cause, "Folder could not be added")); }
    finally { setPending(null); }
  };

  return <section className="provider-folder-stage flex min-h-0 flex-col" aria-labelledby="provider-folder-stage-title" data-workbench-region="provider-stage">
    <header className="stage-header flex items-start justify-between gap-4 border-b pb-4">
      <div><h2 id="provider-folder-stage-title" className="font-heading text-lg font-medium">Live provider stage</h2><p className="mt-1 text-xs text-muted-foreground">{providerName(source.provider)} · {source.accountLabel}</p></div>
      <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close folder workbench"><XIcon /></Button>
    </header>
    <div className="flex items-center gap-2 border-b py-3">
      <Button variant="outline" size="sm" disabled={loading || trail.length <= 1} onClick={() => setTrail(value => value.slice(0, -1))}>Back</Button>
      <nav className="flex min-w-0 flex-1 items-center overflow-x-auto text-sm" aria-label="Provider folder path">
        {trail.map((item, index) => <span className="flex items-center" key={item.providerFolderId ?? "provider-root"}>{index > 0 && <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}<button className="min-h-8 truncate rounded-md px-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => navigateBreadcrumb(index)}>{item.name}</button></span>)}
      </nav>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto py-4" aria-live="polite">
      {loading ? <FolderSkeletons /> : error ? <StageErrorPanel error={error} onRetry={() => void load(locationId, null)} onReconnect={onClose} /> : pages.length === 0 ? <div className="stage-empty grid min-h-52 place-items-center border border-dashed p-6 text-center"><div><FolderIcon className="mx-auto size-6 text-muted-foreground" aria-hidden="true" /><p className="mt-3 font-medium">This provider folder is empty</p><p className="mt-1 text-sm text-muted-foreground">The live provider response contains no child folders at this level.</p></div></div> : <ul className="provider-folder-list divide-y" aria-label={`Folders in ${current?.name ?? providerRootName}`}>
        {pages.map(folder => {
          const selected = Boolean(folder.assignedRootId || selectedProviderNodeIds.has(folder.providerNodeId));
          return <li className="provider-folder-row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5" key={folder.providerNodeId}>
            <button className="folder-row-action flex min-h-11 min-w-0 items-center gap-3 px-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={`Open ${folder.name}`} onClick={() => navigate(folder)}><span className="folder-ticket grid size-8 shrink-0 place-items-center bg-muted"><FolderIcon className="size-4" aria-hidden="true" /></span><span className="truncate font-medium">{folder.name}</span><ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></button>
            <Button variant={selected ? "secondary" : "outline"} size="sm" disabled={selected || pending === folder.providerNodeId} aria-label={selected ? `${folder.name} is in the household program` : `Add ${folder.name} to household program`} onClick={() => void add(folder)}>{pending === folder.providerNodeId ? <><LoaderCircleIcon className="animate-spin" />Adding…</> : selected ? "Added" : <><FolderPlusIcon />Add</>}</Button>
          </li>;
        })}
      </ul>}
      {!loading && !error && nextCursor && <div className="mt-4 flex justify-center"><Button variant="outline" disabled={paging} onClick={() => void load(locationId, nextCursor)}>{paging ? <><LoaderCircleIcon className="animate-spin" />Loading…</> : "Load more folders"}</Button></div>}
    </div>
  </section>;
}

function applyResponse(response: AdminProviderFolderPage, append: boolean, setPages: React.Dispatch<React.SetStateAction<ProviderFolderDto[]>>) {
  setPages(value => uniqueFolders(append ? [...value, ...response.folders] : response.folders));
}
function uniqueFolders(folders: ProviderFolderDto[]) { return [...new Map(folders.map(folder => [folder.providerNodeId, folder])).values()]; }
function isAbort(cause: unknown) { return cause instanceof DOMException && cause.name === "AbortError"; }
type StageError = { title: string; description: string; action: "retry" | "reconnect" };
function stageError(cause: unknown, fallback = "Folder listing failed"): StageError {
  if (cause instanceof AdminApiError && cause.code === "PROVIDER_REAUTH_REQUIRED" || isCode(cause, "PROVIDER_REAUTH_REQUIRED")) return { title: "Reconnect this account", description: "The provider needs renewed authorization before live browsing can continue.", action: "reconnect" };
  return { title: fallback, description: "Provider temporarily unavailable", action: "retry" };
}
function isCode(value: unknown, code: string) { return Boolean(value && typeof value === "object" && "code" in value && (value as { code: unknown }).code === code); }
function StageErrorPanel({ error, onRetry, onReconnect }: { error: StageError; onRetry(): void; onReconnect(): void }) { return <div className="grid min-h-52 place-items-center rounded-xl border border-destructive/30 p-6 text-center" role="alert"><div><p className="font-medium text-destructive">{error.title}</p><p className="mt-1 max-w-md text-sm text-muted-foreground">{error.description}</p><Button className="mt-4" variant="outline" onClick={error.action === "reconnect" ? onReconnect : onRetry}><RefreshCwIcon />{error.action === "reconnect" ? "Return to reconnect" : "Try again"}</Button></div></div>; }
function FolderSkeletons() { return <div className="space-y-3" aria-label="Loading provider folders">{Array.from({ length: 5 }, (_, index) => <div className="flex items-center gap-3" key={index}><Skeleton className="size-9" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-7 w-16" /></div>)}</div>; }
