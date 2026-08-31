import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { AlertDialog as AstryxAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { VStack } from "@astryxdesign/core/VStack";
import type { AdminSnapshotResponse, ClaimInstallationBody, ControlDeviceDto, ControlRequestDto, UpdateDeviceBody } from "@cloudframe/shared";
import type { AdminApi } from "./api/client";
import { AdminApiError } from "./api/client";
import { ApprovalSheet } from "./components/approval-sheet";
import { AdminOverview } from "./components/admin-overview";
import { Devices } from "./components/devices";
import { HouseholdProgram, type ProgramRoot } from "./components/household-program";
import { FirstRun } from "./components/first-run";
import { Login } from "./components/login";
import { Requests } from "./components/requests";
import { Settings } from "./components/settings";
import { Shell, type AdminSection } from "./components/shell";
import { Sources, type SourceWorkbenchState } from "./components/sources";
import type { RootRemovalRequest } from "./components/source-workbench";
import { RefreshCwIcon } from "lucide-react";

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
  const [deny, setDeny] = useState<ControlRequestDto | null>(null);
  const [denyOpen, setDenyOpen] = useState(false);
  const [revoke, setRevoke] = useState<ControlDeviceDto | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokePending, setRevokePending] = useState(false);
  const [sourceWorkbench, setSourceWorkbench] = useState<SourceWorkbenchState | null>(null);
  const [rootRemovalRequest, setRootRemovalRequest] = useState<RootRemovalRequest | null>(null);
  const bootstrapped = useRef(false);
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);
  const denialOpener = useRef<HTMLElement | null>(null);
  const revokeOpener = useRef<HTMLElement | null>(null);
  const denialFocusPending = useRef(false);
  const revokeFocusPending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (initial.hadTransientQuery) window.history.replaceState(window.history.state, "", "/admin/");
    return () => { mounted.current = false; };
  }, []);

  const unauthenticate = useCallback((clearNotice = true) => {
    refreshGeneration.current += 1;
    if (!mounted.current) return;
    setAuthenticated(false); setSnapshot(null); setApproval(null); setDeny(null); setDenyOpen(false); setRevoke(null); setRevokeOpen(false); setSourceWorkbench(null); setRootRemovalRequest(null); setError("");
    if (clearNotice) setNotice("");
  }, []);
  const handleSourceUnauthorized = useCallback(() => unauthenticate(false), [unauthenticate]);
  const handleSourceWorkbenchChange = useCallback((value: SourceWorkbenchState | null) => {
    setSourceWorkbench(current => sameWorkbench(current, value) ? current : value);
    if (!value) setRootRemovalRequest(current => current === null ? current : null);
  }, []);
  const openSourceWorkbench = useCallback((value: SourceWorkbenchState) => {
    setSourceWorkbench(value);
    setRootRemovalRequest(null);
  }, []);
  const closeSourceWorkbench = useCallback(() => {
    setSourceWorkbench(null);
    setRootRemovalRequest(null);
  }, []);
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
    setError("");
    try {
      const result = await guard(() => api.authorizeSource(provider, reconnect));
      await refresh();
      navigate(result.authorizationUrl);
    } catch (cause) {
      if (mounted.current && !isStatus(cause, 401)) setError(messageFor(cause));
    }
  };
  useEffect(() => {
    if (denyOpen || !deny || denying !== null) return;
    const timer = window.setTimeout(() => {
      denialFocusPending.current = true;
      setDeny(null);
      window.setTimeout(() => {
        if (!denialFocusPending.current) return;
        denialFocusPending.current = false;
        if (denialOpener.current?.isConnected) denialOpener.current.focus();
        else document.getElementById("astryx-app-shell-main")?.focus();
      }, 0);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [denyOpen, deny, denying]);

  useEffect(() => {
    if (revokeOpen || !revoke || revokePending) return;
    const timer = window.setTimeout(() => {
      revokeFocusPending.current = true;
      setRevoke(null);
      window.setTimeout(() => {
        if (!revokeFocusPending.current) return;
        revokeFocusPending.current = false;
        if (revokeOpener.current?.isConnected) revokeOpener.current.focus();
        else document.getElementById("astryx-app-shell-main")?.focus();
      }, 0);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [revokeOpen, revoke, revokePending]);

  useEffect(() => {
    if (deny !== null || !denialFocusPending.current) return;
    denialFocusPending.current = false;
    if (denialOpener.current?.isConnected) denialOpener.current.focus();
    else document.getElementById("astryx-app-shell-main")?.focus();
  }, [deny]);

  useEffect(() => {
    if (revoke !== null || !revokeFocusPending.current) return;
    revokeFocusPending.current = false;
    if (revokeOpener.current?.isConnected) revokeOpener.current.focus();
    else document.getElementById("astryx-app-shell-main")?.focus();
  }, [revoke]);

  useEffect(() => {
    if (revokeOpen || revoke !== null || revokePending) return;
    document.getElementById("astryx-app-shell-main")?.focus();
  }, [revokeOpen, revoke, revokePending, snapshot?.devices.length]);

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

  if (checkingSession) return <Center minHeight="100dvh" padding={4} aria-live="polite"><Spinner size="xl" label="Opening household admin…" /></Center>;
  if (installationState === "unconfigured") return <FirstRun onClaim={claimInstallation} />;
  if (installationState === "error") return <Center minHeight="100dvh" padding={4}><Card maxWidth="40rem" width="100%"><Banner status="error" title="Installation status unavailable" description={error || "Cloudframe could not read local installation state."} container="section" /></Card></Center>;
  if (!authenticated) return <Login onLogin={login} />;
  if (!snapshot) return <Center minHeight="100dvh" padding={4}><Card maxWidth="40rem" width="100%"><VStack gap={4}><Banner status="error" title="Household data unavailable" description={error || "Cloudframe could not load the household data."} container="section" /><AstryxButton label="Try again" variant="secondary" onClick={() => void refresh().catch(() => undefined)} /></VStack></Card></Center>;
  return <Shell section={section} onSection={value => { setSection(value); setNotice(""); setSourceWorkbench(null); setRootRemovalRequest(null); }} pendingCount={snapshot.pendingRequests.length} onRefresh={() => void refresh().catch(() => undefined)} refreshing={loading} contentMode={section === "sources" ? "sources" : "standard"} endTestId={sourceWorkbench ? "household-program-plane" : undefined} end={sourceWorkbench ? <HouseholdProgram source={sourceWorkbench.source} roots={sourceWorkbench.roots} devices={sourceWorkbench.devices} onRemove={(root: ProgramRoot) => setRootRemovalRequest(current => ({ root, generation: (current?.generation ?? 0) + 1 }))} /> : undefined}>
      <VStack gap={6}>
        <AdminOverview snapshot={snapshot} compact={section === "sources"} />
        {loading && <VisuallyHidden as="p" role="status">Refreshing household data…</VisuallyHidden>}
        {notice && <Banner status="success" title="Completed" description={notice} container="section" />}
        {recoveryWarning && <Banner status="warning" title="Household refresh needed" description={recoveryWarning} container="section" />}
        {error && <Banner status="error" title="Action could not be completed" description={error} container="section" endContent={<AstryxButton label="Try again" variant="secondary" icon={<Icon icon={RefreshCwIcon} />} onClick={() => void refresh().catch(() => undefined)} />} />}
        {section === "requests" && <Requests requests={snapshot.pendingRequests} roots={snapshot.roots} sources={snapshot.sources} disabled={!snapshot.household.allowNewDeviceRequests} pendingId={denying} onApprove={setApproval} onDeny={request => { denialOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setDeny(request); setDenyOpen(true); }} />}
        {section === "devices" && <Devices devices={snapshot.devices.filter(device => !device.revokedAt)} roots={snapshot.roots} onUpdate={(id, body: UpdateDeviceBody) => mutate(() => api.updateDevice(id, body), "Device updated.", result => setSnapshot(current => current ? { ...current, devices: current.devices.map(item => item.id === id ? result.device : item) } : current)).then(() => undefined)} onRevoke={device => { revokeOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRevoke(device); setRevokeOpen(true); }} />}
        {section === "sources" && <Sources sources={snapshot.sources} roots={snapshot.roots} devices={snapshot.devices} api={api} onRootAdded={async root => { setSnapshot(current => current ? { ...current, roots: [...current.roots.filter(item => item.id !== root.id), root] } : current); setRecoveryWarning(""); startCommittedRefresh(); return true; }} onRootRemoved={async rootId => { setSnapshot(current => current ? { ...current, roots: current.roots.filter(item => item.id !== rootId), devices: current.devices.map(device => ({ ...device, assignedRootIds: device.assignedRootIds.filter(id => id !== rootId) })) } : current); setRecoveryWarning(""); startCommittedRefresh(); return true; }} onRemoveSource={sourceId => mutate(() => api.removeSource(sourceId), "Source removed. Television access was removed immediately.", result => { const removedRootIds = new Set(result.roots.map(root => root.id)); setSnapshot(current => current ? { ...current, sources: current.sources.filter(item => item.id !== sourceId), roots: current.roots.filter(root => root.sourceId !== sourceId), devices: current.devices.map(device => ({ ...device, assignedRootIds: device.assignedRootIds.filter(id => !removedRootIds.has(id)) })) } : current); }).then(() => undefined)} onAuthorize={authorize} onUnauthorized={handleSourceUnauthorized} onWorkbenchOpen={openSourceWorkbench} onWorkbenchClose={closeSourceWorkbench} onWorkbenchChange={handleSourceWorkbenchChange} workbenchRemovalRequest={rootRemovalRequest} />}
        {section === "settings" && <Settings api={api} household={snapshot.household} snapshot={snapshot} onUnauthorized={unauthenticate} onSave={value => mutate(() => api.updateSettings(value), "Household defaults saved.", () => setSnapshot(current => current ? { ...current, household: { ...current.household, ...value } } : current)).then(() => undefined)} onRotate={async (current, next) => { await guard(() => api.rotatePassphrase(current, next)); unauthenticate(); }} onLogout={async () => { await guard(() => api.logout()); unauthenticate(); }} />}
      </VStack>
      {approval && <ApprovalSheet request={approval} roots={snapshot.roots} sources={snapshot.sources} onClose={() => setApproval(null)} onApprove={async body => { const requestId = approval.id; await mutate(() => api.approveRequest(requestId, body), `${body.name} was approved.`, result => setSnapshot(current => current ? { ...current, pendingRequests: current.pendingRequests.filter(item => item.id !== requestId), devices: [...current.devices.filter(item => item.id !== result.device.id), result.device] } : current)); }} />}
      {deny && <AstryxAlertDialog
        isOpen={denyOpen}
        onOpenChange={open => { if (!open && denying === null) setDenyOpen(false); }}
        title="Deny device request"
        description={`${deny.requestedName} will need to request household access again.`}
        actionLabel={`Deny ${deny.requestedName}`}
        isActionLoading={denying === deny.id}
        onAction={() => {
          if (denying !== null) return;
          const request = deny;
          setDenying(request.id);
          setError("");
          void mutate(() => api.denyRequest(request.id), `${request.requestedName} was denied.`, () => setSnapshot(current => current ? { ...current, pendingRequests: current.pendingRequests.filter(item => item.id !== request.id) } : current))
            .then(() => setDenyOpen(false))
            .catch(cause => setError(messageFor(cause)))
            .finally(() => { if (mounted.current) setDenying(null); });
        }}
      />}
      {revoke && <AstryxAlertDialog
        isOpen={revokeOpen}
        onOpenChange={open => { if (!open && !revokePending) setRevokeOpen(false); }}
        title="Revoke device"
        description={`${revoke.name} will be signed out and lose access on its next request. This cannot be undone; the television must request access again.`}
        actionLabel="Revoke permanently"
        isActionLoading={revokePending}
        onAction={() => {
          if (revokePending) return;
          const revoked = revoke;
          setRevokePending(true);
          void mutate(() => api.revokeDevice(revoked.id), `${revoked.name} was revoked.`, () => setSnapshot(current => current ? { ...current, devices: current.devices.filter(item => item.id !== revoked.id) } : current))
            .then(() => setRevokeOpen(false))
            .catch(cause => setError(messageFor(cause)))
            .finally(() => { if (mounted.current) setRevokePending(false); });
        }}
      />}
    </Shell>;
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
function isStale(value: unknown) { return Boolean(value && typeof value === "object" && "code" in value && ["DEVICE_STALE", "DEVICE_NOT_FOUND", "DEVICE_REQUEST_NOT_FOUND", "DEVICE_REQUEST_EXPIRED", "DEVICE_REQUEST_RESOLVED", "INVALID_ROOT_ASSIGNMENT", "SOURCE_NOT_FOUND", "ROOT_NOT_FOUND"].includes(String((value as { code: unknown }).code))); }
function messageFor(value: unknown) { return value instanceof AdminApiError ? value.message : "The request could not be completed."; }
function sameWorkbench(current: SourceWorkbenchState | null, next: SourceWorkbenchState | null) {
  if (current === next) return true;
  if (!current || !next || current.source.id !== next.source.id || current.devices !== next.devices || current.roots.length !== next.roots.length) return false;
  return current.roots.every((root, index) => {
    const candidate = next.roots[index];
    return candidate?.id === root.id && candidate.enabled === root.enabled && candidate.displayName === root.displayName && candidate.providerNodeId === root.providerNodeId;
  });
}
const COMMITTED_REFRESH_WARNING = "Change saved, but household data could not be refreshed. Refresh to confirm the latest state.";
