import type { DirectThumbnailItem, MediaOrder, TvBrowseItemDto, TvRootDto } from "@cloudframe/shared";
import { sortBrowseItems } from "@cloudframe/shared";
import { normalizeTvKey, shouldHandleTvKey } from "@cloudframe/tv-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";

import { tvApi, type TvApi, type TvHomeResponse } from "./api/client";
import { DeviceRequest, StatePanel } from "./components/device-request";
import { FolderCard } from "./components/folder-card";
import { MediaCard } from "./components/media-card";
import { SourceDrawer } from "./components/source-drawer";
import { TvHeader, type TvBreadcrumb } from "./components/tv-header";
import { VirtualGrid } from "./components/virtual-grid";
import { Viewer } from "./components/viewer";
import { WaitingScreen } from "./components/waiting-screen";
import { createLocalWatchHistory, type LocalWatchHistory, type LocalWatchHistoryEntry } from "./state/local-watch-history";
import { useTvSession } from "./state/use-tv-session";

type BrowseItem =
  | ({ itemType: "root" } & TvRootDto)
  | ({ itemType: "node" } & TvBrowseItemDto);

interface BrowseState {
  parent: TvBrowseItemDto | null;
  breadcrumbs: TvBreadcrumb[];
  roots: TvRootDto[];
  items: BrowseItem[];
  nextCursor: string | null;
  loadedPageCursors: (string | null)[];
  loading: boolean;
  error: string | null;
  paginationError: string | null;
}

interface BrowseStackEntry extends BrowseState {
  folderHandle: string | null;
  focusedItemId: string | null;
  focusedIndex: number;
  scrollTop: number;
}

type ThumbnailState = DirectThumbnailItem & {
  requestedHandle: string;
  expiresAtEpoch?: number;
};

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
  const mediaOrder = session.state.device.mediaOrder ?? session.state.household.defaultMediaOrder;
  const slideshowSeconds = session.state.device.slideshowSeconds ?? session.state.household.defaultSlideshowSeconds;
  return <ReadyBrowserShell api={api} deviceId={session.state.device.id} mediaOrder={mediaOrder} onUnauthorized={session.refresh} slideshowSeconds={slideshowSeconds} />;
}

function ReadyBrowserShell({ api, deviceId, mediaOrder, onUnauthorized, slideshowSeconds }: {
  api: TvApi;
  deviceId: string;
  mediaOrder: MediaOrder;
  onUnauthorized: () => void;
  slideshowSeconds: number;
}) {
  const history = useMemo(() => createLocalWatchHistory(localWatchHistoryStorage(), deviceId), [deviceId]);
  return <BrowserShell key={deviceId} api={api} history={history} mediaOrder={mediaOrder} onUnauthorized={onUnauthorized} slideshowSeconds={slideshowSeconds} />;
}

