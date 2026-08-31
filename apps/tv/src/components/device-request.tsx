import type { ReactNode } from "react";
import { useState } from "react";

interface DeviceRequestProps {
  busy?: boolean;
  error?: string | null;
  onSubmit: (name: string) => void;
}

export function DeviceRequest({ busy, error, onSubmit }: DeviceRequestProps) {
  const [name, setName] = useState("");
  return (
    <StatePanel title="Name this TV" body="Mark this screen for the program ledger, then approve its collections from Cloudframe Admin." state="enrollment">
      <ol className="enrollment-steps" aria-label="Connection steps">
        <li><span>1</span><strong>Name the screen</strong><small>Use the room name your household knows.</small></li>
        <li><span>2</span><strong>Send the request</strong><small>The program desk receives it securely.</small></li>
        <li><span>3</span><strong>Approve the program</strong><small>Only chosen collections appear here.</small></li>
      </ol>
      <form className="device-form" onSubmit={event => {
        event.preventDefault();
        const value = name.trim();
        if (value) onSubmit(value);
      }}>
        <div className="device-label-row"><label htmlFor="device-name">TV name</label><small>Shown in Household Admin</small></div>
        <input
          id="device-name"
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="Living room TV"
          autoComplete="off"
          autoFocus
          maxLength={80}
        />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary-action" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Requesting…" : "Request access"}
        </button>
      </form>
    </StatePanel>
  );
}

export function StatePanel(props: {
  title: string;
  body: string;
  state?: string;
  testId?: string;
  children?: ReactNode;
}) {
  return (
    <main className="state-shell" data-testid={props.testId}>
      <section className="state-panel" data-material="program-stock" data-state={props.state}>
        <span className="state-mark" aria-hidden="true"><span /><i /></span>
        <h1>{props.title}</h1>
        <p>{props.body}</p>
        {props.children}
      </section>
    </main>
  );
}
