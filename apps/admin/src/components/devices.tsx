import { type FormEvent, useState } from "react";
import type { AssignedRootDto, DeviceDto, MediaOrder, UpdateDeviceBody } from "@cloudframe/shared";
import { Dialog } from "./dialog";
import { Empty, PageHeader, relativeTime } from "./requests";

export function Devices({ devices, roots, onUpdate, onRevoke }: {
  devices: DeviceDto[];
  roots: AssignedRootDto[];
  onUpdate(id: string, body: UpdateDeviceBody): Promise<void>;
  onRevoke(device: DeviceDto): void;
}) {
  const [editing, setEditing] = useState<DeviceDto | null>(null);
  return <section><PageHeader eyebrow="Televisions" title="Devices" description="Control folder access and playback defaults for every approved television." />
    {!devices.length ? <Empty title="No approved devices" body="Approve a request to add your first television." /> : <div className="device-grid">{devices.map(device => <article className={`device-card ${device.enabled ? "" : "muted"}`} key={device.id}>
      <div className="card-title-row"><div><p className="device-kicker">{device.enabled ? "Online access" : "Access paused"}</p><h2>{device.name}</h2></div><span className={`status ${device.enabled ? "healthy" : "disabled"}`}>{device.enabled ? "Enabled" : "Disabled"}</span></div>
      <dl><div><dt>Last seen</dt><dd>{relativeTime(device.lastSeenAt)}</dd></div><div><dt>Folders</dt><dd>{device.assignedRootIds.length}</dd></div><div><dt>Order</dt><dd>{orderLabel(device.mediaOrder)}</dd></div><div><dt>Slideshow</dt><dd>{device.slideshowSeconds ? `${device.slideshowSeconds}s` : "Household default"}</dd></div></dl>
      <div className="root-chips">{device.assignedRootIds.map(id => <span key={id}>{roots.find(root => root.id === id)?.displayName ?? "Unavailable root"}</span>)}</div>
      <div className="card-actions spread"><button className="button secondary" aria-label={`Edit ${device.name}`} onClick={() => setEditing(device)}>Edit access</button><button className="text-danger" aria-label={`Revoke ${device.name}`} onClick={() => onRevoke(device)}>Revoke</button></div>
    </article>)}</div>}
    {editing && <DeviceEditor device={editing} roots={roots} onClose={() => setEditing(null)} onSave={async body => { await onUpdate(editing.id, body); setEditing(null); }} />}
  </section>;
}

function DeviceEditor({ device, roots, onClose, onSave }: { device: DeviceDto; roots: AssignedRootDto[]; onClose(): void; onSave(body: UpdateDeviceBody): Promise<void> }) {
  const [name, setName] = useState(device.name);
  const [enabled, setEnabled] = useState(device.enabled);
  const [assignedRootIds, setAssigned] = useState(device.assignedRootIds);
  const [mediaOrder, setOrder] = useState<MediaOrder | "">(device.mediaOrder ?? "");
  const [slideshow, setSlideshow] = useState(device.slideshowSeconds?.toString() ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => { event.preventDefault(); if (!name.trim() || !assignedRootIds.length) { setError("Enter a name and select at least one root."); return; } setPending(true); setError(""); try { await onSave({ name: name.trim(), enabled, assignedRootIds, mediaOrder: mediaOrder || null, slideshowSeconds: slideshow ? Number(slideshow) : null }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Device update failed."); } finally { setPending(false); } };
  return <Dialog label="Edit device" onClose={onClose}><form onSubmit={submit}><header className="dialog-header"><div><p className="eyebrow">Television access</p><h2>Edit device</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close">×</button></header><div className="dialog-scroll form-stack">
    <label className="field">Device name<input data-autofocus value={name} onChange={event => setName(event.target.value)} /></label>
    <div className="toggle-row"><span><label htmlFor="device-enabled"><strong>Device enabled</strong></label><small id="device-enabled-help">Disabling takes effect on its next request.</small></span><input id="device-enabled" aria-describedby="device-enabled-help" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /></div>
    <fieldset className="compact-checks"><legend>Assigned roots</legend>{roots.filter(root => root.enabled).map(root => <label key={root.id}><input type="checkbox" checked={assignedRootIds.includes(root.id)} onChange={() => setAssigned(value => value.includes(root.id) ? value.filter(id => id !== root.id) : [...value, root.id])} />{root.displayName}</label>)}</fieldset>
    <label className="field">Media ordering<select value={mediaOrder} onChange={event => setOrder(event.target.value as MediaOrder | "")}><option value="">Household default</option><option value="captured-desc">Newest captured first</option><option value="captured-asc">Oldest captured first</option><option value="name-asc">Name A–Z</option></select></label>
    <label className="field">Slideshow seconds<input type="number" min="2" max="300" value={slideshow} placeholder="Household default" onChange={event => setSlideshow(event.target.value)} /></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
  </div><footer className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={pending}>{pending ? "Saving…" : "Save device"}</button></footer></form></Dialog>;
}
function orderLabel(value: MediaOrder | null) { return value === "name-asc" ? "Name A–Z" : value === "captured-asc" ? "Oldest first" : value === "captured-desc" ? "Newest first" : "Household default"; }
