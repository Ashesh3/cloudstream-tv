import { useEffect, useRef, useState } from "react";
import type { AdminOverviewResponse, AdminSettingsResponse, DeviceDto, DeviceRequestDto, SourceDto, UpdateDeviceBody } from "@cloudframe/shared";
import type { AdminApi, AdminSource } from "./api/client";
import { AdminApiError } from "./api/client";
import { ApprovalSheet } from "./components/approval-sheet";
import { Devices } from "./components/devices";
import { Login } from "./components/login";
import { Requests } from "./components/requests";
import { Settings } from "./components/settings";
import { Shell, type AdminSection } from "./components/shell";
import { Sources } from "./components/sources";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircleIcon, CheckCircle2Icon, CloudIcon, FolderOpenIcon, MonitorIcon, RefreshCwIcon, ShieldCheckIcon, UserRoundPlusIcon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Trash2Icon } from "lucide-react";

const EMPTY_SETTINGS: AdminSettingsResponse = { allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8, indexHealth: { totalNodeCount: 0, availableNodeCount: 0, indexingSourceCount: 0, estimatedFirestoreDocumentCount: 0 } };

export function AdminApp({ api, navigate = url => window.location.assign(url), checkSession = true }: { api: AdminApi; navigate?(url: string): void; checkSession?: boolean }) {
  const initial = initialNavigation();
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(checkSession);
  const [overview, setOverview] = useState<AdminOverviewResponse | null>(null);
  const [sources, setSources] = useState<AdminSource[]>([]);
  const [settings, setSettings] = useState<AdminSettingsResponse>(EMPTY_SETTINGS);
  const [section, setSection] = useState<AdminSection>(initial.section);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(initial.oauthMessage);
  const [approval, setApproval] = useState<DeviceRequestDto | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<DeviceDto | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (initial.hadTransientQuery) window.history.replaceState(window.history.state, "", "/admin/");
  }, []);

  const unauthenticate = (clearNotice = true) => { setAuthenticated(false); setOverview(null); setSources([]); setSettings(EMPTY_SETTINGS); setApproval(null); setRevoke(null); setError(""); if (clearNotice) setNotice(""); };
  const guard = async <T,>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (cause) {
      if (cause instanceof AdminApiError && cause.status === 401 || isStatus(cause, 401)) unauthenticate(false);
      throw cause;
    }
  };
  const refresh = async () => {
    setLoading(true); setError("");
    try {
      const [nextOverview, nextSettings, nextSources] = await guard(() => Promise.all([api.overview(), api.settings(), api.sources()]));
      setOverview(nextOverview); setSettings(nextSettings); setSources(nextSources.sources); setAuthenticated(true);
    } catch (cause) {
      if (!isStatus(cause, 401)) setError(messageFor(cause));
    } finally { setLoading(false); }
  };
  const login = async (passphrase: string) => { await api.login(passphrase); setAuthenticated(true); await refresh(); };
  const mutate = async (operation: () => Promise<unknown>, success: string, refreshAfter = true) => {
    try { await guard(operation); if (refreshAfter) await refresh(); setNotice(success); }
    catch (cause) { if (isStale(cause)) await refresh(); throw cause; }
  };
  const authorize = async (provider: "google" | "onedrive", reconnect?: string) => { const result = await guard(() => api.authorizeSource(provider, reconnect)); navigate(result.authorizationUrl); };

  useEffect(() => {
    if (!checkSession) return;
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void refresh().finally(() => setCheckingSession(false));
  }, [checkSession]);

  if (checkingSession) return <main className="grid min-h-screen place-items-center bg-muted/30 p-6" aria-live="polite"><Card className="w-full max-w-md"><CardContent className="flex flex-col gap-3 py-6"><Skeleton className="h-5 w-32" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></CardContent></Card></main>;
  if (!authenticated) return <Login onLogin={login} />;
  if (!overview) return <main className="grid min-h-screen place-items-center bg-muted/30 p-6"><Alert variant="destructive" className="max-w-lg"><AlertCircleIcon /><AlertTitle>Household overview unavailable</AlertTitle><AlertDescription>{error || "Cloudframe could not load the household overview."}</AlertDescription><AlertAction><Button variant="outline" onClick={() => void refresh()}>Try again</Button></AlertAction></Alert></main>;
  const sourceDtos: SourceDto[] = overview.sources;
  return <TooltipProvider><Shell section={section} onSection={value => { setSection(value); setNotice(""); }} pendingCount={overview.pendingRequests.length} onRefresh={() => void refresh()} refreshing={loading}>
    <div className="flex flex-col gap-5">
      <section aria-labelledby="household-overview-title" className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="mb-2 text-xs font-semibold uppercase tracking-[.16em] text-primary">Operations</p><h1 id="household-overview-title" className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Household overview</h1><p className="mt-2 text-sm text-muted-foreground">At-a-glance access, device, and library status.</p></div><div className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheckIcon className="size-4 text-emerald-600" />Private and server-managed</div></div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Pending requests" value={overview.pendingRequests.length} icon={<UserRoundPlusIcon />} emphasized={overview.pendingRequests.length > 0} /><Metric label="Approved devices" value={overview.devices.filter(device => !device.revokedAt).length} icon={<MonitorIcon />} /><Metric label="Cloud sources" value={overview.sources.length} icon={<CloudIcon />} /><Metric label="Available folders" value={overview.roots.filter(root => root.enabled).length} icon={<FolderOpenIcon />} /></div>
      </section>
      {notice && <Alert className="border-emerald-200 bg-emerald-50 text-emerald-950" role="status"><CheckCircle2Icon /><AlertTitle>Completed</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
      {error && <Alert variant="destructive"><AlertCircleIcon /><AlertTitle>Action could not be completed</AlertTitle><AlertDescription>{error}</AlertDescription><AlertAction><Button variant="outline" onClick={() => void refresh()}><RefreshCwIcon data-icon="inline-start" />Try again</Button></AlertAction></Alert>}
      {section === "requests" && <Requests requests={overview.pendingRequests} roots={overview.roots} sources={sourceDtos} disabled={!overview.household.allowNewDeviceRequests} pendingId={denying} onApprove={setApproval} onDeny={request => { setDenying(request.id); setError(""); void guard(() => api.denyRequest(request.id)).then(() => { setOverview(value => value ? { ...value, pendingRequests: value.pendingRequests.filter(item => item.id !== request.id) } : value); setNotice(`${request.requestedName} was denied.`); }).catch(cause => setError(messageFor(cause))).finally(() => setDenying(null)); }} />}
      {section === "devices" && <Devices devices={overview.devices.filter(device => !device.revokedAt)} roots={overview.roots} onUpdate={(id, body: UpdateDeviceBody) => mutate(() => api.updateDevice(id, body), "Device updated.")} onRevoke={setRevoke} />}
      {section === "sources" && <Sources sources={sources} allRoots={overview.roots} devices={overview.devices} api={api} onRefresh={refresh} onAuthorize={authorize} />}
      {section === "settings" && <Settings value={settings} overview={overview} onSave={async value => { const result = await guard(() => api.updateSettings(value)); setSettings(current => ({ ...current, ...result, indexHealth: result.indexHealth ?? current.indexHealth })); setOverview(current => current ? { ...current, household: { ...current.household, ...householdSettings(result) } } : current); }} onRotate={async (current, next) => { await guard(() => api.rotatePassphrase(current, next)); unauthenticate(); }} onLogout={async () => { await guard(() => api.logout()); unauthenticate(); }} />}
    </div>
    {approval && <ApprovalSheet request={approval} roots={overview.roots} sources={sourceDtos} onClose={() => setApproval(null)} onApprove={async body => {
      const approvedRequestId = approval.id;
      const result = await guard(() => api.approveRequest(approvedRequestId, body));
      setOverview(value => value ? {
        ...value,
        pendingRequests: value.pendingRequests.filter(item => item.id !== approvedRequestId),
        devices: [...value.devices.filter(item => item.id !== result.device.id), result.device]
      } : value);
      setNotice(`${body.name} was approved.`);
      setApproval(null);
    }} />}
    {revoke && <AlertDialog open onOpenChange={open => { if (!open && !revokePending) setRevoke(null); }}><AlertDialogContent aria-label="Revoke device"><AlertDialogHeader><div className="flex items-center gap-2"><Trash2Icon className="size-5 text-destructive" /><AlertDialogTitle>Revoke device</AlertDialogTitle></div><AlertDialogDescription><strong className="text-foreground">{revoke.name}</strong> will be signed out and lose access on its next request. This cannot be undone; the television must request access again.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={revokePending}>Cancel</AlertDialogCancel><AlertDialogAction disabled={revokePending} onClick={event => { event.preventDefault(); setRevokePending(true); void mutate(() => api.revokeDevice(revoke.id), `${revoke.name} was revoked.`).then(() => setRevoke(null)).catch(cause => setError(messageFor(cause))).finally(() => setRevokePending(false)); }}>{revokePending ? "Revoking…" : "Revoke permanently"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}
  </Shell></TooltipProvider>;
}

function Metric({ label, value, icon, emphasized = false }: { label: string; value: number; icon: React.ReactNode; emphasized?: boolean }) {
  return <Card className={emphasized ? "ring-primary/30 bg-primary/[.035]" : undefined}><CardContent className="flex items-center justify-between py-1"><div><p className="text-sm text-muted-foreground">{label}</p><p className="mt-1 text-3xl font-semibold tabular-nums">{value}</p></div><span className={`flex size-10 items-center justify-center rounded-xl ${emphasized ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>{icon}</span></CardContent></Card>;
}

function initialNavigation() {
  const url = new URL(window.location.href);
  const rawSection = url.searchParams.get("section");
  const section: AdminSection = ["requests", "devices", "sources", "settings"].includes(rawSection ?? "") ? rawSection as AdminSection : "requests";
  const oauth = url.searchParams.get("oauth");
  const messages: Record<string, string> = { connected: "Cloud source connected successfully.", cancelled: "Connection was cancelled. No source was changed.", failed: "The cloud source could not be connected. Try again.", invalid: "The connection response was invalid. Start again." };
  return { section, oauthMessage: oauth ? messages[oauth] ?? "" : "", hadTransientQuery: url.search.length > 0 };
}
function isStatus(value: unknown, status: number): value is { status: number } { return Boolean(value && typeof value === "object" && "status" in value && (value as { status: unknown }).status === status); }
function isStale(value: unknown) { return Boolean(value && typeof value === "object" && "code" in value && ["DEVICE_STALE", "DEVICE_NOT_FOUND", "DEVICE_REQUEST_RESOLVED", "SOURCE_NOT_FOUND", "ROOT_NOT_FOUND"].includes(String((value as { code: unknown }).code))); }
function messageFor(value: unknown) { if (value instanceof TypeError) return "Cloudframe could not reach the server."; if (value instanceof Error) return value.message; return "The request could not be completed."; }
function householdSettings(value: AdminSettingsResponse) { return { allowNewDeviceRequests: value.allowNewDeviceRequests, defaultMediaOrder: value.defaultMediaOrder, defaultSlideshowSeconds: value.defaultSlideshowSeconds }; }
