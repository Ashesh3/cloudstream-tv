import { type FormEvent, useState } from "react";
import type { ClaimInstallationBody } from "@cloudframe/shared";
import { FolderKeyIcon, ShieldCheckIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AdminApiError } from "../api/client";

export function FirstRun({
  onClaim,
}: {
  onClaim(input: ClaimInstallationBody): Promise<void>;
}) {
  const [setupCode, setSetupCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (passphrase !== confirmation) {
      setError("The passphrases do not match.");
      return;
    }
    setPending(true);
    try {
      await onClaim({ setupCode, passphrase });
      setSetupCode("");
      setPassphrase("");
      setConfirmation("");
    } catch (cause) {
      setError(cause instanceof AdminApiError
        ? cause.message
        : "Cloudframe could not claim this installation. Try again.");
    } finally {
      setPending(false);
    }
  };

  return <main className="login-stage relative grid min-h-screen place-items-center overflow-hidden p-4 sm:p-8">
    <div className="projection-beam" aria-hidden="true" />
    <section className="login-ledger relative w-full max-w-lg">
      <header className="login-ledger-header">
        <div className="flex items-center gap-3">
          <span className="login-cue" aria-hidden="true"><FolderKeyIcon /></span>
          <div><p className="text-sm font-semibold">Cloudframe</p><p className="text-xs text-muted-foreground">Fresh household installation</p></div>
        </div>
        <div className="mt-8">
          <h1 className="font-heading text-4xl font-semibold tracking-[-.025em]">Claim this server</h1>
          <p className="mt-3 leading-6 text-muted-foreground">This empty <code>/data</code> volume is the installation boundary. No cloud configuration was imported.</p>
        </div>
      </header>
      <form onSubmit={submit}>
        <div className="login-ledger-body grid gap-4">
          <label className="field">Setup code<Input autoFocus autoComplete="one-time-code" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} /></label>
          <label className="field">New admin passphrase<Input autoComplete="new-password" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
          <label className="field">Confirm admin passphrase<Input autoComplete="new-password" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
          <p className="text-sm text-muted-foreground">Use the one-time code from the server log. The passphrase becomes the permanent household-admin credential.</p>
          {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        </div>
        <footer className="login-ledger-footer">
          <Button className="h-11 w-full" disabled={pending || !setupCode || !passphrase || !confirmation}>
            {pending ? "Claiming installation…" : "Claim installation"}
          </Button>
          <div className="flex w-full items-center justify-center gap-2 text-xs text-muted-foreground"><ShieldCheckIcon className="size-3.5" />One-time ownership claim</div>
        </footer>
      </form>
    </section>
  </main>;
}
