import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowLeftIcon, MonitorIcon } from "lucide-react";
import type { AdminApi } from "../api/client";
import { AdminApiError } from "../api/client";
import { providerName } from "../lib/provider-name";
import { HouseholdProgram, type ProgramRoot } from "./household-program";
import { ProviderFolderStage } from "./provider-folder-stage";

export interface SourceWorkbenchProps {
  source: ControlSourceDto;
  roots: ControlRootDto[];
  devices?: ControlDeviceDto[];
  api: AdminApi;
  onRootAdded(root: ControlRootDto): Promise<boolean>;
  onRootRemoved(rootId: string): Promise<boolean>;
  onClose(): void;
  onUnauthorized?(): void;
  onProgramChange?(roots: ProgramRoot[]): void;
  renderHouseholdProgram?: boolean;
  removalRequest?: { root: ProgramRoot; generation: number } | null;
}

export type RootRemovalRequest = { root: ProgramRoot; generation: number };

export function SourceWorkbench({ source, roots, devices = [], api, onRootAdded, onRootRemoved, onClose, onUnauthorized = () => undefined, onProgramChange, renderHouseholdProgram = true, removalRequest }: SourceWorkbenchProps) {
  const [programRoots, setProgramRoots] = useState<ProgramRoot[]>(roots);
  const [removeRoot, setRemoveRoot] = useState<ProgramRoot | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [impact, setImpact] = useState<{ devices: ControlDeviceDto[] } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const workbenchRef = useRef<HTMLElement>(null);
  const impactRequest = useRef<{ generation: number; rootId: string | null }>({ generation: 0, rootId: null });
  const handledRemovalGeneration = useRef<number | null>(null);
  const removalTrigger = useRef<HTMLElement | null>(null);
  const removalCancel = useRef<HTMLButtonElement | null>(null);
  const reviewRemoval = useCallback(async (root: ProgramRoot) => {
    const generation = impactRequest.current.generation + 1;
    impactRequest.current = { generation, rootId: root.id };
    removalTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRemoveRoot(root); setRemoveOpen(true); setImpact(null); setError("");
    try {
      const nextImpact = await api.rootImpact(root.id);
      if (impactRequest.current.generation === generation && impactRequest.current.rootId === root.id) setImpact(nextImpact);
    } catch (cause) {
      if (impactRequest.current.generation === generation && impactRequest.current.rootId === root.id) {
        if (isStatus(cause, 401)) onUnauthorized();
        else setError(safeFailure(cause, "Removal impact could not be loaded."));
      }
    }
  }, [api, onUnauthorized]);
  useEffect(() => { setProgramRoots(current => roots.map(root => ({ ...root, providerNodeId: current.find(value => value.id === root.id)?.providerNodeId }))); }, [roots]);
  useEffect(() => {
    if (!removalRequest || handledRemovalGeneration.current === removalRequest.generation) return;
    handledRemovalGeneration.current = removalRequest.generation;
    void reviewRemoval(removalRequest.root);
  }, [removalRequest, reviewRemoval]);
  useEffect(() => () => { impactRequest.current = { generation: impactRequest.current.generation + 1, rootId: null }; }, []);
  useEffect(() => { const timer = window.setTimeout(() => workbenchRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus()); return () => window.clearTimeout(timer); }, []);
  useEffect(() => {
    if (!removeOpen || !impact) return;
    const timer = window.setTimeout(() => removalCancel.current?.focus());
    return () => window.clearTimeout(timer);
  }, [impact, removeOpen]);

  const invalidateImpactRequest = () => { impactRequest.current = { generation: impactRequest.current.generation + 1, rootId: null }; };
  const closeRemoval = () => { if (pending) return; invalidateImpactRequest(); setRemoveOpen(false); };
  useEffect(() => {
    if (removeOpen || !removeRoot || pending) return;
    const timer = window.setTimeout(() => {
      setRemoveRoot(null); setImpact(null); setError("");
      window.setTimeout(() => removalTrigger.current?.focus(), 0);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pending, removeOpen, removeRoot]);
  const remove = async () => {
    if (!removeRoot || !impact) return;
    setPending(true); setError("");
    const removedId = removeRoot.id;
    const removedName = removeRoot.displayName;
    try { await api.removeRoot(removedId); }
    catch (cause) {
      if (isStatus(cause, 401)) onUnauthorized();
      else setError(safeFailure(cause, "Folder could not be removed."));
      setPending(false);
      return;
    }
    invalidateImpactRequest();
    const nextProgramRoots = programRoots.filter(root => root.id !== removedId);
    setProgramRoots(nextProgramRoots);
    onProgramChange?.(nextProgramRoots);
    setRemoveOpen(false); setImpact(null); setNotice(`${removedName} was removed from the household program.`); setRefreshWarning("");
    try { if (!(await onRootRemoved(removedId))) setRefreshWarning(COMMITTED_REFRESH_WARNING); } catch { /* 401 unmounts the app. */ }
    finally { setPending(false); }
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => { if (event.key !== "Escape" || removeRoot) return; event.preventDefault(); event.stopPropagation(); onClose(); };
  const selectedCount = programRoots.filter(root => root.enabled).length;

  return <>
    <VStack ref={workbenchRef} as="section" gap={5} role="region" aria-labelledby="source-workbench-title" data-workbench="source-folders" tabIndex={-1} onKeyDown={keyDown}>
      <HStack gap={4} align="center" justify="between" wrap="wrap">
        <Button label="Back to sources" data-autofocus variant="ghost" icon={<Icon icon={ArrowLeftIcon} />} onClick={onClose} />
        <VStack gap={0.5}>
          <Text weight="semibold">{source.accountLabel}</Text>
          <Text type="supporting">{providerName(source.provider)}</Text>
        </VStack>
        <Badge label={`${selectedCount} ${selectedCount === 1 ? "folder" : "folders"}`} variant="neutral" aria-label={`${selectedCount} selected program folders`} />
      </HStack>
      <VStack gap={1}>
        <Heading level={1} id="source-workbench-title">Choose source folders</Heading>
        <Text color="secondary">Browse the provider live. Folders added to the household program are available to assigned televisions immediately.</Text>
      </VStack>
      {notice && <Banner status="success" title="Household program updated" description={notice} container="section" />}
      {refreshWarning && <Banner status="warning" title="Household refresh needed" description={refreshWarning} container="section" />}
      <ProviderFolderStage
        api={api}
        source={source}
        selectedProviderNodeIds={new Set(programRoots.flatMap(root => root.providerNodeId ? [root.providerNodeId] : []))}
        onUnauthorized={onUnauthorized}
        onRootAdded={async (root, providerNodeId) => {
          const nextProgramRoots = [...new Map([...programRoots, { ...root, providerNodeId }].map(item => [item.id, item])).values()];
          setProgramRoots(nextProgramRoots);
          onProgramChange?.(nextProgramRoots);
          setNotice(`${root.displayName} was added to the household program.`);
          setRefreshWarning("");
          try { if (!(await onRootAdded(root))) setRefreshWarning(COMMITTED_REFRESH_WARNING); } catch { /* 401 unmounts the app. */ }
        }}
        onClose={onClose}
      />
      {renderHouseholdProgram && <HouseholdProgram source={source} roots={programRoots} devices={devices} onRemove={root => void reviewRemoval(root)} />}
    </VStack>
    {removeRoot && <Dialog isOpen={removeOpen} onOpenChange={open => { if (!open) closeRemoval(); }} width="36rem" purpose="form" aria-label="Remove folder from household program">
      <Layout
        height="auto"
        header={<DialogHeader title={`Remove ${removeRoot.displayName}?`} subtitle="Access is removed immediately from every assigned television." onOpenChange={open => { if (!open) closeRemoval(); }} />}
        content={<LayoutContent isScrollable={false}>
          <VStack gap={4}>
            {!impact && !error && <HStack gap={2} align="center" role="status"><Spinner size="sm" /><Text>Loading affected televisions…</Text></HStack>}
            {impact && (impact.devices.length ? <List density="compact" hasDividers header={<Text weight="semibold">Affected televisions</Text>}>{impact.devices.map(device => <ListItem key={device.id} startContent={<Icon icon={MonitorIcon} color="secondary" />} label={device.name} />)}</List> : <Text>No televisions currently use this folder.</Text>)}
            {error && <Banner status="error" title="Removal impact unavailable" description={error} container="section" />}
          </VStack>
        </LayoutContent>}
        footer={<LayoutFooter hasDivider><HStack gap={2} justify="end" wrap="wrap"><Button ref={removalCancel} label="Cancel" variant="secondary" isDisabled={pending} onClick={closeRemoval} /><Button label={`Remove ${removeRoot.displayName}`} variant="destructive" isDisabled={!impact || pending} isLoading={pending} onClick={() => void remove()} /></HStack></LayoutFooter>}
      />
    </Dialog>}
  </>;
}

function safeFailure(cause: unknown, fallback: string) { return cause instanceof Error && cause.name === "AdminApiError" ? cause.message : fallback; }
function isStatus(value: unknown, status: number): value is AdminApiError { return value instanceof AdminApiError ? value.status === status : Boolean(value && typeof value === "object" && "status" in value && (value as { status: unknown }).status === status); }
const COMMITTED_REFRESH_WARNING = "Change saved, but household data could not be refreshed. Refresh to confirm the latest state.";
