import { type FormEvent, useState } from "react";
import type { AdminOverviewResponse, AdminSettingsResponse, MediaOrder, UpdateAdminSettingsBody } from "@cloudframe/shared";
import { PageHeader } from "./requests";

export function Settings({ value, overview, onSave, onRotate, onLogout }: {
  value: AdminSettingsResponse;
  overview: AdminOverviewResponse;
  onSave(value: UpdateAdminSettingsBody): Promise<void>;
  onRotate(current: string, next: string): Promise<void>;
  onLogout(): Promise<void>;
}) {
  const indexHealth = value.indexHealth ?? { totalNodeCount: 0, availableNodeCount: 0, indexingSourceCount: 0, estimatedFirestoreDocumentCount: 0 };
  const [allowed, setAllowed] = useState(value.allowNewDeviceRequests);
  const [order, setOrder] = useState<MediaOrder>(value.defaultMediaOrder);
  const [seconds, setSeconds] = useState(value.defaultSlideshowSeconds.toString());
  const [current, setCurrent] = useState(""); const [next, setNext] = useState("");
  const [pending, setPending] = useState(""); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const save = async (event: FormEvent) => { event.preventDefault(); setPending("defaults"); setError(""); try { await onSave({ allowNewDeviceRequests: allowed, defaultMediaOrder: order, defaultSlideshowSeconds: Number(seconds) }); setMessage("Household defaults saved."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Settings could not be saved."); } finally { setPending(""); } };
  const rotate = async (event: FormEvent) => { event.preventDefault(); if (current.length < 16 || next.length < 16) { setError("Both passphrases must be at least 16 characters."); return; } setPending("passphrase"); setError(""); try { await onRotate(current, next); setCurrent(""); setNext(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "Passphrase could not be changed."); } finally { setPending(""); } };
  const sourceErrors = overview.sources.filter(source => source.lastSyncErrorCode || ["error", "reauth-required"].includes(source.status));
  return <section><PageHeader eyebrow="Household" title="Settings" description="Set enrollment and playback defaults, review service health, and protect admin access." />
    {message && <p className="notice success" role="status">{message}</p>}{error && <p className="error-banner" role="alert">{error}</p>}
    <div className="settings-grid"><form className="settings-card" onSubmit={save}><h2>Household defaults</h2><div className="toggle-row"><span><label htmlFor="allow-device-requests"><strong>Allow new device requests</strong></label><small id="allow-device-requests-help">Unapproved televisions can request access for 30 minutes.</small></span><input id="allow-device-requests" aria-describedby="allow-device-requests-help" type="checkbox" checked={allowed} onChange={event => setAllowed(event.target.checked)} /></div><label className="field">Default ordering<select value={order} onChange={event => setOrder(event.target.value as MediaOrder)}><option value="captured-desc">Newest captured first</option><option value="captured-asc">Oldest captured first</option><option value="name-asc">Name A–Z</option></select></label><label className="field">Default slideshow seconds<input type="number" min="1" max="3600" value={seconds} onChange={event => setSeconds(event.target.value)} /></label><button className="button primary" disabled={pending === "defaults"}>{pending === "defaults" ? "Saving…" : "Save defaults"}</button></form>
      <article className="settings-card"><h2>Library health</h2><div className="metric-grid"><div><strong>{indexHealth.totalNodeCount}</strong><span>Indexed nodes</span></div><div><strong>{indexHealth.availableNodeCount}</strong><span>Available nodes</span></div><div><strong>{indexHealth.indexingSourceCount}</strong><span>Indexing sources</span></div><div><strong>{sourceErrors.length}</strong><span>Errors</span></div></div>{sourceErrors.length ? <ul className="health-errors">{sourceErrors.map(source => <li key={source.id}>{source.accountLabel}: {source.lastSyncErrorCode ?? source.status}</li>)}</ul> : <p className="healthy-copy">All connected sources are reporting normally.</p>}<p className="estimate"><strong>{indexHealth.estimatedFirestoreDocumentCount}</strong> Estimated Firestore documents. Billing dashboards remain authoritative.</p></article>
      <article className="settings-card cadence"><h2>Sync cadence</h2><span className="status pending">Daily deployment schedule</span><p>This development deployment uses a daily scheduled sync on Vercel Hobby. Use Sync now after important cloud changes; higher tiers can run more frequently.</p></article>
      <form className="settings-card" onSubmit={rotate}><h2>Change passphrase</h2><p>Changing it signs out every admin session, including this one.</p><label className="field">Current passphrase<input type="password" autoComplete="off" value={current} onChange={event => setCurrent(event.target.value)} /></label><label className="field">New passphrase<input type="password" autoComplete="off" value={next} onChange={event => setNext(event.target.value)} /></label><button className="button danger" disabled={pending === "passphrase"}>{pending === "passphrase" ? "Changing…" : "Change passphrase"}</button></form>
    </div><div className="signout-row"><div><h2>Admin session</h2><p>Sign out of this browser without affecting approved televisions.</p></div><button className="button secondary" onClick={() => void onLogout()}>Sign out</button></div>
  </section>;
}
