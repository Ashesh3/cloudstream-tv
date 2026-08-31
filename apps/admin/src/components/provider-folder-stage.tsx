import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlSourceDto, ProviderFolderDto } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChevronRightIcon, FolderIcon, FolderPlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { AdminApiError, type AdminApi, type AdminProviderFolderPage } from "../api/client";
import { providerName } from "../lib/provider-name";

type BrowseLocation = { providerFolderId?: string; name: string };

export function ProviderFolderStage({ api, source, selectedProviderNodeIds, onRootAdded, onClose, onUnauthorized }: {
  api: AdminApi;
  source: ControlSourceDto;
  selectedProviderNodeIds: ReadonlySet<string>;
  onRootAdded(root: Awaited<ReturnType<AdminApi["createRoot"]>>["root"], providerNodeId: string): Promise<void>;
  onClose(): void;
  onUnauthorized?(): void;
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
  const [retryCursor, setRetryCursor] = useState<string | null>(null);
  const locationId = trail.at(-1)?.providerFolderId;
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => { onUnauthorizedRef.current = onUnauthorized; }, [onUnauthorized]);

  const load = useCallback(async (providerFolderId?: string, cursor?: string | null) => {
    const append = Boolean(cursor);
    const sequence = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    if (append) setPaging(true); else { setLoading(true); setPages([]); }
    setError(null);
    setRetryCursor(null);
    try {
      const response = await api.providerFolders(source.id, { providerFolderId, cursor, limit: 100, signal: controller.signal });
      if (sequence !== requestSequence.current) return;
      applyResponse(response, append, setPages);
      setCurrent(response.current);
      setNextCursor(response.nextCursor);
      setRetryCursor(null);
      if (!append) setTrail(response.breadcrumbs.map((item, index) => ({ providerFolderId: index === 0 ? undefined : item.providerNodeId, name: item.name })));
    } catch (cause) {
      if (controller.signal.aborted || isAbort(cause) || sequence !== requestSequence.current) return;
      if (isUnauthorized(cause)) onUnauthorizedRef.current?.();
      else { setError(stageError(cause)); setRetryCursor(append ? cursor ?? null : null); }
    } finally {
      if (sequence === requestSequence.current) { setLoading(false); setPaging(false); activeRequest.current = null; }
    }
  }, [api, source.id]);

  useEffect(() => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    const sequence = ++requestSequence.current;
    setLoading(true); setPages([]); setCurrent(null); setNextCursor(null); setError(null); setRetryCursor(null);
    void api.providerFolders(source.id, { providerFolderId: locationId, cursor: null, limit: 100, signal: controller.signal })
      .then(response => {
        if (sequence !== requestSequence.current) return;
        setPages(uniqueFolders(response.folders)); setCurrent(response.current); setNextCursor(response.nextCursor);
        setRetryCursor(null);
        setTrail(response.breadcrumbs.map((item, index) => ({ providerFolderId: index === 0 ? undefined : item.providerNodeId, name: item.name })));
      })
      .catch(cause => {
        if (controller.signal.aborted || sequence !== requestSequence.current || isAbort(cause)) return;
        if (isUnauthorized(cause)) onUnauthorizedRef.current?.();
        else { setError(stageError(cause)); setRetryCursor(null); }
      })
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
    let result: Awaited<ReturnType<AdminApi["createRoot"]>>;
    try {
      result = await api.createRoot(source.id, { providerNodeId: folder.providerNodeId });
    } catch (cause) {
      if (isUnauthorized(cause)) onUnauthorizedRef.current?.();
      else setError(stageError(cause, "Folder could not be added"));
      setPending(null);
      return;
    }
    setPages(value => value.map(item => item.providerNodeId === folder.providerNodeId ? { ...item, assignedRootId: result.root.id } : item));
    try { await onRootAdded(result.root, folder.providerNodeId); } catch { /* Session expiry is handled by the app. */ }
    setPending(null);
  };

  return <VStack as="section" height="100%" gap={0} aria-labelledby="provider-folder-stage-title" data-workbench-region="provider-stage">
    <Section padding={4} variant="transparent" dividers={["bottom"]}>
      <HStack gap={4} justify="between" align="start">
        <VStack gap={1}>
          <Heading id="provider-folder-stage-title" level={2}>Provider folders</Heading>
          <Text type="supporting">{providerName(source.provider)} · {source.accountLabel}</Text>
        </VStack>
        <Button label="Close folder workbench" variant="ghost" size="lg" icon={<Icon icon={XIcon} />} isIconOnly onClick={onClose} />
      </HStack>
    </Section>
    <Section padding={3} variant="transparent" dividers={["bottom"]}>
      <HStack gap={3} align="center">
        <Button label="Back" variant="secondary" size="lg" isDisabled={loading || trail.length <= 1} onClick={() => setTrail(value => value.slice(0, -1))} />
        <StackItem size="fill" isScrollable>
          <Breadcrumbs variant="supporting" label="Provider folder path" separator={<Icon icon={ChevronRightIcon} size="xsm" />}>
            {trail.map((item, index) => <BreadcrumbItem
              key={item.providerFolderId ?? "provider-root"}
              isCurrent={index === trail.length - 1}
              onClick={index === trail.length - 1 ? undefined : () => navigateBreadcrumb(index)}
              startIcon={index === 0 ? <Icon icon={FolderIcon} size="sm" /> : undefined}
            >{item.name}</BreadcrumbItem>)}
          </Breadcrumbs>
        </StackItem>
      </HStack>
    </Section>
    <StackItem size="fill" isScrollable as="section" aria-live="polite">
      <Section padding={0} variant="transparent">
        {loading ? <FolderSkeletons /> : error && pages.length === 0 ? <StageErrorPanel error={error} onRetry={() => void load(locationId, retryCursor)} onReconnect={onClose} /> : pages.length === 0 ? <EmptyState
          title="This provider folder is empty"
          description="The live provider response contains no child folders at this level."
          icon={<Icon icon={FolderIcon} size="lg" />}
          headingLevel={3}
        /> : <List density="balanced" hasDividers aria-label={`Folders in ${current?.name ?? providerRootName}`}>
          {pages.map(folder => {
            const selected = Boolean(folder.assignedRootId || selectedProviderNodeIds.has(folder.providerNodeId));
            return <ListItem
              key={folder.providerNodeId}
              startContent={<Icon icon={FolderIcon} color="secondary" />}
              label={folder.name}
              endContent={<HStack gap={2} align="center">
                <Button
                  label={selected ? `${folder.name} is in the household program` : `Add ${folder.name} to household program`}
                  variant={selected ? "secondary" : "primary"}
                  size="lg"
                  icon={<Icon icon={FolderPlusIcon} />}
                  isDisabled={selected || pending === folder.providerNodeId}
                  isLoading={pending === folder.providerNodeId}
                  onClick={() => void add(folder)}
                >{selected ? "Added" : pending === folder.providerNodeId ? "Adding…" : "Add"}</Button>
                <Button label={`Open ${folder.name}`} variant="ghost" size="lg" icon={<Icon icon={ChevronRightIcon} />} isIconOnly onClick={() => navigate(folder)} />
              </HStack>}
            />;
          })}
        </List>}
        {!loading && error && pages.length > 0 && <VStack padding={4}><StageErrorPanel error={error} onRetry={() => void load(locationId, retryCursor)} onReconnect={onClose} /></VStack>}
        {!loading && !error && nextCursor && <HStack padding={4} justify="center">
          <Button label={paging ? "Loading…" : "Load more folders"} variant="secondary" size="lg" isDisabled={paging} isLoading={paging} onClick={() => void load(locationId, nextCursor)} />
        </HStack>}
      </Section>
    </StackItem>
  </VStack>;
}

