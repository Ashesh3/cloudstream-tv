import { type FormEvent, useState } from "react";
import { EyeIcon, EyeOffIcon, FolderOpenIcon, ShieldCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
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
  return <main className="relative grid min-h-screen place-items-center overflow-hidden bg-muted/40 p-4 sm:p-8">
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,color-mix(in_oklch,var(--primary)_12%,transparent),transparent_34%)]" />
    <Card className="relative w-full max-w-md shadow-lg">
      <CardHeader className="gap-4 border-b pb-5"><div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><FolderOpenIcon /></span><div><p className="text-sm font-semibold">Cloudframe</p><p className="text-xs text-muted-foreground">Private household library</p></div></div><div><h1 className="font-heading text-2xl font-medium">Household admin</h1><CardDescription className="mt-2 leading-6">Approve televisions, manage cloud folders, and keep household access healthy.</CardDescription></div></CardHeader>
      <form onSubmit={submit}>
        <CardContent className="py-1"><FieldGroup><Field data-invalid={Boolean(error)}><FieldLabel htmlFor="admin-passphrase">Admin passphrase</FieldLabel><div className="relative"><Input id="admin-passphrase" autoFocus autoComplete="current-password" type={visible ? "text" : "password"} value={passphrase} onChange={event => setPassphrase(event.target.value)} aria-invalid={Boolean(error)} className="h-11 pr-11" /><Button type="button" variant="ghost" size="icon" className="absolute right-1.5 top-1.5" aria-label="Toggle secret visibility" onClick={() => setVisible(value => !value)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</Button></div><FieldDescription>Your passphrase is used only for this sign-in and is never stored in this browser.</FieldDescription>{error && <FieldError>{error}</FieldError>}</Field></FieldGroup></CardContent>
        <CardFooter className="flex-col gap-3"><Button className="h-11 w-full" aria-label={pending ? "Signing in…" : "Sign in"} disabled={pending || !passphrase}>{pending && <Spinner data-icon="inline-start" aria-hidden="true" />}{pending ? "Signing in…" : "Sign in"}</Button><div className="flex w-full items-center justify-center gap-2 text-xs text-muted-foreground"><ShieldCheckIcon className="size-3.5" />Server-managed household access</div></CardFooter>
      </form>
    </Card>
  </main>;
}
