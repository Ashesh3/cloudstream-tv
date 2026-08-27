import { type FormEvent, useEffect, useRef, useState } from "react";
import type { ApproveDeviceRequestBody, AssignedRootDto, DeviceRequestDto, SourceDto } from "@cloudframe/shared";
import { Clock3Icon, FolderOpenIcon, MonitorIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { INDEX_COPY, providerName } from "../design/ledger";

export function ApprovalSheet({ request, roots, sources, onApprove, onClose }: {
  request: DeviceRequestDto;
  roots: AssignedRootDto[];
  sources: SourceDto[];
  onApprove(body: ApproveDeviceRequestBody): Promise<void>;
  onClose(): void;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(request.requestedName);
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const enabledRoots = roots.filter(root => root.enabled);
  const sourceFor = (root: AssignedRootDto) => sources.find(source => source.id === root.sourceId);

  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => returnFocus.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: string[] = [];
    if (!name.trim()) nextErrors.push("Enter a device name.");
    if (!selected.length) nextErrors.push("Select at least one root.");
    setErrors(nextErrors);
    if (nextErrors.length) return;
    setPending(true);
    setFailure("");
    try { await onApprove({ name: name.trim(), rootIds: selected }); }
    catch (error) { setFailure(error instanceof Error ? error.message : "Approval failed. Try again."); }
    finally { setPending(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent aria-label="Approve device" className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
      <form onSubmit={submit} className="contents">
        <DialogHeader className="pr-8">
          <div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><MonitorIcon /></span><div><div className="flex flex-wrap items-center gap-2"><DialogTitle className="text-xl">Approve device</DialogTitle><Badge variant="secondary">New television</Badge></div><DialogDescription className="mt-1">Confirm the device name and choose the folders this television can browse.</DialogDescription></div></div>
        </DialogHeader>
        <div className="grid gap-5">
          <div className="grid gap-2 rounded-xl border bg-muted/40 p-4 sm:grid-cols-[1fr_auto] sm:items-center"><div><p className="text-sm font-medium">{request.requestedName}</p><p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3Icon className="size-3.5" />Requested {formatTime(request.createdAt)}</p></div><span className="text-xs text-muted-foreground">Expires {formatTime(request.expiresAt)}</span></div>
          <FieldGroup>
            <Field data-invalid={errors.includes("Enter a device name.")}>
              <FieldLabel htmlFor="approval-device-name">Device name</FieldLabel>
              <Input id="approval-device-name" data-autofocus autoFocus value={name} onChange={event => setName(event.target.value)} autoComplete="off" aria-invalid={errors.includes("Enter a device name.")} />
              <FieldDescription>Use a name your household will recognize later.</FieldDescription>
              {errors.includes("Enter a device name.") && <FieldError>Enter a device name.</FieldError>}
            </Field>
            <FieldSet>
              <FieldLegend>Folder access</FieldLegend>
              <FieldDescription><span>{enabledRoots.length} available {enabledRoots.length === 1 ? "folder" : "folders"}</span>. Select only what this television should see.</FieldDescription>
              <div className="grid gap-2">{enabledRoots.length ? enabledRoots.map(root => {
                const source = sourceFor(root);
                const checked = selected.includes(root.id);
                const indexCopy = source ? INDEX_COPY[source.indexState.kind] : null;
                return <Label key={root.id} htmlFor={`approval-root-${root.id}`} className="approval-root-row flex min-h-20 cursor-pointer items-start gap-3 border p-3 transition-colors hover:bg-muted/50 has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/8">
                  <Checkbox id={`approval-root-${root.id}`} aria-label={root.displayName} checked={checked} onCheckedChange={() => setSelected(value => value.includes(root.id) ? value.filter(id => id !== root.id) : [...value, root.id])} />
                  <span className="root-cue flex size-10 items-center justify-center text-muted-foreground"><FolderOpenIcon /></span>
                  <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{root.displayName}</strong><small className="mt-0.5 block truncate text-xs text-muted-foreground">{source ? `${providerName(source.provider)} · ${source.accountLabel}` : "Source unavailable"}</small>{indexCopy && <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"><span className="font-medium text-foreground">{indexCopy.title}</span><span className="text-muted-foreground">{source?.indexState.kind === "quota-exhausted" ? "Content appears after indexing resumes." : "Available after approval"}</span></span>}</span>
                </Label>;
              }) : <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Connect a source and add an enabled folder before approving a device.</p>}</div>
              {errors.includes("Select at least one root.") && <FieldError>Select at least one root.</FieldError>}
            </FieldSet>
          </FieldGroup>
          {failure && <Alert variant="destructive"><AlertDescription>{failure}</AlertDescription></Alert>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={pending || !enabledRoots.length}>{pending && <Spinner data-icon="inline-start" />}{pending ? "Approving…" : "Approve device"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "soon" : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }); }
