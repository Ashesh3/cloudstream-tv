import type { ViewerMediaItem, ViewerUrlState } from "@cloudframe/tv-core";

export function ImageViewer({ item, url, previewUrl, onError }: {
  item: ViewerMediaItem;
  url?: ViewerUrlState;
  previewUrl?: string;
  onError: () => void;
}) {
  const source = url?.status === "ready" ? url.url : previewUrl;
  if (!source) return <section className="viewer-loading cloudframe-viewer-loading" role="status">Preparing image…</section>;
  return <img className="viewer-image" src={source} alt={item.name} onError={onError} referrerPolicy="no-referrer" />;
}
