import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ControlDeviceDto, ControlRootDto, MediaOrder, UpdateDeviceBody } from "@cloudframe/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxList, CheckboxListItem } from "@astryxdesign/core/CheckboxList";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { MonitorIcon, PencilIcon, ShieldOffIcon } from "lucide-react";
import { Empty, PageHeader, relativeTime } from "./requests";
import { AdminApiError } from "../api/client";

export function Devices({ devices, roots, onUpdate, onRevoke }: {
  devices: ControlDeviceDto[];
  roots: ControlRootDto[];
  onUpdate(id: string, body: UpdateDeviceBody): Promise<void>;
  onRevoke(device: ControlDeviceDto): void;
}) {
  const [editing, setEditing] = useState<ControlDeviceDto | null>(null);

  return <VStack as="section" gap={5}>
    <PageHeader context="Televisions" title="Devices" description="Control folder access and playback defaults for every approved television." />
    {!devices.length ? <Empty title="No approved devices" body="Approve a request to add your first television." icon={<Icon icon={MonitorIcon} />} /> : <List density="balanced" hasDividers>
      {devices.map(device => {
        const assignedRoots = device.assignedRootIds.map(id => roots.find(root => root.id === id)).filter((root): root is ControlRootDto => Boolean(root));
        const activeRoots = assignedRoots.filter(root => root.enabled);
        const inactiveRoots = assignedRoots.filter(root => !root.enabled);
        const access = !device.enabled ? { label: "Paused", variant: "neutral" as const } : activeRoots.length ? { label: "Active", variant: "success" as const } : { label: "No active folders", variant: "warning" as const };
        return <ListItem
          key={device.id}
          data-testid="device-row"
          startContent={<Icon icon={MonitorIcon} color="secondary" />}
          label={<HStack gap={2} align="center"><Text weight="semibold">{device.name}</Text><StatusDot variant={access.variant} label={access.label} /><Text type="supporting">{access.label}</Text></HStack>}
          description={<VStack gap={2}>
            <Text type="supporting">Approved {relativeTime(device.approvedAt)} · {activeRoots.length} active folders · {orderLabel(device.mediaOrder)} · {device.slideshowSeconds ? `${device.slideshowSeconds} seconds` : "Default slideshow"}</Text>
            {(activeRoots.length > 0 || inactiveRoots.length > 0) && <HStack gap={2} wrap="wrap">{activeRoots.map(root => <Token key={root.id} label={root.displayName} size="sm" color="blue" />)}{inactiveRoots.map(root => <Token key={root.id} label={`Inactive · ${root.displayName}`} size="sm" color="gray" />)}{inactiveRoots.length > 0 && <Text type="supporting">Grants no access</Text>}</HStack>}
          </VStack>}
          endContent={<HStack gap={2} wrap="wrap"><Button label={`Edit ${device.name}`} variant="secondary" icon={<Icon icon={PencilIcon} />} onClick={() => setEditing(device)}>Edit access</Button><Button label={`Revoke ${device.name}`} variant="destructive" icon={<Icon icon={ShieldOffIcon} />} onClick={() => onRevoke(device)}>Revoke</Button></HStack>}
        />;
      })}
    </List>}
    {editing && <DeviceEditor device={editing} roots={roots} onClose={() => setEditing(null)} onSave={body => onUpdate(editing.id, body)} />}
  </VStack>;
}