function BrowserShell({ api, history, mediaOrder, onUnauthorized, slideshowSeconds }: {
  api: TvApi;
  history: LocalWatchHistory;
  mediaOrder: MediaOrder;
  onUnauthorized: () => void;
  slideshowSeconds: number;
}) {
  const [browse, setBrowse] = useState<BrowseState>(emptyBrowseState());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [stack, setStack] = useState<BrowseStackEntry[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, ThumbnailState>>({});
  const [thumbnailRequestRevision, setThumbnailRequestRevision] = useState(0);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const [restoredFocusTick, setRestoredFocusTick] = useState(0);
  const [viewer, setViewer] = useState<{ items: TvBrowseItemDto[]; selectedItemId: string } | null>(null);
  const [, setHistoryRevision] = useState(0);
  const loadVersion = useRef(0);
  const pageRequest = useRef<Promise<void> | null>(null);
  const requestedFocus = useRef<number | null>(null);
  const requestedFocusItemId = useRef<string | null>(null);
  const restoreFocusAfterDrawer = useRef<number | null>(null);
  const mountedRequest = useRef<AbortController | null>(null);
  const thumbnailExpiryTimers = useRef<Record<string, { identity: string; cancel: () => void }>>({});
  const thumbnailRetryTimer = useRef<number | null>(null);
  const thumbnailInstallRetries = useRef<Record<string, boolean>>({});
  const browseRef = useRef(browse);
  const scrollTopRef = useRef(scrollTop);
  const columns = useResponsiveColumns();
  const viewportHeight = useViewportHeight();

  useEffect(() => { browseRef.current = browse; }, [browse]);
  useEffect(() => { scrollTopRef.current = scrollTop; }, [scrollTop]);
  useEffect(() => () => {
    clearScheduled(thumbnailExpiryTimers.current);
    if (thumbnailRetryTimer.current !== null) window.clearTimeout(thumbnailRetryTimer.current);
  }, []);

  const clearThumbnailLifecycle = useCallback(() => {
    clearScheduled(thumbnailExpiryTimers.current);
    if (thumbnailRetryTimer.current !== null) window.clearTimeout(thumbnailRetryTimer.current);
    thumbnailRetryTimer.current = null;
    thumbnailInstallRetries.current = {};
  }, []);

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

  const applyHome = useCallback((response: TvHomeResponse) => {
    clearThumbnailLifecycle();
    const roots = dedupeLastById(response.roots);
    const items = roots.map(root => ({ ...root, itemType: "root" as const }));
    const next = homeBrowseState(roots, items);
    browseRef.current = next;
    setBrowse(next);
    setFocusedIndex(0);
    setScrollTop(0);
    setStack([]);
    setThumbnails({});
  }, [clearThumbnailLifecycle]);

  const handleBrowseError = useCallback((error: unknown, retainItems: boolean) => {
    const code = errorCode(error);
    if (code === "DEVICE_UNAUTHORIZED") {
      clearThumbnailLifecycle();
      clearSessionState(loadVersion, pageRequest, mountedRequest, setBrowse, setStack, setThumbnails, setViewer);
      onUnauthorized();
      return;
    }
    if (code === "NAVIGATION_EXPIRED" || code === "ITEM_NOT_FOUND") {
      clearThumbnailLifecycle();
      clearSessionState(loadVersion, pageRequest, mountedRequest, setBrowse, setStack, setThumbnails, setViewer);
      void api.home().then(applyHome).catch(() => setBrowse(current => ({ ...current, loading: false, error: "This collection could not be refreshed." })));
      return;
    }
    const message = code === "PROVIDER_REAUTH_REQUIRED"
      ? "This source needs attention in Cloudframe Admin."
      : code === "PROVIDER_THROTTLED"
        ? "The provider is busy. Try again shortly."
        : "This source is temporarily unavailable.";
    setBrowse(current => ({ ...current, loading: false, error: message, items: retainItems ? current.items : [] }));
  }, [api, applyHome, clearThumbnailLifecycle, onUnauthorized]);

  const loadHome = useCallback(async () => {
    const version = ++loadVersion.current;
    setBrowse(current => ({ ...current, loading: true, error: null }));
    try {
      const response = await api.home();
      if (version !== loadVersion.current) return;
      applyHome(response);
    } catch (error) {
      if (version !== loadVersion.current) return;
      handleBrowseError(error, false);
    }
  }, [api, applyHome, handleBrowseError]);

  const loadFolder = useCallback(async (
    handle: string,
    options: { expectedParentId: string; cursor?: string | null; append?: boolean; breadcrumbs: TvBreadcrumb[] }
  ) => {
    const append = options.append === true;
    const version = ++loadVersion.current;
    if (!append) setBrowse(current => ({ ...current, loading: true, error: null }));
    try {
      const response = await api.folder(handle, options.cursor);
      if (version !== loadVersion.current) return;
      if (response.parent.id !== options.expectedParentId) {
        handleBrowseError(Object.assign(new Error("Invalid folder response."), { code: "NAVIGATION_EXPIRED" }), append);
        return;
      }
      const incoming = response.children.map(node => ({ ...node, itemType: "node" as const }));
      setBrowse(current => {
        const pending = requestedFocus.current;
        const previousFocusId = requestedFocusItemId.current;
        const existingIds: Record<string, boolean> = {};
        current.items.forEach(item => { existingIds[item.id] = true; });
        const newIdCount = incoming.reduce((count, item) => count + (existingIds[item.id] ? 0 : 1), 0);
        const pageTargetId = append && pending !== null && pending >= current.items.length
          ? incoming[pending - current.items.length]?.id ?? null
          : previousFocusId;
        const items = append
          ? mergeFolderItems(current.items, incoming, mediaOrder)
          : sortFolderBrowseItems(dedupeLastById(incoming), mediaOrder);
        const cursorCycle = append && response.nextCursor !== null && (
          response.nextCursor === options.cursor || current.loadedPageCursors.indexOf(response.nextCursor) >= 0
        );
        const noProgress = append && newIdCount === 0;
        const next: BrowseState = {
          parent: response.parent,
          breadcrumbs: options.breadcrumbs,
          roots: current.roots,
          items,
          nextCursor: cursorCycle || noProgress ? null : response.nextCursor,
          loadedPageCursors: append ? [...current.loadedPageCursors, options.cursor ?? null] : [null],
          loading: false,
          error: null,
          paginationError: cursorCycle
            ? "More items could not be loaded. Refresh this collection to try again."
            : noProgress
              ? "No additional items were returned. Refresh this collection to check again."
              : null
        };
        browseRef.current = next;
        if (append && pending !== null) {
          const targetId = noProgress ? previousFocusId : pageTargetId;
          const restored = targetId ? items.findIndex(item => item.id === targetId) : -1;
          setFocusedIndex(restored >= 0 ? restored : Math.min(pending, Math.max(0, items.length - 1)));
        }
        return next;
      });
      requestedFocus.current = null;
      requestedFocusItemId.current = null;
    } catch (error) {
      if (version !== loadVersion.current) return;
      requestedFocus.current = null;
      requestedFocusItemId.current = null;
      handleBrowseError(error, append);
    }
  }, [api, handleBrowseError, mediaOrder]);

  const appendNextPage = useCallback((pendingIndex?: number) => {
    if (!browse.parent || !browse.nextCursor || pageRequest.current) return;
    if (browse.loadedPageCursors.indexOf(browse.nextCursor) >= 0) {
      setBrowse(current => ({ ...current, nextCursor: null, paginationError: "More items could not be loaded. Refresh this collection to try again." }));
      return;
    }
    requestedFocus.current = pendingIndex ?? null;
    requestedFocusItemId.current = browse.items[focusedIndex]?.id ?? null;
    const promise = loadFolder(browse.parent.handle, {
      expectedParentId: browse.parent.id,
      cursor: browse.nextCursor,
      append: true,
      breadcrumbs: browse.breadcrumbs
    }).finally(() => {
      if (pageRequest.current === promise) pageRequest.current = null;
    });
    pageRequest.current = promise;
  }, [browse.breadcrumbs, browse.items, browse.loadedPageCursors, browse.nextCursor, browse.parent, focusedIndex, loadFolder]);

  useEffect(() => { void loadHome(); }, [loadHome]);

  useEffect(() => {
    mountedRequest.current?.abort();
    const requested = visibleThumbnailItems(browse.items, mountedIds).filter(item => thumbnails[item.id]?.requestedHandle !== item.handle);
    if (requested.length === 0) return;
    const controller = new AbortController();
    mountedRequest.current = controller;
    void api.thumbnailUrls(requested.map(item => item.handle), controller.signal).then(response => {
      if (controller.signal.aborted) return;
      let retryExpired = false;
      const requestedIds: Record<string, boolean> = {};
      requested.forEach(item => { requestedIds[item.id] = true; });
      setThumbnails(current => {
        const next = { ...current };
        response.items.forEach(item => {
          if (!requestedIds[item.itemId]) return;
          const requestedItem = requested.find(candidate => candidate.id === item.itemId);
          if (!requestedItem) return;
          if (item.status === "unavailable") {
            delete thumbnailInstallRetries.current[requestedItem.handle];
            next[item.itemId] = { ...item, requestedHandle: requestedItem.handle };
            return;
          }
          const expiresAtEpoch = futureExpiryEpoch(item.expiresAt);
          if (expiresAtEpoch === null) {
            delete next[item.itemId];
            if (!thumbnailInstallRetries.current[requestedItem.handle]) {
              thumbnailInstallRetries.current[requestedItem.handle] = true;
              retryExpired = true;
            }
            return;
          }
          delete thumbnailInstallRetries.current[requestedItem.handle];
          next[item.itemId] = { ...item, requestedHandle: requestedItem.handle, expiresAtEpoch };
        });
        return next;
      });
      if (retryExpired && thumbnailRetryTimer.current === null) {
        thumbnailRetryTimer.current = window.setTimeout(() => {
          thumbnailRetryTimer.current = null;
          setThumbnailRequestRevision(value => value + 1);
        }, 25);
      }
    }).catch(error => {
      if (controller.signal.aborted) return;
      const code = errorCode(error);
      if (code === "DEVICE_UNAUTHORIZED" || code === "NAVIGATION_EXPIRED" || code === "ITEM_NOT_FOUND") handleBrowseError(error, true);
    });
    return () => controller.abort();
  }, [api, browse.items, handleBrowseError, mountedIds.join("|"), thumbnailRequestRevision]);

  useEffect(() => {
    const visible: Record<string, boolean> = {};
    visibleThumbnailItems(browse.items, mountedIds).forEach(item => { visible[item.id] = true; });
    Object.keys(thumbnails).forEach(itemId => {
      const entry = thumbnails[itemId]!;
      if (entry.status !== "ready" || entry.expiresAtEpoch === undefined || !visible[itemId]) return;
      const identity = `${entry.requestedHandle}:${entry.expiresAtEpoch}`;
      const previous = thumbnailExpiryTimers.current[itemId];
      if (previous?.identity === identity) return;
      previous?.cancel();
      const timer: { identity: string; cancel: () => void } = { identity, cancel: () => undefined };
      timer.cancel = scheduleBoundedAt(entry.expiresAtEpoch, () => {
        if (thumbnailExpiryTimers.current[itemId]?.identity !== identity) return;
        delete thumbnailExpiryTimers.current[itemId];
        setThumbnails(current => {
          const active = current[itemId];
          if (!active || active.status !== "ready" || active.requestedHandle !== entry.requestedHandle || active.expiresAtEpoch !== entry.expiresAtEpoch) return current;
          const next = { ...current };
          delete next[itemId];
          return next;
        });
        setThumbnailRequestRevision(value => value + 1);
      });
      thumbnailExpiryTimers.current[itemId] = timer;
    });
    Object.keys(thumbnailExpiryTimers.current).forEach(itemId => {
      const entry = thumbnails[itemId];
      const identity = entry?.status === "ready" && entry.expiresAtEpoch !== undefined ? `${entry.requestedHandle}:${entry.expiresAtEpoch}` : null;
      if (visible[itemId] && identity === thumbnailExpiryTimers.current[itemId]!.identity) return;
      thumbnailExpiryTimers.current[itemId]!.cancel();
      delete thumbnailExpiryTimers.current[itemId];
    });
  }, [browse.items, mountedIds.join("|"), thumbnails]);

  const goBack = useCallback(() => {
    const entry = stack[stack.length - 1];
    if (!entry) return;
    loadVersion.current += 1;
    pageRequest.current = null;
    mountedRequest.current?.abort();
    clearThumbnailLifecycle();
    setStack(current => current.slice(0, -1));
    const restoredIndex = restoredFocusIndex(entry, entry.items);
    const next: BrowseState = {
      parent: entry.parent,
      breadcrumbs: entry.breadcrumbs,
      roots: entry.roots,
      items: entry.items,
      nextCursor: entry.nextCursor,
      loadedPageCursors: entry.loadedPageCursors,
      loading: entry.loading,
      error: entry.error,
      paginationError: entry.paginationError
    };
    browseRef.current = next;
    setBrowse(next);
    setFocusedIndex(restoredIndex);
    setScrollTop(entry.scrollTop);
    window.setTimeout(() => setRestoredFocusTick(value => value + 1), 0);
  }, [clearThumbnailLifecycle, stack]);

  useEffect(() => {
    if (viewer) return;
    const handler = (event: KeyboardEvent) => {
      const action = normalizeTvKey(event);
      if (!action || !shouldHandleTvKey(action, event.repeat)) return;
      if (action === "menu") {
        if (drawerOpen) closeDrawerAndRestore();
        else {
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
  }, [closeDrawerAndRestore, drawerOpen, focusedIndex, goBack, stack.length, viewer]);

  const openItem = (item: BrowseItem, index: number) => {
    if (item.itemType === "node" && item.kind !== "folder") {
      const mediaItems = browse.items.filter((candidate): candidate is { itemType: "node" } & TvBrowseItemDto => candidate.itemType === "node" && candidate.kind !== "folder");
      setViewer({ items: mediaItems, selectedItemId: item.id });
      return;
    }
    const handle = item.handle;
    const current = browseRef.current;
    setStack(entries => [...entries, {
      ...current,
      folderHandle: current.parent?.handle ?? null,
      focusedItemId: item.id,
      focusedIndex: index,
      scrollTop: scrollTopRef.current
    }]);
    setFocusedIndex(0);
    setScrollTop(0);
    const breadcrumbs = current.parent
      ? [...current.breadcrumbs, { id: current.parent.id, name: current.parent.name }]
      : [];
    void loadFolder(handle, { expectedParentId: item.id, breadcrumbs });
  };

  const openRootFromDrawer = (root: TvRootDto) => {
    const current = browseRef.current;
    const homeItems = current.roots.map(candidate => ({ ...candidate, itemType: "root" as const }));
    const index = homeItems.findIndex(item => item.id === root.id);
    const home = homeBrowseState(current.roots, homeItems);
    setDrawerOpen(false);
    setStack([{
      ...home,
      folderHandle: null,
      focusedItemId: root.id,
      focusedIndex: index >= 0 ? index : 0,
      scrollTop: 0
    }]);
    setFocusedIndex(0);
    setScrollTop(0);
    void loadFolder(root.handle, { expectedParentId: root.id, breadcrumbs: [] });
  };

  const closeViewer = (restorationItemId: string) => {
    setViewer(null);
    const index = browse.items.findIndex(item => item.id === restorationItemId);
    if (index >= 0) setFocusedIndex(index);
    window.setTimeout(() => setRestoredFocusTick(value => value + 1), 0);
    setHistoryRevision(value => value + 1);
  };

  const refreshExpiredNavigation = useCallback(() => {
    clearThumbnailLifecycle();
    clearSessionState(loadVersion, pageRequest, mountedRequest, setBrowse, setStack, setThumbnails, setViewer);
    void api.home().then(applyHome).catch(() => setBrowse(current => ({ ...current, loading: false, error: "This collection could not be refreshed." })));
  }, [api, applyHome, clearThumbnailLifecycle]);

  if (browse.loading && browse.items.length === 0) return <BrowseSkeleton />;
  if (browse.error && browse.items.length === 0) return <StatePanel title="Source temporarily unavailable" body={browse.error}><button className="primary-action" onClick={() => browse.parent ? loadFolder(browse.parent.handle, { expectedParentId: browse.parent.id, breadcrumbs: browse.breadcrumbs }) : loadHome()}>Retry</button></StatePanel>;
  if (!browse.parent && browse.items.length === 0) return <StatePanel title="No folders assigned" body="Ask the household administrator to assign at least one folder to this TV."><button className="primary-action" onClick={loadHome}>Refresh</button></StatePanel>;
  if (viewer) return <Viewer api={api} history={history} items={viewer.items} selectedItemId={viewer.selectedItemId} slideshowSeconds={slideshowSeconds} previews={thumbnails} onClose={closeViewer} onUnauthorized={onUnauthorized} onNavigationExpired={refreshExpiredNavigation} />;

  const title = browse.parent?.name ?? "Home";
  const currentProgram = !browse.parent && browse.items[focusedIndex]?.itemType === "root"
    ? browse.items[focusedIndex] as ({ itemType: "root" } & TvRootDto)
    : null;
  return (
    <main className="browser-shell">
      <TvHeader title={title} breadcrumbs={browse.breadcrumbs} onHome={loadHome} onSources={() => setDrawerOpen(true)} />
      {currentProgram ? <ProgramProjection program={currentProgram} /> : (
        <section className="browse-heading"><div><h1>{title}</h1><p>Household collection</p></div></section>
      )}
      {browse.items.length === 0 ? (
        <section className="empty-folder"><span className="empty-folder-icon"><i /></span><h2>This folder is empty</h2><p>This collection contains no supported folders, photos, or videos.</p></section>
      ) : (
        <section className={browse.parent ? "collection-grid" : "program-row"}>
          {!browse.parent && <header><h2>Household program</h2><p>Use the remote to choose a collection</p></header>}
          <VirtualGrid
            ariaLabel={title}
            items={browse.items}
            focusedIndex={focusedIndex}
            columns={browse.parent ? columns : programColumnsForWidth(window.innerWidth)}
            rowHeight={browse.parent ? cardRowHeight() : programRowHeight()}
            viewportHeight={browse.parent ? viewportHeight : programViewportHeight()}
            scrollTop={scrollTop}
            hasNextPage={Boolean(browse.nextCursor)}
            focusRevision={restoredFocusTick}
            onScrollTopChange={setScrollTop}
            onMountedItemsChange={setMountedIds}
            onFocusedIndexChange={(index, extend, pendingIndex) => {
              setFocusedIndex(index);
              const activeColumns = browse.parent ? columns : programColumnsForWidth(window.innerWidth);
              const activeRowHeight = browse.parent ? cardRowHeight() : programRowHeight();
              const activeViewport = browse.parent ? viewportHeight : programViewportHeight();
              ensureIndexVisible(index, activeColumns, activeRowHeight, activeViewport, scrollTop, setScrollTop);
              if (extend) appendNextPage(pendingIndex);
            }}
            onSelect={openItem}
            onBack={stack.length > 0 ? () => { goBack(); return true; } : undefined}
            renderItem={(item, state) => item.itemType === "root" || item.kind === "folder" ? (
              <FolderCard
                name={item.itemType === "root" ? item.displayName : item.name}
                subtitle={item.itemType === "root" ? `${providerLabel(item.provider)} · ${item.accountLabel}` : undefined}
                focused={state.focused}
                program={item.itemType === "root"}
                onSelect={() => openItem(item, state.index)}
              />
            ) : (
              <MediaCard
                name={item.name}
                kind={item.kind}
                thumbnailUrl={thumbnails[item.id]?.url}
                focused={state.focused}
                resumeProgress={item.kind === "video" ? resumeProgress(history.get(item.id)) : 0}
                onSelect={() => openItem(item, state.index)}
              />
            )}
          />
        </section>
      )}
      {browse.paginationError ? <p className="pagination-status" role="status">{browse.paginationError}</p> : null}
      <SourceDrawer open={drawerOpen} roots={browse.roots} onClose={closeDrawerAndRestore} onHome={() => { setDrawerOpen(false); void loadHome(); }} onSelect={openRootFromDrawer} />
    </main>
  );
}

function ProgramProjection({ program }: { program: TvRootDto }) {
  return (
    <section className="program-projection">
      <div className="projection-image">
        <div className="projection-stock" aria-hidden="true"><span>{program.displayName.charAt(0)}</span><i /><b>Cloudframe household program</b></div>
        <span className="projection-vignette" />
      </div>
      <div className="projection-copy">
        <h1>{program.displayName}</h1>
        <span className={`provider-slate ${program.provider}`}>{providerLabel(program.provider)} · {program.accountLabel}</span>
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

function emptyBrowseState(): BrowseState {
  return { parent: null, breadcrumbs: [], roots: [], items: [], nextCursor: null, loadedPageCursors: [], loading: true, error: null, paginationError: null };
}

function homeBrowseState(roots: TvRootDto[], items: BrowseItem[]): BrowseState {
  return { parent: null, breadcrumbs: [], roots, items, nextCursor: null, loadedPageCursors: [], loading: false, error: null, paginationError: null };
}

function mergeFolderItems(current: BrowseItem[], incoming: BrowseItem[], order: MediaOrder): BrowseItem[] {
  const byId: Record<string, BrowseItem> = {};
  current.forEach(item => { if (item.itemType === "node") byId[item.id] = item; });
  incoming.forEach(item => { if (item.itemType === "node") byId[item.id] = item; });
  return sortFolderBrowseItems(Object.keys(byId).map(id => byId[id]!), order);
}

function dedupeLastById<T extends { id: string }>(items: readonly T[]): T[] {
  const byId: Record<string, T> = {};
  const order: string[] = [];
  items.forEach(item => {
    if (byId[item.id] === undefined) order.push(item.id);
    byId[item.id] = item;
  });
  return order.map(id => byId[id]!);
}

function restoredFocusIndex(entry: BrowseStackEntry, items: BrowseItem[]): number {
  if (items.length === 0) return 0;
  const found = entry.focusedItemId ? items.findIndex(item => item.id === entry.focusedItemId) : -1;
  return found >= 0 ? found : Math.min(Math.max(entry.focusedIndex, 0), items.length - 1);
}

function sortFolderBrowseItems(items: BrowseItem[], order: MediaOrder): BrowseItem[] {
  const nodes = items.filter((item): item is { itemType: "node" } & TvBrowseItemDto => item.itemType === "node");
  return sortBrowseItems(nodes, order);
}

function visibleThumbnailItems(items: BrowseItem[], mountedIds: string[]): TvBrowseItemDto[] {
  const mounted: Record<string, boolean> = {};
  mountedIds.forEach(id => { mounted[id] = true; });
  return items.filter((item): item is { itemType: "node" } & TvBrowseItemDto => item.itemType === "node" && item.kind !== "folder" && item.hasPreview && mounted[item.id]);
}

function clearSessionState(
  loadVersion: { current: number },
  pageRequest: { current: Promise<void> | null },
  mountedRequest: { current: AbortController | null },
  setBrowse: (value: BrowseState | ((current: BrowseState) => BrowseState)) => void,
  setStack: (value: BrowseStackEntry[]) => void,
  setThumbnails: (value: Record<string, ThumbnailState>) => void,
  setViewer: (value: null) => void
) {
  loadVersion.current += 1;
  pageRequest.current = null;
  mountedRequest.current?.abort();
  mountedRequest.current = null;
  setBrowse(emptyBrowseState());
  setStack([]);
  setThumbnails({});
  setViewer(null);
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
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
function resumeProgress(value?: LocalWatchHistoryEntry | null) {
  if (!value || value.completed || !Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(1, value.positionSeconds / value.durationSeconds));
}

function localWatchHistoryStorage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function ensureIndexVisible(index: number, columns: number, rowHeight: number, viewport: number, current: number, set: (value: number) => void) {
  const top = Math.floor(index / columns) * rowHeight;
  const bottom = top + rowHeight;
  if (top < current) set(top);
  else if (bottom > current + viewport) set(Math.max(0, bottom - viewport));
}

function futureExpiryEpoch(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value && epoch > Date.now() ? epoch : null;
}

function scheduleBoundedAt(expiresAtEpoch: number, callback: () => void): () => void {
  const state = { cancelled: false, timer: 0 };
  const schedule = () => {
    if (state.cancelled) return;
    const remaining = expiresAtEpoch - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    state.timer = window.setTimeout(schedule, Math.min(remaining, 2_147_000_000));
  };
  schedule();
  return () => {
    state.cancelled = true;
    window.clearTimeout(state.timer);
  };
}

function clearScheduled(timers: Record<string, { identity: string; cancel: () => void }>): void {
  Object.keys(timers).forEach(key => timers[key]!.cancel());
  Object.keys(timers).forEach(key => { delete timers[key]; });
}
