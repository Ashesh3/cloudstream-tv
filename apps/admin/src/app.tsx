import { useEffect, useRef, useState } from "react";
import type { AdminOverviewResponse, AdminSettingsResponse, DeviceDto, DeviceRequestDto, SourceDto, UpdateDeviceBody } from "@cloudframe/shared";
import type { AdminApi, AdminSource } from "./api/client";
import { AdminApiError } from "./api/client";
import { ApprovalSheet } from "./components/approval-sheet";
import { Devices } from "./components/devices";
import { Dialog } from "./components/dialog";
import { Login } from "./components/login";
import { Requests } from "./components/requests";
import { Settings } from "./components/settings";
import { Shell, type AdminSection } from "./components/shell";
import { Sources } from "./components/sources";

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

  if (checkingSession) return <main className="center-state" aria-live="polite"><p>Checking admin session…</p></main>;
  if (!authenticated) return <Login onLogin={login} />;
  if (!overview) return <main className="center-state">{loading ? <p>Loading household admin…</p> : <><p className="error-banner">{error || "The household overview is unavailable."}</p><button className="button primary" onClick={() => void refresh()}>Try again</button></>}</main>;
  const sourceDtos: SourceDto[] = overview.sources;
  return <Shell section={section} onSection={value => { setSection(value); setNotice(""); }} pendingCount={overview.pendingRequests.length}>
    <div className="content-width"><div className="topbar"><span className="household-dot" /> <strong>Private household</strong><button className="refresh-button" onClick={() => void refresh()} disabled={loading}>Refresh</button></div>
      {notice && <p className="notice success" role="status">{notice}</p>}{error && <div className="error-banner" role="alert">{error}<button className="button secondary" onClick={() => void refresh()}>Try again</button></div>}
      {section === "requests" && <Requests requests={overview.pendingRequests} roots={overview.roots} sources={sourceDtos} disabled={!overview.household.allowNewDeviceRequests} pendingId={denying} onApprove={setApproval} onDeny={request => { setDenying(request.id); setError(""); void guard(() => api.denyRequest(request.id)).then(() => { setOverview(value => value ? { ...value, pendingRequests: value.pendingRequests.filter(item => item.id !== request.id) } : value); setNotice(`${request.requestedName} was denied.`); }).catch(cause => setError(messageFor(cause))).finally(() => setDenying(null)); }} />}
      {section === "devices" && <Devices devices={overview.devices.filter(device => !device.revokedAt)} roots={overview.roots} onUpdate={(id, body: UpdateDeviceBody) => mutate(() => api.updateDevice(id, body), "Device updated.")} onRevoke={setRevoke} />}
      {section === "sources" && <Sources sources={sources} allRoots={overview.roots} api={api} onRefresh={refresh} onAuthorize={authorize} />}
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
    {revoke && <Dialog label="Revoke device" onClose={() => setRevoke(null)}><header className="dialog-header"><div><p className="eyebrow">Permanent action</p><h2>Revoke device</h2></div><button className="icon-button" onClick={() => setRevoke(null)} aria-label="Close">×</button></header><div className="dialog-scroll"><p><strong>{revoke.name}</strong> will be signed out and lose access immediately on its next request.</p><p>This cannot be undone. The television must submit a new request to return.</p></div><footer className="dialog-actions"><button className="button secondary" onClick={() => setRevoke(null)}>Cancel</button><button data-autofocus className="button danger" disabled={revokePending} onClick={() => { setRevokePending(true); void mutate(() => api.revokeDevice(revoke.id), `${revoke.name} was revoked.`).then(() => setRevoke(null)).catch(cause => setError(messageFor(cause))).finally(() => setRevokePending(false)); }}>{revokePending ? "Revoking…" : "Revoke permanently"}</button></footer></Dialog>}
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
function isStale(value: unknown) { return Boolean(value && typeof value === "object" && "code" in value && ["DEVICE_STALE", "DEVICE_NOT_FOUND", "DEVICE_REQUEST_RESOLVED", "SOURCE_NOT_FOUND", "ROOT_NOT_FOUND"].includes(String((value as { code: unknown }).code))); }
function messageFor(value: unknown) { if (value instanceof TypeError) return "Cloudframe could not reach the server."; if (value instanceof Error) return value.message; return "The request could not be completed."; }
function householdSettings(value: AdminSettingsResponse) { return { allowNewDeviceRequests: value.allowNewDeviceRequests, defaultMediaOrder: value.defaultMediaOrder, defaultSlideshowSeconds: value.defaultSlideshowSeconds }; }