function DeviceEditor({ device, roots, onClose, onSave }: { device: ControlDeviceDto; roots: ControlRootDto[]; onClose(): void; onSave(body: UpdateDeviceBody): Promise<void> }) {
  const [name, setName] = useState(device.name);
  const [enabled, setEnabled] = useState(device.enabled);
  const activeRootIds = new Set(roots.filter(root => root.enabled).map(root => root.id));
  const inactiveAssignedRoots = roots.filter(root => !root.enabled && device.assignedRootIds.includes(root.id));
  const [assignedRootIds, setAssigned] = useState(device.assignedRootIds.filter(id => activeRootIds.has(id)));
  const [mediaOrder, setOrder] = useState<MediaOrder | "default">(device.mediaOrder ?? "default");
  const [slideshow, setSlideshow] = useState<number | null>(device.slideshowSeconds ?? null);
  const slideshowRef = useRef<HTMLInputElement | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(true);
  const submitting = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);

  useEffect(() => {
    if (isOpen) return;
    const timer = window.setTimeout(() => {
      onClose();
      window.setTimeout(() => {
        if (returnFocus.current?.isConnected) returnFocus.current.focus();
        else document.getElementById("astryx-app-shell-main")?.focus();
      }, 0);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen, onClose]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    if (!name.trim()) {
      setError("Enter a device name.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const slideshowDraft = slideshowRef.current?.value.trim() ?? "";
      const parsedSlideshow = slideshowDraft === "" ? null : Number(slideshowDraft);
      const slideshowSeconds = parsedSlideshow === null
        ? null
        : Number.isInteger(parsedSlideshow) && parsedSlideshow >= 2 && parsedSlideshow <= 300
          ? parsedSlideshow
          : slideshow;
      await onSave({ name: name.trim(), enabled, assignedRootIds, mediaOrder: mediaOrder === "default" ? null : mediaOrder, slideshowSeconds });
      setIsOpen(false);
    } catch (cause) {
      setError(cause instanceof AdminApiError ? cause.message : "Device update failed.");
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const close = () => {
    if (!pending) setIsOpen(false);
  };

  return <Dialog isOpen={isOpen} onOpenChange={open => { if (!open) close(); }} width="42rem" maxHeight="92dvh" purpose="form" aria-label="Edit device">
    <form onSubmit={submit}>
      <Layout
        height="fill"
        defaultHasDividers
        header={<DialogHeader title="Edit device" subtitle="Change its name, folder access, and playback defaults." onOpenChange={open => { if (!open) close(); }} />}
        content={<LayoutContent padding={4} isScrollable><FormLayout>
          <TextInput label="Device name" value={name} onChange={setName} hasAutoFocus isDisabled={pending} status={!name.trim() && error ? { type: "error", message: error } : undefined} width="100%" />
          <Switch label="Device enabled" description="Disabling takes effect on its next request." value={enabled} onChange={setEnabled} isDisabled={pending} labelPosition="start" labelSpacing="spread" width="100%" />
          {inactiveAssignedRoots.length > 0 && <Banner status="warning" title="Inactive legacy assignments will be removed" description={inactiveAssignedRoots.map(root => `${root.displayName} is inactive and grants no access. Saving removes this legacy assignment.`).join(" ")} container="section" />}
          <CheckboxList label="Assigned folders" value={assignedRootIds} onChange={setAssigned} isDisabled={pending} hasDividers>
            {roots.filter(root => root.enabled).map(root => <CheckboxListItem key={root.id} value={root.id} label={root.displayName} />)}
          </CheckboxList>
          <RadioList label="Media ordering" value={mediaOrder} onChange={value => setOrder(value as MediaOrder | "default")} isDisabled={pending}>
            <RadioListItem value="default" label="Household default" />
            <RadioListItem value="captured-desc" label="Newest captured first" />
            <RadioListItem value="captured-asc" label="Oldest captured first" />
            <RadioListItem value="name-asc" label="Name A–Z" />
          </RadioList>
          <NumberInput ref={slideshowRef} label="Slideshow seconds" description="Leave empty to use the household default." value={slideshow} onChange={setSlideshow} hasClear min={2} max={300} isIntegerOnly isWheelEnabled={false} units="seconds" isDisabled={pending} width="100%" />
          {name.trim() && error && <Banner status="error" title="Device update failed" description={error} container="section" />}
        </FormLayout></LayoutContent>}
        footer={<LayoutFooter padding={4}><HStack gap={2} justify="end" wrap="wrap"><Button type="button" label="Cancel" variant="secondary" isDisabled={pending} onClick={close} /><Button type="submit" label={pending ? "Saving…" : "Save device"} variant="primary" isDisabled={pending} isLoading={pending} /></HStack></LayoutFooter>}
      />
    </form>
  </Dialog>;
}

function orderLabel(value: MediaOrder | null) {
  return value === "name-asc" ? "Name A–Z" : value === "captured-asc" ? "Oldest first" : value === "captured-desc" ? "Newest first" : "Default order";
}
