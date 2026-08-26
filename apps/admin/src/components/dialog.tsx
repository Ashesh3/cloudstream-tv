import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

export function Dialog({ label, children, onClose, className = "" }: {
  label: string;
  children: ReactNode;
  onClose(): void;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => {
      const preferred = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]");
      (preferred ?? dialogRef.current?.querySelector<HTMLElement>("button,input,select"))?.focus();
    });
    return () => {
      window.clearTimeout(timer);
      returnFocus.current?.focus();
    };
  }, []);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),[href]") ?? []);
    if (!nodes.length) return;
    const first = dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <div ref={dialogRef} className={`dialog-panel ${className}`} role="dialog" aria-modal="true" aria-label={label} onKeyDown={keyDown}>
        {children}
      </div>
    </div>
  );
}
