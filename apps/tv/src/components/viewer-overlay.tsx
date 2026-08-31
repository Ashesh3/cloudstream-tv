import type { ViewerMediaItem } from "@cloudframe/tv-core";

export function ViewerOverlay({ items, activeIndex }: { items: ViewerMediaItem[]; activeIndex: number }) {
  const active = items[activeIndex]!;
  return (
    <aside className="viewer-overlay cloudframe-viewer-overlay" role="dialog" aria-label="Media details">
      <section className="viewer-details">
        <h2>{active.name}</h2>
        <p>Now viewing · {active.kind === "video" ? "Video" : "Photo"}</p>
        <span>{active.mimeType ?? "Original file"}</span>
      </section>
      <section className="viewer-filmstrip" aria-label="Folder media">
        {items.map((item, index) => (
          <span key={item.id} className={index === activeIndex ? "is-active" : ""}>
            <i aria-hidden="true" />
            <b>{item.name}</b>
          </span>
        ))}
      </section>
    </aside>
  );
}
