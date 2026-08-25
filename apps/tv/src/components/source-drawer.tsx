import type { TvRootCardDto } from "@cloudframe/shared";

export function SourceDrawer({ open, roots, onClose, onHome, onSelect }: {
  open: boolean;
  roots: TvRootCardDto[];
  onClose: () => void;
  onHome: () => void;
  onSelect: (root: TvRootCardDto) => void;
}) {
  if (!open) return null;
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="source-drawer" role="dialog" aria-label="Sources" aria-modal="true" onClick={event => event.stopPropagation()}>
        <header><span>Navigate</span><button type="button" onClick={onClose}>Close</button></header>
        <button className="drawer-home" type="button" onClick={onHome}>All folders</button>
        <div className="drawer-list">
          {roots.map(root => (
            <button type="button" key={root.id} onClick={() => onSelect(root)}>
              <span className={`provider-dot ${root.provider}`} />
              <span><strong>{root.displayName}</strong><small>{root.accountLabel}</small></span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}
