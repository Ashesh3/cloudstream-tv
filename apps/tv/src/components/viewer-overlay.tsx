import type { ViewerMediaItem } from "@cloudframe/tv-core";

export function ViewerOverlay({ items, activeIndex }: { items: ViewerMediaItem[]; activeIndex: number }) {
  const active = items[activeIndex]!;
  return (
    <aside className="viewer-overlay" role="dialog" aria-label="Media details">
      <div className="viewer-details">
        <p>{active.kind === "video" ? "Video" : "Photo"}</p>
        <h2>{active.name}</h2>
        <span>{active.mimeType ?? "Unknown format"}</span>
      </div>
      <div className="viewer-filmstrip" aria-label="Folder media">
        {items.map((item, index) => (
          <span key={item.id} className={index === activeIndex ? "is-active" : ""}>
            <i>{item.kind === "video" ? "▶" : "▧"}</i>
            <b>{item.name}</b>
          </span>
        ))}
      </div>
    </aside>
  );
}
