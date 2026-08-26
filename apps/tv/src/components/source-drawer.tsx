import type { TvRootCardDto } from "@cloudframe/shared";
import { normalizeTvKey, shouldHandleTvKey } from "@cloudframe/tv-core";
import { useEffect, useRef, useState } from "preact/hooks";
import { ProgramStatus } from "./program-status";

export function SourceDrawer({ open, roots, onClose, onHome, onSelect }: {
  open: boolean;
  roots: TvRootCardDto[];
  onClose: () => void;
  onHome: () => void;
  onSelect: (root: TvRootCardDto) => void;
}) {
  const host = useRef<HTMLElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const actions = [onClose, onHome, ...roots.map(root => () => { if (root.nodeId) onSelect(root); })];
  useEffect(() => {
    if (!open) return;
    setFocusedIndex(0);
    const frame = window.setTimeout(() => host.current?.querySelectorAll<HTMLButtonElement>("button")[0]?.focus(), 0);
    return () => window.clearTimeout(frame);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    host.current?.querySelectorAll<HTMLButtonElement>("button")[focusedIndex]?.focus();
  }, [focusedIndex, open]);
  if (!open) return null;
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside
        ref={host}
        className="source-drawer"
        role="dialog"
        aria-label="Sources"
        aria-modal="true"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation();
          const action = normalizeTvKey(event);
          if (!action || !shouldHandleTvKey(action, event.repeat)) return;
          if (action === "down" || action === "right") setFocusedIndex(value => Math.min(actions.length - 1, value + 1));
          else if (action === "up" || action === "left") setFocusedIndex(value => Math.max(0, value - 1));
          else if (action === "enter") actions[focusedIndex]?.();
          else if (action === "back") onClose();
          else return;
          event.preventDefault();
        }}
      >
        <header><div><small>Program desk</small><strong>Choose a collection</strong></div><button type="button" onClick={onClose}>Close <kbd>Back</kbd></button></header>
        <button className="drawer-home" type="button" onClick={onHome}><span className="drawer-cue" />Household program</button>
        <div className="drawer-list">
          {roots.map(root => (
            <button type="button" key={root.id} onClick={() => root.nodeId && onSelect(root)} aria-disabled={!root.nodeId}>
              <span className={`provider-monogram ${root.provider}`}>{root.provider === "google" ? "G" : "1"}</span>
              <span><strong>{root.displayName}</strong><small>{root.accountLabel}</small><ProgramStatus readiness={root.readiness} message={root.readinessMessage} compact /></span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
