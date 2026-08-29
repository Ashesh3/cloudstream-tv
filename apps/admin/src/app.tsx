import { useEffect, useRef, useState } from "react";
import type { AdminSnapshotResponse, ClaimInstallationBody, ControlDeviceDto, ControlRequestDto, UpdateDeviceBody } from "@cloudframe/shared";
import type { AdminApi } from "./api/client";
import { AdminApiError } from "./api/client";
import { ApprovalSheet } from "./components/approval-sheet";
import { Devices } from "./components/devices";
import { FirstRun } from "./components/first-run";
import { Login } from "./components/login";
import { Requests } from "./components/requests";
import { Settings } from "./components/settings";
import { Shell, type AdminSection } from "./components/shell";
import { Sources } from "./components/sources";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircleIcon, AlertTriangleIcon, CheckCircle2Icon, CloudIcon, FolderOpenIcon, MonitorIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DIRECTION_SEED } from "./design/ledger";

export function AdminApp({ api, navigate = url => window.location.assign(url), checkSession = true }: { api: AdminApi; navigate?(url: string): void; checkSession?: boolean }) {
  const initial = initialNavigation();
  const [authenticated, setAuthenticated] = useState(false);
  const [installationState, setInstallationState] = useState<"checking" | "unconfigured" | "configured" | "error">(checkSession ? "checking" : "configured");
  const [checkingSession, setCheckingSession] = useState(checkSession);
  const [snapshot, setSnapshot] = useState<AdminSnapshotResponse | null>(null);
  const [section, setSection] = useState<AdminSection>(initial.section);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [recoveryWarning, setRecoveryWarning] = useState("");
  const [notice, setNotice] = useState(initial.oauthMessage);
  const [approval, setApproval] = useState<ControlRequestDto | null>(null);
  const [denying, setDenying] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ControlDeviceDto | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const bootstrapped = useRef(false);
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    if (initial.hadTransientQuery) window.history.replaceState(window.history.state, "", "/admin/");
    return () => { mounted.current = false; };
  }, []);

  const unauthenticate = (clearNotice = true) => {
    refreshGeneration.current += 1;
    if (!mounted.current) return;
    setAuthenticated(false); setSnapshot(null); setApproval(null); setRevoke(null); setError("");
    if (clearNotice) setNotice("");
  };
  const guard = async <T,>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (cause) {
      if ((cause instanceof AdminApiError && cause.status === 401) || isStatus(cause, 401)) unauthenticate(false);
      throw cause;
    }
  };
  const refresh = async (surfaceError = true) => {
    const generation = ++refreshGeneration.current;
    if (mounted.current) { setLoading(true); setError(""); }
    try {
      const next = await guard(() => api.snapshot());
      if (!mounted.current || generation !== refreshGeneration.current) return;
      setSnapshot(next); setAuthenticated(true); setRecoveryWarning("");
    } catch (cause) {
      if (surfaceError && mounted.current && generation === refreshGeneration.current && !isStatus(cause, 401)) setError(messageFor(cause));
      throw cause;
    } finally {
      if (mounted.current && generation === refreshGeneration.current) setLoading(false);
    }
  };
  const login = async (passphrase: string) => { await api.login(passphrase); if (mounted.current) setAuthenticated(true); await refresh(); };
  const claimInstallation = async (input: ClaimInstallationBody) => {
    await api.claimInstallation(input);
    await api.login(input.passphrase);
    if (mounted.current) {
      setInstallationState("configured");
      setAuthenticated(true);
    }
    await refresh();
  };
  const refreshCommittedChange = async (surfaceWarning = true): Promise<boolean> => {
    try { await refresh(false); }
    catch (cause) {
      if (surfaceWarning && !isStatus(cause, 401) && mounted.current) setRecoveryWarning(COMMITTED_REFRESH_WARNING);
      if (isStatus(cause, 401)) throw cause;
      return false;
    }
    return true;
  };
  const startCommittedRefresh = (surfaceWarning = true) => {
    void refreshCommittedChange(surfaceWarning).catch(() => undefined);
  };
  const mutate = async <T,>(operation: () => Promise<T>, success: string, apply: (result: T) => void): Promise<T> => {
    let result: T;
    try { result = await guard(operation); }
    catch (cause) {
      if (mounted.current && isStale(cause)) await refresh().catch(() => undefined);
      throw cause;
    }
    if (mounted.current) { apply(result); setNotice(success); setError(""); setRecoveryWarning(""); }
    startCommittedRefresh();
    return result;
  };
  const authorize = async (provider: "google" | "onedrive", reconnect?: string) => {
    const result = await guard(() => api.authorizeSource(provider, reconnect));
    await refresh();
    navigate(result.authorizationUrl);
  };

  useEffect(() => {
    if (!checkSession || bootstrapped.current) return;
    bootstrapped.current = true;
    void api.installationStatus().then(async (status) => {
      if (!mounted.current) return;
      setInstallationState(status.state);
      if (status.state === "configured") await refresh();
    }).catch((cause) => {
      if (!mounted.current) return;
      setInstallationState("error");
      setError(messageFor(cause));
    }).finally(() => { if (mounted.current) setCheckingSession(false); });
  }, [checkSession]);

  if (checkingSession) return <main className="login-stage grid min-h-screen place-items-center p-6" aria-live="polite"><div className="ledger-loading w-full max-w-md" data-state="opening-ledger"><Skeleton className="h-5 w-32" /><Skeleton className="mt-3 h-10 w-full" /><Skeleton className="mt-3 h-10 w-full" /></div></main>;
  if (installationState === "unconfigured") return <FirstRun onClaim={claimInstallation} />;
  if (installationState === "error") return <main className="login-stage grid min-h-screen place-items-center p-6"><Alert variant="destructive" className="max-w-lg"><AlertCircleIcon /><AlertTitle>Installation status unavailable</AlertTitle><AlertDescription>{error || "Cloudframe could not read local installation state."}</AlertDescription></Alert></main>;
  if (!authenticated) return <Login onLogin={login} />;
  if (!snapshot) return <main className="login-stage grid min-h-screen place-items-center p-6"><Alert variant="destructive" className="max-w-lg"><AlertCircleIcon /><AlertTitle>Household ledger unavailable</AlertTitle><AlertDescription>{error || "Cloudframe could not load the household ledger."}</AlertDescription><AlertAction><Button variant="outline" onClick={() => void refresh().catch(() => undefined)}>Try again</Button></AlertAction></Alert></main>;
  return <TooltipProvider><div className="admin-root" ref={emitDirectionContract} data-direction-seed={DIRECTION_SEED}>
    <Shell section={section} onSection={value => { setSection(value); setNotice(""); }} pendingCount={snapshot.pendingRequests.length} onRefresh={() => void refresh().catch(() => undefined)} refreshing={loading} contentMode={section === "sources" ? "sources" : "standard"}>
      <div className="flex flex-col gap-7">
        <LedgerOverview snapshot={snapshot} compact={section === "sources"} />
        {loading && <p className="sr-only" role="status">Refreshing household ledger…</p>}
        {notice && <Alert className="notice success" role="status"><CheckCircle2Icon /><AlertTitle>Completed</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
        {recoveryWarning && <Alert className="ledger-warning" role="status"><AlertTriangleIcon /><AlertTitle>Ledger refresh needed</AlertTitle><AlertDescription>{recoveryWarning}</AlertDescription></Alert>}
        {error && <Alert variant="destructive"><AlertCircleIcon /><AlertTitle>Action could not be completed</AlertTitle><AlertDescription>{error}</AlertDescription><AlertAction><Button variant="outline" onClick={() => void refresh().catch(() => undefined)}><RefreshCwIcon data-icon="inline-start" />Try again</Button></AlertAction></Alert>}
        {section === "requests" && <Requests requests={snapshot.pendingRequests} roots={snapshot.roots} sources={snapshot.sources} disabled={!snapshot.household.allowNewDeviceRequests} pendingId={denying} onApprove={setApproval} onDeny={request => { setDenying(request.id); setError(""); void mutate(() => api.denyRequest(request.id), `${request.requestedName} was denied.`, () => setSnapshot(current => current ? { ...current, pendingRequests: current.pendingRequests.filter(item => item.id !== request.id) } : current)).catch(cause => setError(messageFor(cause))).finally(() => { if (mounted.current) setDenying(null); }); }} />}
        {section === "devices" && <Devices devices={snapshot.devices.filter(device => !device.revokedAt)} roots={snapshot.roots} onUpdate={(id, body: UpdateDeviceBody) => mutate(() => api.updateDevice(id, body), "Device updated.", result => setSnapshot(current => current ? { ...current, devices: current.devices.map(item => item.id === id ? result.device : item) } : current)).then(() => undefined)} onRevoke={setRevoke} />}
        {section === "sources" && <Sources sources={snapshot.sources} roots={snapshot.roots} devices={snapshot.devices} api={api} onRootAdded={async root => { setSnapshot(current => current ? { ...current, roots: [...current.roots.filter(item => item.id !== root.id), root] } : current); setRecoveryWarning(""); startCommittedRefresh(); return true; }} onRootRemoved={async rootId => { setSnapshot(current => current ? { ...current, roots: current.roots.filter(item => item.id !== rootId), devices: current.devices.map(device => ({ ...device, assignedRootIds: device.assignedRootIds.filter(id => id !== rootId) })) } : current); setRecoveryWarning(""); startCommittedRefresh(); return true; }} onRemoveSource={sourceId => mutate(() => api.removeSource(sourceId), "Source removed. Television access was removed immediately.", result => { const removedRootIds = new Set(result.roots.map(root => root.id)); setSnapshot(current => current ? { ...current, sources: current.sources.filter(item => item.id !== sourceId), roots: current.roots.filter(root => root.sourceId !== sourceId), devices: current.devices.map(device => ({ ...device, assignedRootIds: device.assignedRootIds.filter(id => !removedRootIds.has(id)) })) } : current); }).then(() => undefined)} onAuthorize={authorize} />}
        {section === "settings" && <Settings api={api} household={snapshot.household} snapshot={snapshot} onUnauthorized={unauthenticate} onSave={value => mutate(() => api.updateSettings(value), "Household defaults saved.", () => setSnapshot(current => current ? { ...current, household: { ...current.household, ...value } } : current)).then(() => undefined)} onRotate={async (current, next) => { await guard(() => api.rotatePassphrase(current, next)); unauthenticate(); }} onLogout={async () => { await guard(() => api.logout()); unauthenticate(); }} />}
      </div>
      {approval && <ApprovalSheet request={approval} roots={snapshot.roots} sources={snapshot.sources} onClose={() => setApproval(null)} onApprove={async body => { const requestId = approval.id; await mutate(() => api.approveRequest(requestId, body), `${body.name} was approved.`, result => setSnapshot(current => current ? { ...current, pendingRequests: current.pendingRequests.filter(item => item.id !== requestId), devices: [...current.devices.filter(item => item.id !== result.device.id), result.device] } : current)); if (mounted.current) setApproval(null); }} />}
      {revoke && <AlertDialog open onOpenChange={open => { if (!open && !revokePending) setRevoke(null); }}><AlertDialogContent aria-label="Revoke device"><AlertDialogHeader><div className="flex items-center gap-2"><Trash2Icon className="size-5 text-destructive" /><AlertDialogTitle>Revoke device</AlertDialogTitle></div><AlertDialogDescription><strong className="text-foreground">{revoke.name}</strong> will be signed out and lose access on its next request. This cannot be undone; the television must request access again.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={revokePending}>Cancel</AlertDialogCancel><AlertDialogAction disabled={revokePending} onClick={event => { event.preventDefault(); const revoked = revoke; setRevokePending(true); void mutate(() => api.revokeDevice(revoked.id), `${revoked.name} was revoked.`, () => setSnapshot(current => current ? { ...current, devices: current.devices.filter(item => item.id !== revoked.id) } : current)).then(() => setRevoke(null)).catch(cause => setError(messageFor(cause))).finally(() => { if (mounted.current) setRevokePending(false); }); }}>{revokePending ? "Revoking…" : "Revoke permanently"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>}
    </Shell>
  </div></TooltipProvider>;
}

function LedgerOverview({ snapshot, compact = false }: { snapshot: AdminSnapshotResponse; compact?: boolean }) {
  const approvedDevices = snapshot.devices.filter(device => device.revokedAt === null);
  const connectedSources = snapshot.sources.filter(source => source.status === "healthy");
  const approvedRoots = snapshot.roots.filter(root => root.enabled);
  return <div className="ledger-overview" aria-label="Household overview">
    <h1 className="sr-only">Household overview</h1>
    <section className="truth-strip" role="region" aria-label="Source health">
      <div className="truth-strip-title"><ShieldCheckIcon aria-hidden="true" /><span>Private household program</span></div>
      {snapshot.sources.length ? <div className="truth-reels">{snapshot.sources.map(source => <div className="truth-reel" key={source.id} data-source-status={source.status}><span className="provider-mark" aria-hidden="true">{source.provider === "google" ? "G" : "1"}</span><div><strong>{source.accountLabel}</strong><span>{source.provider === "google" ? "Google Drive" : "OneDrive"}</span></div><span className="truth-state">{sourceStatus(source.status)}</span></div>)}</div> : <p className="truth-empty">No cloud source connected</p>}
    </section>
    {!compact && <><section className="attention-ledger" role="region" aria-label="Attention">
      <div data-ledger-state="attention"><h2>{snapshot.pendingRequests.length ? `${snapshot.pendingRequests.length} ${snapshot.pendingRequests.length === 1 ? "television" : "televisions"} waiting` : "The booth is quiet"}</h2><p>{snapshot.pendingRequests.length ? "Review each television and write only the approved folders into its program." : "No device requests need review. Current source and access truth remains visible above."}</p></div>
      <div className="attention-cue" aria-hidden="true"><span /><MonitorIcon /><span /></div>
    </section>
    <section className="program-figures" role="region" aria-label="Program figures">
      <Figure icon={<MonitorIcon />} value={`${approvedDevices.length} approved`} label="televisions" />
      <Figure icon={<CloudIcon />} value={`${connectedSources.length} connected`} label="cloud sources" />
      <Figure icon={<FolderOpenIcon />} value={`${approvedRoots.length} approved`} label="program folders" />
    </section>
    <p className="recovery-copy-delayed" role="status">Local encrypted storage</p></>}
  </div>;
}

function Figure({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) { return <div className="program-figure"><span aria-hidden="true">{icon}</span><strong>{value}</strong><small>{label}</small></div>; }
function sourceStatus(status: "healthy" | "reauth-required" | "disabled") { return status === "healthy" ? "Connected" : status === "reauth-required" ? "Reauthorization required" : "Disabled"; }
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
function messageFor(value: unknown) { return value instanceof AdminApiError ? value.message : "The request could not be completed."; }
const COMMITTED_REFRESH_WARNING = "Change saved, but the household ledger could not be refreshed. Refresh to confirm the latest state.";

const DIRECTION_CONTRACT = `
THESIS: Cloud media is programmed like a private screening; refuse generic SaaS dashboard composition.
OWN-WORLD: Projection black, warm program stock, cue orange, hairline seams, ledger type, selective depth.
STORY: Browse the provider live, move folders into the household program, and keep access truth attached.
FIRST VIEWPORT: Source truth above; quiet navigation left; live folder stage two-thirds; household program one-third.
FORM: Screening Room Ledger, grounded direction 4, seed ${DIRECTION_SEED}; stage-to-program cue movement.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review and every shipping raster carrying its provenance
`;
function emitDirectionContract(node: HTMLDivElement | null) { if (!node || node.firstChild?.nodeType === Node.COMMENT_NODE) return; node.insertBefore(document.createComment(DIRECTION_CONTRACT), node.firstChild); }
