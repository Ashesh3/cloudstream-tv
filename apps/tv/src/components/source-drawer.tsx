import type { TvRootDto } from "@cloudframe/shared";
import { normalizeTvKey, shouldHandleTvKey } from "@cloudframe/tv-core";
import { useEffect, useRef, useState } from "react";

export function SourceDrawer({ open, roots, onClose, onHome, onSelect }: {
  open: boolean;
  roots: TvRootDto[];
  onClose: () => void;
  onHome: () => void;
  onSelect: (root: TvRootDto) => void;
}) {
  const host = useRef<HTMLElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const actions = [onClose, onHome, ...roots.map(root => () => onSelect(root))];
  useEffect(() => {
    if (!open) return;
    setFocusedIndex(0);
    const frame = window.setTimeout(() => focusableButtons(host.current)[0]?.focus(), 0);
    return () => window.clearTimeout(frame);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setFocusedIndex(value => Math.min(value, actions.length - 1));
  }, [actions.length, open]);
  useEffect(() => {
    if (!open) return;
    focusableButtons(host.current)[focusedIndex]?.focus();
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
          if (event.key === "Home") {
            setFocusedIndex(0);
            event.preventDefault();
            return;
          }
          if (event.key === "End") {
            setFocusedIndex(actions.length - 1);
            event.preventDefault();
            return;
          }
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
        <header><h2>Choose a collection</h2><button type="button" onClick={onClose} data-drawer-focusable="true" tabIndex={focusedIndex === 0 ? 0 : -1}>Close <kbd>Back</kbd></button></header>
        <button className="drawer-home" type="button" onClick={onHome} data-drawer-focusable="true" tabIndex={focusedIndex === 1 ? 0 : -1}><span className="drawer-cue" />Household program</button>
        <div className="drawer-list">
          {roots.map((root, index) => (
            <button type="button" key={root.id} onClick={() => onSelect(root)} data-drawer-focusable="true" tabIndex={focusedIndex === index + 2 ? 0 : -1}>
              <span className={`provider-monogram ${root.provider}`}>{root.provider === "google" ? "G" : "1"}</span>
              <span><strong>{root.displayName}</strong><small>{root.accountLabel}</small></span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function focusableButtons(host: HTMLElement | null): NodeListOf<HTMLButtonElement> | [] {
  return host?.querySelectorAll<HTMLButtonElement>("button[data-drawer-focusable='true']") ?? [];
}
