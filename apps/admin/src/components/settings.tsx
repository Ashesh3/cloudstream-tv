import { type FormEvent, useEffect, useState } from "react";
import type { AdminSnapshotResponse, ControlHouseholdDto, MediaOrder, UpdateAdminSettingsBody } from "@cloudframe/shared";
import { PageHeader } from "./requests";
import { AlertTriangleIcon, CloudIcon, FolderOpenIcon, LogOutIcon, MonitorIcon, ShieldCheckIcon, TimerIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function Settings({ household, snapshot, onSave, onRotate, onLogout }: {
  household: ControlHouseholdDto;
  snapshot: AdminSnapshotResponse;
  onSave(value: UpdateAdminSettingsBody): Promise<void>;
  onRotate(current: string, next: string): Promise<void>;
  onLogout(): Promise<void>;
}) {
  const [allowed, setAllowed] = useState(household.allowNewDeviceRequests);
  const [order, setOrder] = useState<MediaOrder>(household.defaultMediaOrder);
  const [seconds, setSeconds] = useState(household.defaultSlideshowSeconds.toString());
  const [current, setCurrent] = useState(""); const [next, setNext] = useState("");
  const [pending, setPending] = useState(""); const [error, setError] = useState("");
  useEffect(() => { setAllowed(household.allowNewDeviceRequests); setOrder(household.defaultMediaOrder); setSeconds(household.defaultSlideshowSeconds.toString()); }, [household]);
  const save = async (event: FormEvent) => { event.preventDefault(); setPending("defaults"); setError(""); try { await onSave({ allowNewDeviceRequests: allowed, defaultMediaOrder: order, defaultSlideshowSeconds: Number(seconds) }); } catch (cause) { setError(safeFailure(cause, "Settings could not be saved.")); } finally { setPending(""); } };
  const rotate = async (event: FormEvent) => { event.preventDefault(); if (current.length < 16 || next.length < 16) { setError("Both passphrases must be at least 16 characters."); return; } setPending("passphrase"); setError(""); try { await onRotate(current, next); setCurrent(""); setNext(""); } catch (cause) { setError(safeFailure(cause, "Passphrase could not be changed.")); } finally { setPending(""); } };
  const counts = {
    devices: snapshot.devices.filter(device => device.revokedAt === null).length,
    sources: snapshot.sources.filter(source => source.status === "healthy").length,
    roots: snapshot.roots.filter(root => root.enabled).length,
    requests: snapshot.pendingRequests.length
  };
  return <section className="flex flex-col gap-5"><PageHeader context="Household" title="Settings" description="Set enrollment and playback defaults, review current control-plane truth, and protect admin access." />
    {error && <Alert variant="destructive"><AlertTriangleIcon /><AlertDescription>{error}</AlertDescription></Alert>}
    <div className="settings-grid"><form className="settings-card" onSubmit={save}><CardHeader><CardTitle>Household defaults</CardTitle><CardDescription>Enrollment and playback choices inherited by televisions.</CardDescription></CardHeader><CardContent className="grid gap-4"><div className="toggle-row"><span><label htmlFor="allow-device-requests"><strong>Allow new device requests</strong></label><small id="allow-device-requests-help">Unapproved televisions can request access for 30 minutes.</small></span><input id="allow-device-requests" aria-describedby="allow-device-requests-help" type="checkbox" checked={allowed} onChange={event => setAllowed(event.target.checked)} /></div><label className="field">Default ordering<select value={order} onChange={event => setOrder(event.target.value as MediaOrder)}><option value="captured-desc">Newest captured first</option><option value="captured-asc">Oldest captured first</option><option value="name-asc">Name A–Z</option></select></label><label className="field">Default slideshow seconds<input type="number" min="1" max="3600" value={seconds} onChange={event => setSeconds(event.target.value)} /></label></CardContent><CardFooter><Button disabled={pending === "defaults"}>{pending === "defaults" ? "Saving…" : "Save defaults"}</Button></CardFooter></form>
      <Card className="control-truth-ledger"><CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheckIcon className="size-4" />Current household status</CardTitle><CardDescription>Browser-safe access truth from the active service.</CardDescription></CardHeader><CardContent><div className="metric-grid"><Truth icon={<MonitorIcon />} value={counts.devices} label="Approved devices" /><Truth icon={<CloudIcon />} value={counts.sources} label="Connected sources" /><Truth icon={<FolderOpenIcon />} value={counts.roots} label="Approved roots" /><Truth icon={<TimerIcon />} value={counts.requests} label="Pending requests" /></div><div className="recovery-ledger" data-recovery-status={snapshot.recoveryCopy.status}><strong>Recovery copy</strong><p>{snapshot.recoveryCopy.status === "delayed" ? "Recovery copy delayed; active service remains on Vercel" : "Recovery copy current."}</p></div></CardContent></Card>
      <form className="settings-card border-destructive/30" onSubmit={rotate}><CardHeader><CardTitle className="flex items-center gap-2 text-destructive"><ShieldCheckIcon className="size-4" />Change passphrase</CardTitle><CardDescription>Changing it signs out every admin session, including this one.</CardDescription></CardHeader><CardContent className="grid gap-4"><label className="field">Current passphrase<input type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} /></label><label className="field">New passphrase<input type="password" autoComplete="new-password" value={next} onChange={event => setNext(event.target.value)} /></label></CardContent><CardFooter><Button variant="destructive" disabled={pending === "passphrase"}>{pending === "passphrase" ? "Changing…" : "Change passphrase"}</Button></CardFooter></form>
      <Card><CardHeader><CardTitle>Admin session</CardTitle><CardDescription>Sign out of this browser without affecting approved televisions.</CardDescription></CardHeader><CardFooter><Button variant="outline" onClick={() => void onLogout()}><LogOutIcon data-icon="inline-start" />Sign out</Button></CardFooter></Card>
    </div>
  </section>;
}
function Truth({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) { return <div><span aria-hidden="true">{icon}</span><strong>{value}</strong><span>{label}</span></div>; }
function safeFailure(cause: unknown, fallback: string) { return cause instanceof Error && cause.name === "AdminApiError" ? cause.message : fallback; }
