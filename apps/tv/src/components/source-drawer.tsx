import type { TvRootDto } from "@cloudframe/shared";
import { normalizeTvKey, shouldHandleTvKey } from "@cloudframe/tv-core";
import { HStack } from "@astryxdesign/core/HStack";
import { Section } from "@astryxdesign/core/Section";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useRef, useState } from "react";

export function SourceDrawer({ open, roots, onClose, onHome, onSelect }: { open: boolean; roots: TvRootDto[]; onClose: () => void; onHome: () => void; onSelect: (root: TvRootDto) => void; }) {
  const host = useRef<HTMLElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const actions = [onClose, onHome, ...roots.map(root => () => onSelect(root))];
  useEffect(() => { if (!open) return; setFocusedIndex(0); const frame = window.setTimeout(() => focusableButtons(host.current)[0]?.focus(), 0); return () => window.clearTimeout(frame); }, [open]);
  useEffect(() => { if (open) setFocusedIndex(value => Math.min(value, actions.length - 1)); }, [actions.length, open]);
  useEffect(() => { if (open) focusableButtons(host.current)[focusedIndex]?.focus(); }, [focusedIndex, open]);
  if (!open) return null;
  return <Section className="drawer-scrim" padding={0} onClick={onClose}><VStack ref={host} as="aside" className="source-drawer cloudframe-source-drawer" role="dialog" aria-label="Sources" aria-modal="true" gap={4} padding={8} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === "Tab") { setFocusedIndex(value => event.shiftKey ? Math.max(0, value - 1) : Math.min(actions.length - 1, value + 1)); event.preventDefault(); return; }
    if (event.key === "Home") { setFocusedIndex(0); event.preventDefault(); return; }
    if (event.key === "End") { setFocusedIndex(actions.length - 1); event.preventDefault(); return; }
    const action = normalizeTvKey(event);
    if (!action || !shouldHandleTvKey(action, event.repeat)) return;
    if (action === "down" || action === "right") setFocusedIndex(value => Math.min(actions.length - 1, value + 1));
    else if (action === "up" || action === "left") setFocusedIndex(value => Math.max(0, value - 1));
    else if (action === "enter") actions[focusedIndex]?.();
    else if (action === "back") onClose();
    else return;
    event.preventDefault();
  }}><HStack as="header" gap={4} align="center" justify="between"><VStack gap={1}><h2>Choose a collection</h2><p>Open an approved household folder.</p></VStack><button type="button" onClick={onClose} data-drawer-focusable="true" tabIndex={focusedIndex === 0 ? 0 : -1}>Close · Back</button></HStack><button className="drawer-home" type="button" onClick={onHome} data-drawer-focusable="true" tabIndex={focusedIndex === 1 ? 0 : -1}>Household collections</button><ul className="drawer-list" aria-label="Approved collections">{roots.map((root, index) => <li key={root.id}><button type="button" onClick={() => onSelect(root)} data-drawer-focusable="true" tabIndex={focusedIndex === index + 2 ? 0 : -1}><strong>{root.displayName}</strong><small>{root.accountLabel}</small></button></li>)}</ul></VStack></Section>;
}

function focusableButtons(host: HTMLElement | null): NodeListOf<HTMLButtonElement> | [] { return host?.querySelectorAll<HTMLButtonElement>("button[data-drawer-focusable='true']") ?? []; }
