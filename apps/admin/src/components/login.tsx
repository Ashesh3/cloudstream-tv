import { type FormEvent, useState } from "react";

export function Login({ onLogin }: { onLogin(passphrase: string): Promise<void> }) {
  const [passphrase, setPassphrase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase) return;
    setPending(true);
    setError("");
    try {
      await onLogin(passphrase);
      setPassphrase("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed.");
    } finally {
      setPending(false);
    }
  };
  return <main className="login-page">
    <section className="login-card">
      <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      <p className="eyebrow">Cloudframe</p>
      <h1>Household admin</h1>
      <p className="lede">Approve televisions, choose family folders, and keep cloud sources healthy.</p>
      <form onSubmit={submit}>
        <label className="field">Admin passphrase<input autoFocus autoComplete="off" type="password" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
        {error && <p className="error-banner" role="alert">{error}</p>}
        <button className="button primary wide" disabled={pending || !passphrase}>{pending ? "Signing in…" : "Sign in"}</button>
      </form>
      <p className="security-note">Your passphrase is sent only for this sign-in and is never stored in this browser.</p>
    </section>
  </main>;
}

