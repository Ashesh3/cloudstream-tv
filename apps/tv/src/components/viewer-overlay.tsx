import type { ViewerMediaItem } from "@cloudframe/tv-core";

export function ViewerOverlay({ items, activeIndex }: { items: ViewerMediaItem[]; activeIndex: number }) {
  const active = items[activeIndex]!;
  return (
    <aside className="viewer-overlay" role="dialog" aria-label="Media details">
      <div className="viewer-details">
        <h2>{active.name}</h2>
        <p>Now screening · {active.kind === "video" ? "Motion" : "Still"}</p>
        <span>{active.mimeType ?? "Original file"}</span>
      </div>
      <div className="viewer-filmstrip" aria-label="Folder media">
        {items.map((item, index) => (
          <span key={item.id} className={index === activeIndex ? "is-active" : ""}>
            <i aria-hidden="true"><span /></i>
            <b>{item.name}</b>
          </span>
        ))}
      </div>
    </aside>
  );
}
