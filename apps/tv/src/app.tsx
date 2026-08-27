import type { MediaNodeDto, ThumbnailUrlItem, TvRootCardDto, WatchHistoryDto } from "@cloudframe/shared";
import { normalizeTvKey, pushNavigationEntry, restoreNavigationEntry, shouldHandleTvKey, type NavigationEntry } from "@cloudframe/tv-core";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import { tvApi, type TvApi, type TvFolderResponse } from "./api/client";
import { DeviceRequest, StatePanel } from "./components/device-request";
import { FolderCard } from "./components/folder-card";
import { MediaCard } from "./components/media-card";
import { ProgramStatus } from "./components/program-status";
import { SourceDrawer } from "./components/source-drawer";
import { TvHeader } from "./components/tv-header";
import { VirtualGrid } from "./components/virtual-grid";
import { Viewer } from "./components/viewer";
import { WaitingScreen } from "./components/waiting-screen";
import { useTvSession } from "./state/use-tv-session";

type BrowseItem =
  | ({ itemType: "root" } & TvRootCardDto)
  | ({ itemType: "node" } & MediaNodeDto);

interface BrowseState {
  folder: TvFolderResponse | null;
  roots: TvRootCardDto[];
  items: BrowseItem[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

export function TvApp({ api = tvApi, browserSupported = detectBrowserSupport() }: {
  api?: TvApi;
  browserSupported?: boolean;
}) {
  const session = useTvSession(api, browserSupported);
  if (session.state.status === "unsupported") return <Unsupported />;
  if (session.state.status === "loading") return <StatePanel title="Opening Cloudframe" body="Preparing your folders…"><div className="skeleton-line" /></StatePanel>;
  if (session.state.status === "requests-disabled") return <StatePanel title="Device requests are turned off" body="Ask the household administrator to enable new TV requests."><button className="primary-action" onClick={session.refresh}>Try again</button></StatePanel>;
  if (session.state.status === "unenrolled") return <DeviceRequest busy={session.requestBusy} error={session.requestError} onSubmit={session.requestAccess} />;
  if (session.state.status === "pending") return <WaitingScreen name={session.state.request.requestedName} expiresAt={session.state.request.expiresAt} />;
  if (session.state.status === "denied") return <TerminalState state="denied" title="Request denied" body="This TV was not approved. You can ask the administrator and try again." onRetry={session.refresh} />;
  if (session.state.status === "expired") return <TerminalState state="expired" title="Request expired" body="The approval window ended. Start a fresh request when you are ready." onRetry={session.refresh} />;
  if (session.state.status === "revoked") return <TerminalState state="revoked" title="TV access removed" body="This device has been disabled or revoked by the administrator." onRetry={session.refresh} />;
  if (session.state.status === "offline") return <StatePanel title="Cloudframe is offline" body="Check the TV network connection, then retry."><button className="primary-action" onClick={session.refresh}>Retry</button></StatePanel>;
  if (session.state.status !== "ready") return null;
  return <BrowserShell api={api} onUnauthorized={session.refresh} slideshowSeconds={session.state.device.slideshowSeconds ?? session.state.household.defaultSlideshowSeconds} />;
}

function BrowserShell({ api, onUnauthorized, slideshowSeconds }: { api: TvApi; onUnauthorized: () => void; slideshowSeconds: number }) {
  const [browse, setBrowse] = useState<BrowseState>({ folder: null, roots: [], items: [], nextCursor: null, loading: true, error: null });
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [stack, setStack] = useState<NavigationEntry[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, ThumbnailUrlItem>>({});
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const [loadedPageCursors, setLoadedPageCursors] = useState<(string | null)[]>([]);
  const [restoredFocusTick, setRestoredFocusTick] = useState(0);
  const [viewer, setViewer] = useState<{ items: MediaNodeDto[]; selectedItemId: string } | null>(null);
  const [history, setHistory] = useState<Record<string, WatchHistoryDto>>({});
  const loadVersion = useRef(0);
  const pageRequest = useRef<Promise<void> | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const requestedFocus = useRef<number | null>(null);
  const restoreFocusAfterDrawer = useRef<number | null>(null);
  const mountedRequest = useRef<AbortController | null>(null);
  const columns = useResponsiveColumns();
  const viewportHeight = useViewportHeight();

  const closeDrawerAndRestore = useCallback(() => {
    setDrawerOpen(false);
    const restore = restoreFocusAfterDrawer.current;
    if (restore !== null) {
      window.setTimeout(() => {
        setFocusedIndex(restore);
        setRestoredFocusTick(value => value + 1);
      }, 0);
    }
  }, []);

  const loadHome = useCallback(async () => {
    const version = ++loadVersion.current;
    setBrowse(current => ({ ...current, loading: true, error: null }));
    try {
      const response = await api.home();
      if (version !== loadVersion.current) return;
      setBrowse({ folder: null, roots: response.roots, items: response.roots.map(root => ({ ...root, itemType: "root" as const })), nextCursor: null, loading: false, error: null });
      setFocusedIndex(0);
      setScrollTop(0);
      setLoadedPageCursors([]);
    } catch (error) {
      if (version !== loadVersion.current) return;
      const message = error instanceof Error ? error.message : "Unable to load folders.";
      setBrowse(current => ({ ...current, loading: false, error: message }));
    }
  }, [api]);

  const loadFolder = useCallback(async (nodeId: string, cursor?: string | null, append = false) => {
    const version = ++loadVersion.current;
    if (!append) setBrowse(current => ({ ...current, loading: true, error: null }));
    try {
      const response = await api.folder(nodeId, cursor);
      if (version !== loadVersion.current) return;
      setBrowse(current => {
        const items = append
          ? [...current.items, ...response.children.map(node => ({ ...node, itemType: "node" as const }))]
          : response.children.map(node => ({ ...node, itemType: "node" as const }));
        if (append && requestedFocus.current !== null) setFocusedIndex(Math.min(requestedFocus.current, Math.max(0, items.length - 1)));
        return { folder: response, roots: current.roots, items, nextCursor: response.nextCursor, loading: false, error: null };
      });
      setLoadedPageCursors(current => append ? [...current, cursor ?? null] : [null]);
      if (append) requestedFocus.current = null;
    } catch (error) {
      if (version !== loadVersion.current) return;
      const message = error instanceof Error ? error.message : "This source is temporarily unavailable.";
      setBrowse(current => ({ ...current, loading: false, error: message }));
      if ((error as { code?: string }).code === "DEVICE_UNAUTHORIZED") onUnauthorized();
    }
  }, [api, onUnauthorized]);

  const appendNextPage = useCallback((pendingIndex?: number) => {
    if (!browse.folder || !browse.nextCursor || pageRequest.current) return;
    pendingFocus.current = pendingIndex ?? null;
    requestedFocus.current = pendingFocus.current;
    const promise = loadFolder(browse.folder.parent.id, browse.nextCursor, true).finally(() => {
      if (pageRequest.current === promise) pageRequest.current = null;
    });
    pageRequest.current = promise;
  }, [browse.folder, browse.nextCursor, loadFolder]);

  useEffect(() => { void loadHome(); }, [loadHome]);

  const loadHistory = useCallback(async () => {
    try {
      const response = await api.history();
      const next: Record<string, WatchHistoryDto> = {};
      response.history.forEach(value => { next[value.nodeId] = value; });
      setHistory(next);
    } catch (error) {
      if ((error as { code?: string }).code === "DEVICE_UNAUTHORIZED") onUnauthorized();
    }
  }, [api, onUnauthorized]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  useEffect(() => {
    mountedRequest.current?.abort();
    const ids = coverAndMediaIds(browse.items, mountedIds);
    if (ids.length === 0) return;
    const controller = new AbortController();
    mountedRequest.current = controller;
    void api.thumbnailUrls(ids, controller.signal).then(response => {
      if (controller.signal.aborted) return;
      setThumbnails(current => {
        const next = { ...current };
        response.items.forEach(item => { next[item.nodeId] = item; });
        return next;
      });
    }).catch(() => undefined);
    return () => controller.abort();
  }, [api, browse.items, mountedIds.join("|")]);

  useEffect(() => {
    if (viewer) return;
    const handler = (event: KeyboardEvent) => {
      const action = normalizeTvKey(event);
      if (!action || !shouldHandleTvKey(action, event.repeat)) return;
      if (action === "menu") {
        if (drawerOpen) {
          closeDrawerAndRestore();
        } else {
          restoreFocusAfterDrawer.current = focusedIndex;
          setDrawerOpen(true);
        }
        event.preventDefault();
      } else if (action === "back" && drawerOpen) {
        closeDrawerAndRestore();
        event.preventDefault();
      } else if (action === "back" && !drawerOpen && stack.length > 0) {
        goBack();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [drawerOpen, focusedIndex, stack, browse, closeDrawerAndRestore, viewer]);

  const openItem = (item: BrowseItem, index: number) => {
    if (item.itemType === "node" && item.kind !== "folder") {
      const mediaItems = browse.items.filter((candidate): candidate is { itemType: "node" } & MediaNodeDto => candidate.itemType === "node" && candidate.kind !== "folder");
      setViewer({ items: mediaItems, selectedItemId: item.id });
      return;
    }
    const nodeId = item.itemType === "root" ? item.nodeId : item.kind === "folder" ? item.id : null;
    if (!nodeId) return;
    setStack(current => pushNavigationEntry(current, {
      folderId: browse.folder?.parent.id ?? null,
      focusedItemId: item.id,
      focusedIndex: index,
      scrollTop,
      loadedPageCursors
    }));
    setFocusedIndex(0);
    setScrollTop(0);
    void loadFolder(nodeId);
  };

  const closeViewer = (restorationItemId: string) => {
    setViewer(null);
    const index = browse.items.findIndex(item => item.id === restorationItemId);
    if (index >= 0) setFocusedIndex(index);
    window.setTimeout(() => setRestoredFocusTick(value => value + 1), 0);
    void loadHistory();
  };

  const goBack = () => {
    const entry = stack.at(-1);
    if (!entry) return;
    setStack(current => current.slice(0, -1));
    const restore = (items: BrowseItem[]) => {
      const restored = restoreNavigationEntry(entry, items.map(item => item.id));
      setFocusedIndex(restored.focusedIndex);
      setScrollTop(restored.scrollTop);
    };
    if (!entry.folderId) {
      void api.home().then(response => {
        const items = response.roots.map(root => ({ ...root, itemType: "root" as const }));
        setBrowse({ folder: null, roots: response.roots, items, nextCursor: null, loading: false, error: null });
        restore(items);
      });
    } else {
      const version = ++loadVersion.current;
      void restoreFolderPages(api, entry.folderId, entry.loadedPageCursors, version, loadVersion).then(result => {
        if (!result) return;
        const items = result.items;
        setBrowse(current => ({ folder: result.folder, roots: current.roots, items, nextCursor: result.nextCursor, loading: false, error: null }));
        setLoadedPageCursors(entry.loadedPageCursors);
        restore(items);
      });
    }
  };

  if (browse.loading && browse.items.length === 0) return <BrowseSkeleton />;
  if (browse.error && browse.items.length === 0) return <StatePanel title="Source temporarily unavailable" body={browse.error}><button className="primary-action" onClick={() => browse.folder ? loadFolder(browse.folder.parent.id) : loadHome()}>Retry</button></StatePanel>;
  if (!browse.folder && browse.items.length === 0) return <StatePanel title="No folders assigned" body="Ask the household administrator to assign at least one folder to this TV."><button className="primary-action" onClick={loadHome}>Refresh</button></StatePanel>;

  if (viewer) return <Viewer api={api} items={viewer.items} selectedItemId={viewer.selectedItemId} slideshowSeconds={slideshowSeconds} previews={thumbnails} onClose={closeViewer} onUnauthorized={onUnauthorized} />;

  const title = browse.folder?.parent.name ?? "Home";
  const currentProgram = !browse.folder && browse.items[focusedIndex]?.itemType === "root"
    ? browse.items[focusedIndex] as ({ itemType: "root" } & TvRootCardDto)
    : null;
  return (
    <main className="browser-shell">
      <TvHeader title={title} breadcrumbs={browse.folder?.breadcrumbs} onHome={loadHome} onSources={() => setDrawerOpen(true)} />
      {currentProgram ? (
        <ProgramProjection program={currentProgram} thumbnails={thumbnails} />
      ) : (
        <section className="browse-heading">
          <div><h1>{title}</h1><p>Household collection</p></div>
          <p>{browse.items.length} {browse.items.length === 1 ? "entry" : "entries"}</p>
        </section>
      )}
      {browse.items.length === 0 ? (
        <section className="empty-folder"><span className="empty-folder-icon"><i /></span><h2>This folder is empty</h2><p>The indexed collection contains no folders or media.</p></section>
      ) : (
        <section className={browse.folder ? "collection-grid" : "program-row"}>
          {!browse.folder && <header><h2>Household program</h2><p>Use the remote to choose a collection</p></header>}
          <VirtualGrid
          ariaLabel={title}
          items={browse.items}
          focusedIndex={focusedIndex}
          columns={browse.folder ? columns : programColumnsForWidth(window.innerWidth)}
          rowHeight={browse.folder ? cardRowHeight() : programRowHeight()}
          viewportHeight={browse.folder ? viewportHeight : programViewportHeight()}
          scrollTop={scrollTop}
          hasNextPage={Boolean(browse.nextCursor)}
          focusRevision={restoredFocusTick}
          onScrollTopChange={setScrollTop}
          onMountedItemsChange={setMountedIds}
          onFocusedIndexChange={(index, extend, pendingIndex) => {
            setFocusedIndex(index);
            const activeColumns = browse.folder ? columns : programColumnsForWidth(window.innerWidth);
            const activeRowHeight = browse.folder ? cardRowHeight() : programRowHeight();
            const activeViewport = browse.folder ? viewportHeight : programViewportHeight();
            ensureIndexVisible(index, activeColumns, activeRowHeight, activeViewport, scrollTop, setScrollTop);
            if (extend) appendNextPage(pendingIndex);
          }}
          onSelect={openItem}
          onBack={stack.length > 0 ? () => { goBack(); return true; } : undefined}
          renderItem={(item, state) => item.itemType === "root" || item.kind === "folder" ? (
            <FolderCard
              name={item.itemType === "root" ? item.displayName : item.name}
              subtitle={item.itemType === "root" ? `${providerLabel(item.provider)} · ${item.accountLabel}` : folderCount(item)}
              thumbnails={(item.folderCoverNodeIds ?? []).map(id => ({ nodeId: id, url: thumbnails[id]?.url }))}
              focused={state.focused}
              program={item.itemType === "root"}
              readiness={item.itemType === "root" ? item.readiness : "ready"}
              readinessMessage={item.itemType === "root" ? item.readinessMessage : "Ready to screen"}
              onSelect={() => openItem(item, state.index)}
            />
          ) : (
            <MediaCard
              name={item.name}
              kind={item.kind}
              thumbnailUrl={thumbnails[item.id]?.url}
              focused={state.focused}
              resumeProgress={item.kind === "video" ? resumeProgress(history[item.id]) : 0}
              onSelect={() => openItem(item, state.index)}
            />
          )}
          />
        </section>
      )}
      <SourceDrawer open={drawerOpen} roots={browse.roots} onClose={closeDrawerAndRestore} onHome={() => { setDrawerOpen(false); void loadHome(); }} onSelect={root => { if (!root.nodeId) return; setDrawerOpen(false); void loadFolder(root.nodeId); }} />
    </main>
  );
}

function ProgramProjection({ program, thumbnails }: {
  program: TvRootCardDto;
  thumbnails: Record<string, ThumbnailUrlItem>;
}) {
  const covers = program.folderCoverNodeIds.slice(0, 3).map(id => thumbnails[id]?.url).filter((url): url is string => Boolean(url));
  return (
    <section className="program-projection" data-readiness={program.readiness}>
      <div className="projection-image" data-cover-count={covers.length}>
        {covers.map((url, index) => <img key={url} src={url} alt="" className={`projection-cover cover-${index + 1}`} />)}
        {covers.length === 0 && <div className="projection-stock" aria-hidden="true"><span>{program.displayName.charAt(0)}</span><i /><b>Cloudframe household program</b></div>}
        <span className="projection-vignette" />
      </div>
      <div className="projection-copy">
        <h1>{program.displayName}</h1>
        <span className={`provider-slate ${program.provider}`}>{providerLabel(program.provider)} · {program.accountLabel}</span>
        <ProgramStatus readiness={program.readiness} message={program.readinessMessage} />
        {program.readiness === "ready" && (
          <p className="program-counts"><strong>{program.childFolderCount}</strong> folders <i /> <strong>{program.childMediaCount}</strong> media</p>
        )}
        {program.readiness !== "ready" && <p className="program-recovery">Content will appear here when the program is ready. Use Cloudframe Admin for recovery.</p>}
      </div>
      <span className="projection-cue" aria-hidden="true"><i /><i /></span>
    </section>
  );
}

function TerminalState({ state, title, body, onRetry }: { state: string; title: string; body: string; onRetry: () => void }) {
  return <StatePanel testId={`state-${state}`} title={title} body={body}><button className="primary-action" onClick={onRetry}>Start again</button></StatePanel>;
}

function Unsupported() {
  return <StatePanel title="This TV browser is not supported" body="Cloudframe needs the browser engine included with LG webOS 5 or newer."><p className="state-detail">Use a webOS 5 or newer TV.</p></StatePanel>;
}

function BrowseSkeleton() {
  return <main className="browser-shell"><TvHeader title="Home" onHome={() => undefined} onSources={() => undefined} /><section className="projection-skeleton"><div /><span /><span /><span /></section><div className="skeleton-grid">{Array.from({ length: 5 }, (_, index) => <span key={index} />)}</div></main>;
}

function useResponsiveColumns() {
  const [columns, setColumns] = useState(() => columnsForWidth(window.innerWidth));
  useEffect(() => {
    const handler = () => setColumns(columnsForWidth(window.innerWidth));
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return columns;
}

function useViewportHeight() {
  const [height, setHeight] = useState(() => Math.max(320, window.innerHeight - 190));
  useEffect(() => {
    const handler = () => setHeight(Math.max(320, window.innerHeight - 190));
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);
  return height;
}

function columnsForWidth(width: number) { return width >= 1700 ? 5 : width >= 1100 ? 4 : width >= 760 ? 3 : 2; }
function programColumnsForWidth(width: number) { return width >= 1700 ? 5 : width >= 1100 ? 4 : width >= 760 ? 3 : 2; }
function cardRowHeight() { return window.innerHeight <= 760 ? 250 : 310; }
function programRowHeight() { return window.innerHeight <= 760 ? 180 : 210; }
function programViewportHeight() { return window.innerHeight <= 760 ? 194 : 224; }
function detectBrowserSupport() { return typeof Promise !== "undefined" && typeof fetch !== "undefined" && typeof URL !== "undefined"; }
function providerLabel(value: string) { return value === "google" ? "Google Drive" : "OneDrive"; }
function folderCount(value: { childFolderCount: number; childMediaCount: number }) { return `${value.childFolderCount} folders · ${value.childMediaCount} media`; }
function resumeProgress(value?: WatchHistoryDto) {
  if (!value || value.completed || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(1, value.positionSeconds / value.durationSeconds));
}

function coverAndMediaIds(items: BrowseItem[], mountedIds: string[]): string[] {
  const mounted: Record<string, boolean> = {};
  mountedIds.forEach(id => { mounted[id] = true; });
  const result: string[] = [];
  items.forEach(item => {
    if (!mounted[item.id]) return;
    if (item.itemType === "node" && item.kind !== "folder" && item.hasPreview) result.push(item.id);
    else item.folderCoverNodeIds.forEach(id => result.push(id));
  });
  return result.filter((id, index) => result.indexOf(id) === index);
}

function ensureIndexVisible(index: number, columns: number, rowHeight: number, viewport: number, current: number, set: (value: number) => void) {
  const top = Math.floor(index / columns) * rowHeight;
  const bottom = top + rowHeight;
  if (top < current) set(top);
  else if (bottom > current + viewport) set(Math.max(0, bottom - viewport));
}

async function restoreFolderPages(
  api: TvApi,
  folderId: string,
  cursors: (string | null)[],
  version: number,
  currentVersion: { current: number }
): Promise<{ folder: TvFolderResponse; items: BrowseItem[]; nextCursor: string | null } | null> {
  let folder: TvFolderResponse | null = null;
  const items: BrowseItem[] = [];
  if (cursors.length > 10_000) throw new Error("Saved navigation contains too many pages to restore safely.");
  const seen = new Set<string>();
  for (const cursor of cursors) {
    const key = cursor ?? "__first_page__";
    if (seen.has(key)) throw new Error("Saved navigation contains a repeated page cursor.");
    seen.add(key);
    const response = await api.folder(folderId, cursor);
    if (version !== currentVersion.current) return null;
    folder = response;
    items.push(...response.children.map(node => ({ ...node, itemType: "node" as const })));
  }
  return folder ? { folder, items, nextCursor: folder.nextCursor } : null;
}
