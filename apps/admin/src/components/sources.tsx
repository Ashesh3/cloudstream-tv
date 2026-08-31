import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlDeviceDto, ControlRootDto, ControlSourceDto } from "@cloudframe/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { CloudIcon, FolderCogIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import type { AdminApi, AdminImpact } from "../api/client";
import { AdminApiError } from "../api/client";
import { FolderPicker } from "./folder-picker";
import type { RootRemovalRequest } from "./source-workbench";
import { Empty, PageHeader } from "./requests";

export function Sources({ sources, roots, devices, api, onRootAdded, onRootRemoved, onRemoveSource, onAuthorize, onUnauthorized = () => undefined, onWorkbenchOpen, onWorkbenchClose, onWorkbenchChange, workbenchRemovalRequest }: {
  sources: ControlSourceDto[];
  roots: ControlRootDto[];
  devices: ControlDeviceDto[];
  api: AdminApi;
  onRootAdded(root: ControlRootDto): Promise<boolean>;
  onRootRemoved(rootId: string): Promise<boolean>;
  onRemoveSource(sourceId: string): Promise<void>;
  onAuthorize(provider: "google" | "onedrive", reconnect?: string): Promise<void>;
  onUnauthorized?(): void;
  onWorkbenchOpen?(value: SourceWorkbenchState): void;
  onWorkbenchClose?(): void;
  onWorkbenchChange?(value: SourceWorkbenchState | null): void;
  workbenchRemovalRequest?: RootRemovalRequest | null;
}) {
  const [pickerId, setPicker] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ControlSourceDto | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [impact, setImpact] = useState<AdminImpact | null>(null);
  const [pending, setPending] = useState(false);
  const [impactLoading, setImpactLoading] = useState(false);
  const [error, setError] = useState("");
  const pickerTrigger = useRef<HTMLButtonElement | null>(null);
  const openedPickerId = useRef<string | null>(null);
  const previousPickerId = useRef<string | null>(null);
  const impactGeneration = useRef(0);
  const isNarrowWorkbench = useMediaQuery("(max-width: 64rem)", false);
  const sourcesRef = useRef(sources);
  const devicesRef = useRef(devices);
  const workbenchChangeRef = useRef(onWorkbenchChange);
  const onRootAddedRef = useRef(onRootAdded);
  const onRootRemovedRef = useRef(onRootRemoved);
  sourcesRef.current = sources;
  devicesRef.current = devices;
  workbenchChangeRef.current = onWorkbenchChange;
  onRootAddedRef.current = onRootAdded;
  onRootRemovedRef.current = onRootRemoved;
  const handleWorkbenchRootAdded = useCallback((root: ControlRootDto) => onRootAddedRef.current(root), []);
  const handleWorkbenchRootRemoved = useCallback((rootId: string) => onRootRemovedRef.current(rootId), []);
  const updateWorkbenchProgram = useCallback((programRoots: SourceWorkbenchState["roots"]) => {
    if (!isNarrowWorkbench && pickerId) {
      const source = sourcesRef.current.find(value => value.id === pickerId);
      if (source) workbenchChangeRef.current?.({ source, roots: programRoots, devices: devicesRef.current });
    }
  }, [isNarrowWorkbench, pickerId]);

  useEffect(() => {
    if (previousPickerId.current && !pickerId) pickerTrigger.current?.focus();
    previousPickerId.current = pickerId;
  }, [pickerId]);
  useEffect(() => {
    if (!pickerId) return;
    const source = sourcesRef.current.find(value => value.id === pickerId);
    if (isNarrowWorkbench) onWorkbenchClose?.();
    else if (source) onWorkbenchOpen?.({ source, roots: roots.filter(root => root.sourceId === source.id), devices: devicesRef.current });
  }, [devices, isNarrowWorkbench, onWorkbenchClose, onWorkbenchOpen, pickerId, roots]);
  useEffect(() => () => { impactGeneration.current += 1; }, []);
  useEffect(() => {
    if (removeOpen || !removing || pending || impactLoading) return;
    const timer = window.setTimeout(() => { setRemoving(null); setImpact(null); }, 0);
    return () => window.clearTimeout(timer);
  }, [impactLoading, removeOpen, removing, pending]);

  const previewRemoval = async (source: ControlSourceDto) => {
    const generation = ++impactGeneration.current;
    setRemoving(source);
    setRemoveOpen(false);
    setImpact(null);
    setImpactLoading(true);
    setError("");
    try {
      const next = await api.sourceImpact(source.id);
      if (generation === impactGeneration.current) {
        setImpact(next);
        setRemoveOpen(true);
      }
    } catch (cause) {
      if (generation === impactGeneration.current) {
        setRemoveOpen(false);
        if (isStatus(cause, 401)) onUnauthorized();
        else setError(safeFailure(cause, "Removal impact could not be loaded."));
      }
    } finally {
      if (generation === impactGeneration.current) setImpactLoading(false);
    }
  };

  const remove = async () => {
    if (!removing || !impact || pending) return;
    setPending(true);
    setError("");
    try {
      await onRemoveSource(removing.id);
      impactGeneration.current += 1;
      setRemoveOpen(false);
    } catch (cause) {
      setError(safeFailure(cause, "Source could not be removed."));
    } finally {
      setPending(false);
    }
  };

  const pickerSource = pickerId ? sources.find(source => source.id === pickerId) : undefined;
  if (pickerSource) return <FolderPicker source={pickerSource} roots={roots.filter(root => root.sourceId === pickerSource.id)} devices={devices} api={api} onRootAdded={handleWorkbenchRootAdded} onRootRemoved={handleWorkbenchRootRemoved} onUnauthorized={onUnauthorized} renderHouseholdProgram={isNarrowWorkbench} removalRequest={workbenchRemovalRequest} onProgramChange={updateWorkbenchProgram} onClose={() => { onWorkbenchClose?.(); onWorkbenchChange?.(null); setPicker(null); }} />;

  return <VStack as="section" gap={5}>
    <PageHeader context="Cloud library" title="Sources" description="Connect accounts, browse folders live, and expose only the folders you approve." action={<HStack gap={2} wrap="wrap"><Button label="Connect Google Drive" variant="secondary" icon={<Icon icon={CloudIcon} />} onClick={() => void onAuthorize("google")} /><Button label="Connect OneDrive" variant="primary" icon={<Icon icon={CloudIcon} />} onClick={() => void onAuthorize("onedrive")} /></HStack>} />
    {error && <Banner status="error" title="Source action failed" description={error} container="section" />}
    {!sources.length ? <Empty title="No cloud sources" body="Connect Google Drive or OneDrive to browse and choose household folders." icon={<Icon icon={CloudIcon} />} /> : <List density="balanced" hasDividers>
      {sources.map(source => {
        const sourceRoots = roots.filter(root => root.sourceId === source.id);
        const activeRoots = sourceRoots.filter(root => root.enabled);
        const inactiveCount = sourceRoots.length - activeRoots.length;
        const status = sourceStatus(source.status);
        return <ListItem
          key={source.id}
          data-testid="source-row"
          startContent={<Icon icon={CloudIcon} color="secondary" />}
          label={<HStack gap={2} align="center"><Text weight="semibold">{source.accountLabel}</Text><StatusDot variant={status.variant} label={status.label} /><Text type="supporting">{status.label}</Text></HStack>}
          description={<VStack gap={2}><Text type="supporting">{source.provider === "google" ? "Google Drive" : "OneDrive"} · {activeRoots.length} approved {activeRoots.length === 1 ? "folder" : "folders"} · {inactiveCount} inactive {inactiveCount === 1 ? "record" : "records"}</Text>{activeRoots.length > 0 && <HStack gap={2} wrap="wrap">{activeRoots.map(root => <Token key={root.id} label={root.displayName} size="sm" color="blue" />)}</HStack>}</VStack>}
          endContent={<HStack gap={2} wrap="wrap"><Button ref={node => { if (source.id === openedPickerId.current) pickerTrigger.current = node; }} label="Browse & choose folders" variant="secondary" icon={<Icon icon={FolderCogIcon} />} onClick={() => { openedPickerId.current = source.id; if (!isNarrowWorkbench) onWorkbenchOpen?.({ source, roots: sourceRoots, devices }); setPicker(source.id); }} /><Button label={`Reconnect ${source.accountLabel}`} variant="secondary" icon={<Icon icon={RotateCwIcon} />} onClick={() => void onAuthorize(source.provider, source.id)}>Reconnect</Button><Button label={`Remove ${source.accountLabel}`} variant="destructive" icon={<Icon icon={Trash2Icon} />} onClick={() => void previewRemoval(source)}>Remove</Button></HStack>}
        />;
      })}
    </List>}
    {removing && impact && <AlertDialog
      isOpen={removeOpen}
      onOpenChange={open => { if (!open && !pending) { impactGeneration.current += 1; setRemoveOpen(false); } }}
      title="Remove source"
      description={`Removing ${removing.accountLabel} removes ${impact.roots.map(root => root.displayName).join(", ") || "its folders"} from ${impact.devices.map(device => device.name).join(", ") || "assigned televisions"} immediately.`}
      actionLabel="Remove source permanently"
      isActionLoading={pending}
      onAction={() => void remove()}
      width="36rem"
    />}
    {removing && impactLoading && <HStack gap={2} align="center" role="status"><Spinner size="sm" /><Text type="supporting">Loading removal impact…</Text></HStack>}
  </VStack>;
}

function sourceStatus(status: ControlSourceDto["status"]) {
  if (status === "healthy") return { label: "Connected", variant: "success" as const };
  if (status === "reauth-required") return { label: "Reauthorization required", variant: "warning" as const };
  return { label: "Disabled", variant: "neutral" as const };
}

function safeFailure(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.name === "AdminApiError" ? cause.message : fallback;
}

function isStatus(value: unknown, status: number): value is AdminApiError {
  return value instanceof AdminApiError ? value.status === status : Boolean(value && typeof value === "object" && "status" in value && (value as { status: unknown }).status === status);
}

export type SourceWorkbenchState = {
  source: ControlSourceDto;
  roots: Array<ControlRootDto & { providerNodeId?: string }>;
  devices: ControlDeviceDto[];
};