function applyResponse(response: AdminProviderFolderPage, append: boolean, setPages: React.Dispatch<React.SetStateAction<ProviderFolderDto[]>>) {
  setPages(value => uniqueFolders(append ? [...value, ...response.folders] : response.folders));
}
function uniqueFolders(folders: ProviderFolderDto[]) { return [...new Map(folders.map(folder => [folder.providerNodeId, folder])).values()]; }
function isAbort(cause: unknown) { return cause instanceof DOMException && cause.name === "AbortError"; }
function isUnauthorized(cause: unknown) {
  return cause instanceof AdminApiError ? cause.status === 401 : Boolean(cause && typeof cause === "object" && "status" in cause && (cause as { status: unknown }).status === 401);
}
type StageError = { title: string; description: string; action: "retry" | "reconnect" };
function stageError(cause: unknown, fallback = "Folder listing failed"): StageError {
  if ((cause instanceof AdminApiError && cause.code === "PROVIDER_REAUTH_REQUIRED") || isCode(cause, "PROVIDER_REAUTH_REQUIRED")) return { title: "Reconnect this account", description: "The provider needs renewed authorization before live browsing can continue.", action: "reconnect" };
  return { title: fallback, description: "Provider temporarily unavailable", action: "retry" };
}
function isCode(value: unknown, code: string) { return Boolean(value && typeof value === "object" && "code" in value && (value as { code: unknown }).code === code); }
function StageErrorPanel({ error, onRetry, onReconnect }: { error: StageError; onRetry(): void; onReconnect(): void }) {
  return <Banner
    status="error"
    title={error.title}
    description={error.description}
    container="section"
    endContent={<Button label={error.action === "reconnect" ? "Return to reconnect" : "Try again"} variant="secondary" icon={<Icon icon={RefreshCwIcon} />} onClick={error.action === "reconnect" ? onReconnect : onRetry} />}
  />;
}
function FolderSkeletons() {
  return <VStack gap={0} padding={4} aria-label="Loading provider folders">
    {Array.from({ length: 5 }, (_, index) => <HStack gap={3} align="center" paddingBlock={2} key={index}>
      <Skeleton width="var(--spacing-8)" height="var(--spacing-8)" radius={2} index={index} />
      <StackItem size="fill"><Skeleton height="var(--spacing-4)" radius={1} index={index} /></StackItem>
      <Skeleton width="var(--spacing-16)" height="var(--spacing-7)" radius={2} index={index} />
    </HStack>)}
  </VStack>;
}
