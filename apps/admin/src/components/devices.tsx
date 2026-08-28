import { type FormEvent, useState } from "react";
import type { ControlDeviceDto, ControlRootDto, MediaOrder, UpdateDeviceBody } from "@cloudframe/shared";
import { FolderOpenIcon, MonitorIcon, PencilIcon, ShieldOffIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Empty, PageHeader, relativeTime } from "./requests";
import { AdminApiError } from "../api/client";

export function Devices({ devices, roots, onUpdate, onRevoke }: {
  devices: ControlDeviceDto[];
  roots: ControlRootDto[];
  onUpdate(id: string, body: UpdateDeviceBody): Promise<void>;
  onRevoke(device: ControlDeviceDto): void;
}) {
  const [editing, setEditing] = useState<ControlDeviceDto | null>(null);
  return <section className="flex flex-col gap-5"><PageHeader context="Televisions" title="Devices" description="Control folder access and playback defaults for every approved television." />
    {!devices.length ? <Empty title="No approved devices" body="Approve a request to add your first television." icon={<MonitorIcon />} /> : <div className="device-ledger">{devices.map(device => {
      const assignedRoots = device.assignedRootIds.map(id => roots.find(root => root.id === id)).filter((root): root is ControlRootDto => Boolean(root));
      const activeRoots = assignedRoots.filter(root => root.enabled);
      const inactiveRoots = assignedRoots.filter(root => !root.enabled);
      const access = !device.enabled ? "Paused" : activeRoots.length ? "Active" : "No active folders";
      return <Card className={`device-entry ${device.enabled ? "" : "is-paused"}`} key={device.id}>
      <CardHeader><div className="flex items-center gap-3"><span className="device-cue flex size-10 items-center justify-center text-muted-foreground"><MonitorIcon /></span><div><CardTitle><h2 className="text-base font-medium">{device.name}</h2></CardTitle><CardDescription className="mt-1">Approved {relativeTime(device.approvedAt)}</CardDescription></div></div><CardAction><Badge variant={device.enabled && activeRoots.length ? "secondary" : "outline"}>{!device.enabled ? "Paused" : activeRoots.length ? "On program" : "No active folders"}</Badge></CardAction></CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Stat label="Active folders" value={activeRoots.length.toString()} /><Stat label="Order" value={orderLabel(device.mediaOrder)} /><Stat label="Slideshow" value={device.slideshowSeconds ? `${device.slideshowSeconds}s` : "Default"} /><Stat label="Access" value={access} /></CardContent>
      <CardContent className="flex flex-wrap gap-2">{activeRoots.map(root => <Badge variant="outline" key={root.id}><FolderOpenIcon data-icon="inline-start" />{root.displayName}</Badge>)}{inactiveRoots.map(root => <Badge variant="outline" className="inactive-root-badge" key={root.id}><FolderOpenIcon data-icon="inline-start" />Inactive · {root.displayName}</Badge>)}{inactiveRoots.length > 0 && <span className="text-xs text-muted-foreground">Grants no access</span>}</CardContent>
      <CardFooter className="justify-between"><Button variant="outline" aria-label={`Edit ${device.name}`} onClick={() => setEditing(device)}><PencilIcon data-icon="inline-start" />Edit access</Button><Button variant="destructive" aria-label={`Revoke ${device.name}`} onClick={() => onRevoke(device)}><ShieldOffIcon data-icon="inline-start" />Revoke</Button></CardFooter>
    </Card>;
    })}</div>}
    {editing && <DeviceEditor device={editing} roots={roots} onClose={() => setEditing(null)} onSave={async body => { await onUpdate(editing.id, body); setEditing(null); }} />}
  </section>;
}

