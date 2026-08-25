import type { ComponentChild } from "preact";
import { useState } from "preact/hooks";

interface DeviceRequestProps {
  busy?: boolean;
  error?: string | null;
  onSubmit: (name: string) => void;
}

export function DeviceRequest({ busy, error, onSubmit }: DeviceRequestProps) {
  const [name, setName] = useState("");
  return (
    <StatePanel eyebrow="Welcome to Cloudframe" title="Name this TV" body="Choose a name your household will recognize when approving access.">
      <form className="device-form" onSubmit={event => {
        event.preventDefault();
        const value = name.trim();
        if (value) onSubmit(value);
      }}>
        <label htmlFor="device-name">TV name</label>
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
  eyebrow?: string;
  title: string;
  body: string;
  testId?: string;
  children?: ComponentChild | ComponentChild[];
}) {
  return (
    <main className="state-shell" data-testid={props.testId}>
      <section className="state-panel">
        <span className="state-mark" aria-hidden="true"><span /></span>
        {props.eyebrow && <p className="eyebrow">{props.eyebrow}</p>}
        <h1>{props.title}</h1>
        <p>{props.body}</p>
        {props.children}
      </section>
    </main>
  );
}
