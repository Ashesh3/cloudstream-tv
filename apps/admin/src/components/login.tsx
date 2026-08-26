import { type FormEvent, useState } from "react";
import { EyeIcon, EyeOffIcon, FolderOpenIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CardDescription } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function Login({ onLogin }: { onLogin(passphrase: string): Promise<void> }) {
  const [passphrase, setPassphrase] = useState("");
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase) return;
    setPending(true); setError("");
    try { await onLogin(passphrase); setPassphrase(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Sign in failed."); }
    finally { setPending(false); }
  };
  return <main className="login-stage relative grid min-h-screen place-items-center overflow-hidden p-4 sm:p-8">
    <div className="projection-beam" aria-hidden="true" />
    <section className="login-ledger relative w-full max-w-md">
      <header className="login-ledger-header"><div className="flex items-center gap-3"><span className="login-cue" aria-hidden="true"><FolderOpenIcon /></span><div><p className="text-sm font-semibold">Cloudframe</p><p className="text-xs text-muted-foreground">Private screening program</p></div></div><div className="mt-8"><h1 className="font-heading text-4xl font-semibold tracking-[-.025em]">Household admin</h1><CardDescription className="mt-3 leading-6">Approve televisions, program cloud folders, and keep index truth in view.</CardDescription></div></header>
      <form onSubmit={submit}>
        <div className="login-ledger-body"><FieldGroup><Field data-invalid={Boolean(error)}><FieldLabel htmlFor="admin-passphrase">Admin passphrase</FieldLabel><div className="relative"><Input id="admin-passphrase" autoFocus autoComplete="current-password" type={visible ? "text" : "password"} value={passphrase} onChange={event => setPassphrase(event.target.value)} aria-invalid={Boolean(error)} className="h-11 pr-12" /><Button type="button" variant="ghost" size="icon" className="absolute right-1.5 top-1.5" aria-label="Toggle secret visibility" onClick={() => setVisible(value => !value)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</Button></div><FieldDescription>Your passphrase is used only for this sign-in and is never stored in this browser.</FieldDescription>{error && <FieldError>{error}</FieldError>}</Field></FieldGroup></div>
        <footer className="login-ledger-footer"><Button className="h-11 w-full" aria-label={pending ? "Signing in…" : "Sign in"} disabled={pending || !passphrase}>{pending && <Spinner data-icon="inline-start" aria-hidden="true" />}{pending ? "Signing in…" : "Enter screening room"}</Button><div className="flex w-full items-center justify-center gap-2 text-xs text-muted-foreground"><ShieldCheckIcon className="size-3.5" />Server-managed household access</div></footer>
      </form>
    </section>
  </main>;
}
