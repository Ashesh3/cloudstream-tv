export interface TvBreadcrumb {
  id: string;
  name: string;
}

export function TvHeader({ title, breadcrumbs, onHome, onSources }: {
  title: string;
  breadcrumbs?: TvBreadcrumb[];
  onHome: () => void;
  onSources: () => void;
}) {
  return (
    <header className="tv-header">
      <button className="brand" type="button" onClick={onHome} aria-label="Cloudframe home" tabIndex={-1}>
        <span className="brand-mark" aria-hidden="true"><span /><i /></span>
        <span><strong>Cloudframe</strong><small>Private screening room</small></span>
      </button>
      <nav aria-label="Breadcrumbs" className="breadcrumbs">
        <button type="button" onClick={onHome} tabIndex={-1}>Program</button>
        {breadcrumbs?.map(crumb => <span key={crumb.id}><i>/</i><span>{crumb.name}</span></span>)}
        {title !== "Home" && <span><i>/</i><strong>{title}</strong></span>}
      </nav>
      <button className="sources-action" type="button" onClick={onSources} tabIndex={-1} aria-label="Manage sources">Manage sources <kbd>Menu</kbd></button>
    </header>
  );
}