function Stat({ label, value }: { label: string; value: string }) { return <div className="ledger-stat"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate text-sm font-medium">{value}</p></div>; }

function DeviceEditor({ device, roots, onClose, onSave }: { device: ControlDeviceDto; roots: ControlRootDto[]; onClose(): void; onSave(body: UpdateDeviceBody): Promise<void> }) {
  const [name, setName] = useState(device.name);
  const [enabled, setEnabled] = useState(device.enabled);
  const activeRootIds = new Set(roots.filter(root => root.enabled).map(root => root.id));
  const inactiveAssignedRoots = roots.filter(root => !root.enabled && device.assignedRootIds.includes(root.id));
  const [assignedRootIds, setAssigned] = useState(device.assignedRootIds.filter(id => activeRootIds.has(id)));
  const [mediaOrder, setOrder] = useState<MediaOrder | "">(device.mediaOrder ?? "");
  const [slideshow, setSlideshow] = useState(device.slideshowSeconds?.toString() ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim()) { setError("Enter a device name."); return; } setPending(true); setError(""); try { await onSave({ name: name.trim(), enabled, assignedRootIds, mediaOrder: mediaOrder || null, slideshowSeconds: slideshow ? Number(slideshow) : null }); } catch (cause) { setError(cause instanceof AdminApiError ? cause.message : "Device update failed."); } finally { setPending(false); } };
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent aria-label="Edit device" className="max-h-[92vh] overflow-y-auto sm:max-w-xl"><form onSubmit={submit} className="contents"><DialogHeader><DialogTitle>Edit device</DialogTitle><DialogDescription>Change its name, folder access, and playback defaults.</DialogDescription></DialogHeader><FieldGroup>
    <Field data-invalid={Boolean(error && !name.trim())}><FieldLabel htmlFor="edit-device-name">Device name</FieldLabel><Input id="edit-device-name" data-autofocus autoFocus value={name} onChange={event => setName(event.target.value)} /></Field>
    <Field orientation="horizontal"><FieldLabel htmlFor="device-enabled" className="w-full"><Field orientation="horizontal"><FieldGroup><span className="font-medium">Device enabled</span><FieldDescription>Disabling takes effect on its next request.</FieldDescription></FieldGroup><Switch id="device-enabled" aria-label="Device enabled" checked={enabled} onCheckedChange={setEnabled} /></Field></FieldLabel></Field>
    <FieldSet><FieldLegend>Assigned folders</FieldLegend>{inactiveAssignedRoots.length > 0 && <div className="ledger-warning p-3 text-sm">{inactiveAssignedRoots.map(root => <p key={root.id}>{root.displayName} is inactive and grants no access. Saving removes this legacy assignment.</p>)}</div>}<div className="grid gap-2">{roots.filter(root => root.enabled).map(root => <FieldLabel key={root.id} htmlFor={`device-root-${root.id}`} className="w-full"><Field orientation="horizontal"><Checkbox id={`device-root-${root.id}`} aria-label={root.displayName} checked={assignedRootIds.includes(root.id)} onCheckedChange={() => setAssigned(value => value.includes(root.id) ? value.filter(id => id !== root.id) : [...value, root.id])} /><span>{root.displayName}</span></Field></FieldLabel>)}</div></FieldSet>
    <Field><FieldLabel htmlFor="device-order">Media ordering</FieldLabel><select id="device-order" className="h-9 rounded-lg border bg-background px-3 text-sm" value={mediaOrder} onChange={event => setOrder(event.target.value as MediaOrder | "")}><option value="">Household default</option><option value="captured-desc">Newest captured first</option><option value="captured-asc">Oldest captured first</option><option value="name-asc">Name A–Z</option></select></Field>
    <Field><FieldLabel htmlFor="device-slideshow">Slideshow seconds</FieldLabel><Input id="device-slideshow" type="number" min="2" max="300" value={slideshow} placeholder="Household default" onChange={event => setSlideshow(event.target.value)} /></Field>
    {error && <FieldError>{error}</FieldError>}
  </FieldGroup><DialogFooter><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button>{pending && <Spinner data-icon="inline-start" />}{pending ? "Saving…" : "Save device"}</Button></DialogFooter></form></DialogContent></Dialog>;
}
function orderLabel(value: MediaOrder | null) { return value === "name-asc" ? "Name A–Z" : value === "captured-asc" ? "Oldest first" : value === "captured-desc" ? "Newest first" : "Default"; }
