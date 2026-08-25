import type { MediaNodeDto } from "@cloudframe/shared";

export function TvHeader({ title, breadcrumbs, onHome, onSources }: {
  title: string;
  breadcrumbs?: MediaNodeDto[];
  onHome: () => void;
  onSources: () => void;
}) {
  return (
    <header className="tv-header">
      <button className="brand" type="button" onClick={onHome} aria-label="Cloudframe home">
        <span className="brand-mark"><span /></span>
        <span>Cloudframe</span>
      </button>
      <nav aria-label="Breadcrumbs" className="breadcrumbs">
        <button type="button" onClick={onHome}>Home</button>
        {breadcrumbs?.map(crumb => <span key={crumb.id}><i>/</i><span>{crumb.name}</span></span>)}
        {title !== "Home" && <span><i>/</i><strong>{title}</strong></span>}
      </nav>
      <button className="sources-action" type="button" onClick={onSources}>Sources <kbd>Menu</kbd></button>
    </header>
  );
}
