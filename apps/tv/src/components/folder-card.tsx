import { useState } from "react";

interface FolderCardProps {
  name: string;
  subtitle?: string;
  thumbnailUrl?: string;
  focused: boolean;
  program?: boolean;
  hero?: boolean;
  onThumbnailError?: () => void;
  onSelect?: () => void;
}

export function FolderCard({ name, subtitle, thumbnailUrl, focused, program = false, hero = false, onThumbnailError, onSelect }: FolderCardProps) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  const previewReady = Boolean(thumbnailUrl && failedUrl !== thumbnailUrl);
  return (
    <button
      type="button"
      className={`tv-card cloudframe-card folder-card${program ? " program-card" : ""}${hero ? " is-hero" : ""}${focused ? " is-focused" : ""}`}
      aria-label={`${name}, ${program ? "collection" : "folder"}`}
      data-testid={program ? "program-card" : undefined}
      onClick={onSelect}
      tabIndex={focused ? 0 : -1}
    >
      <span className="card-visual folder-art" aria-hidden="true">
        {previewReady ? <img src={thumbnailUrl} alt="" referrerPolicy="no-referrer" onError={() => { setFailedUrl(thumbnailUrl); onThumbnailError?.(); }} /> : null}
        <CollectionArt program={program} name={name} />
      </span>
      <span className="card-copy">
        <strong>{name}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
    </button>
  );
}

function CollectionArt({ program, name }: { program: boolean; name: string }) {
  return (
    <span className={`collection-art cloudframe-collection-art${program ? " is-program" : ""}`}>
      <b>{program ? initials(name) : "Folder"}</b>
      <span className="stock-copy">{program ? "Household collection" : "Cloudframe folder"}</span>
    </span>
  );
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word.charAt(0)).join("").toUpperCase();
}
