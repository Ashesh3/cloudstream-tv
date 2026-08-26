import { type FormEvent, useState } from "react";
import type { ApproveDeviceRequestBody, AssignedRootDto, DeviceRequestDto, SourceDto } from "@cloudframe/shared";
import { Dialog } from "./dialog";

export function ApprovalSheet({ request, roots, sources, onApprove, onClose }: {
  request: DeviceRequestDto;
  roots: AssignedRootDto[];
  sources: SourceDto[];
  onApprove(body: ApproveDeviceRequestBody): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(request.requestedName);
  const [selected, setSelected] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState("");
  const enabledRoots = roots.filter(root => root.enabled);
  const sourceFor = (root: AssignedRootDto) => sources.find(source => source.id === root.sourceId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextErrors: string[] = [];
    if (!name.trim()) nextErrors.push("Enter a device name.");
    if (!selected.length) nextErrors.push("Select at least one root.");
    setErrors(nextErrors);
    if (nextErrors.length) return;
    setPending(true);
    setFailure("");
    try {
      await onApprove({ name: name.trim(), rootIds: selected });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Approval failed. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog label="Approve device" onClose={onClose} className="approval-sheet">
      <form onSubmit={submit}>
        <header className="dialog-header">
          <div><p className="eyebrow">New television</p><h2>Approve device</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="dialog-scroll">
          <label className="field">Device name<input data-autofocus value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label>
          <fieldset className="root-picker"><legend>Available roots</legend>
            {enabledRoots.length ? enabledRoots.map(root => {
              const source = sourceFor(root);
              return <label className="root-choice" key={root.id}>
                <input type="checkbox" aria-label={root.displayName} checked={selected.includes(root.id)} onChange={() => setSelected(value => value.includes(root.id) ? value.filter(id => id !== root.id) : [...value, root.id])} />
                <span className="folder-mosaic" aria-hidden="true"><i /><i /><i /></span>
                <span><strong>{root.displayName}</strong><small>{source?.provider === "google" ? "Google Drive" : "OneDrive"} · {source?.accountLabel}</small></span>
              </label>;
            }) : <p className="empty-inline">Connect a source and add an enabled root before approving a device.</p>}
          </fieldset>
          {errors.length > 0 && <div className="form-errors" role="alert">{errors.map(error => <p key={error}>{error}</p>)}</div>}
          {failure && <p className="error-banner" role="alert">{failure}</p>}
        </div>
        <footer className="dialog-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={pending}>{pending ? "Approving…" : "Approve device"}</button></footer>
      </form>
    </Dialog>
  );
}

