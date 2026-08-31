import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";

interface DeviceRequestProps { busy?: boolean; error?: string | null; onSubmit: (name: string) => void; }

export function DeviceRequest({ busy, error, onSubmit }: DeviceRequestProps) {
  const [name, setName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (value && !busy) onSubmit(value);
  };
  return <StatePanel title="Name this TV" body="Give this television a familiar room name, then approve its collections from Cloudframe Admin." state="enrollment"><VStack gap={5}>
    <ol className="enrollment-steps cloudframe-steps" aria-label="Connection steps">
      <li><strong>Name the television</strong><small>Use the room name your household knows.</small></li>
      <li><strong>Send the request</strong><small>Cloudframe Admin receives it securely.</small></li>
      <li><strong>Approve collections</strong><small>Only chosen collections appear here.</small></li>
    </ol>
    <form className="device-form" onSubmit={submit}>
      <label htmlFor="device-name">TV name</label>
      <input ref={input} id="device-name" value={name} onInput={event => setName(event.currentTarget.value.slice(0, 80))} placeholder="Living room TV" autoComplete="off" />
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-action" type="submit" disabled={Boolean(busy || !name.trim())}>{busy ? "Requesting…" : "Request access"}</button>
    </form>
  </VStack></StatePanel>;
}

export function StatePanel({ title, body, state, testId, children }: { title: string; body: string; state?: string; testId?: string; children?: ReactNode; }) {
  return <VStack as="main" className="state-shell cloudframe-state-shell" data-testid={testId} justify="center" align="center" padding={8}><Section className="state-panel cloudframe-state-panel" maxWidth="52rem" width="100%" padding={8} data-state={state} data-material="cloudframe-night"><VStack gap={6}><VStack gap={2}><p className="state-context">Cloudframe television</p><h1>{title}</h1><p>{body}</p></VStack>{children}</VStack></Section></VStack>;
}

export function StateAction({ label, onClick }: { label: string; onClick(): void }) {
  return <button className="primary-action" onClick={onClick}>{label}</button>;
}
