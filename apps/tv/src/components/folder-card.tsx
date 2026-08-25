import { useState } from "preact/hooks";

export interface FolderThumbnail {
  nodeId: string;
  url?: string;
}

interface FolderCardProps {
  name: string;
  subtitle?: string;
  thumbnails: FolderThumbnail[];
  focused: boolean;
  onSelect?: () => void;
}

export function FolderCard({ name, subtitle, thumbnails, focused, onSelect }: FolderCardProps) {
  const covers = uniqueThumbnails(thumbnails).slice(0, 3);
  const variant = covers.length === 3 ? "three" : covers.length === 2 ? "two" : covers.length === 1 ? "one" : "zero";
  return (
    <button
      type="button"
      className={`tv-card folder-card${focused ? " is-focused" : ""}`}
      aria-label={`${name}, folder`}
      data-mosaic={variant}
      onClick={onSelect}
      tabIndex={focused ? 0 : -1}
    >
      <span className="card-visual folder-mosaic" aria-hidden="true">
        {covers.map(cover => <MosaicPane key={cover.nodeId} thumbnail={cover} />)}
        {covers.length === 0 && <EmptyFolderArt />}
      </span>
      <span className="card-copy">
        <strong>{name}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
    </button>
  );
}

function MosaicPane({ thumbnail }: { thumbnail: FolderThumbnail }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="mosaic-pane" data-preview={failed || !thumbnail.url ? "unavailable" : "ready"}>
      {thumbnail.url && (
        <img src={thumbnail.url} alt="" onError={() => setFailed(true)} />
      )}
      {failed && <span className="preview-fallback" />}
    </span>
  );
}

function EmptyFolderArt() {
  return (
    <span className="empty-folder-art">
      <span className="folder-tab" />
      <span className="folder-body"><span className="folder-glint" /></span>
    </span>
  );
}

function uniqueThumbnails(values: FolderThumbnail[]): FolderThumbnail[] {
  const seen: Record<string, boolean> = {};
  return values.filter(value => {
    if (seen[value.nodeId]) return false;
    seen[value.nodeId] = true;
    return true;
  });
}
