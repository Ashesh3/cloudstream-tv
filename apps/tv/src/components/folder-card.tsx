import { useState } from "preact/hooks";
import type { TvRootCardDto } from "@cloudframe/shared";

import { ProgramStatus } from "./program-status";

export interface FolderThumbnail {
  nodeId: string;
  url?: string;
}

interface FolderCardProps {
  name: string;
  subtitle?: string;
  thumbnails: FolderThumbnail[];
  focused: boolean;
  program?: boolean;
  hero?: boolean;
  readiness?: TvRootCardDto["readiness"];
  readinessMessage?: string;
  onSelect?: () => void;
}

export function FolderCard({ name, subtitle, thumbnails, focused, program = false, hero = false, readiness = "ready", readinessMessage = "Ready to screen", onSelect }: FolderCardProps) {
  const covers = uniqueThumbnails(thumbnails).slice(0, 3);
  const variant = covers.length === 3 ? "three" : covers.length === 2 ? "two" : covers.length === 1 ? "one" : "zero";
  return (
    <button
      type="button"
      className={`tv-card folder-card${program ? " program-card" : ""}${hero ? " is-hero" : ""}${focused ? " is-focused" : ""}`}
      aria-label={`${name}, ${program ? "program" : "folder"}${readiness === "ready" ? "" : `, ${readinessMessage}`}`}
      data-testid={program ? "program-card" : undefined}
      data-readiness={program ? readiness : undefined}
      data-mosaic={variant}
      onClick={onSelect}
      tabIndex={focused ? 0 : -1}
    >
      <span className="card-visual folder-mosaic" data-mosaic={variant} aria-hidden="true">
        {covers.map(cover => <MosaicPane key={cover.nodeId} thumbnail={cover} />)}
        {covers.length === 0 && <ProgramStockArt program={program} name={name} />}
        {program && <span className="program-frame-mark"><i /><i /></span>}
      </span>
      <span className="card-copy">
        <strong>{name}</strong>
        {subtitle && <small>{subtitle}</small>}
        {program && readiness !== "ready" && <ProgramStatus readiness={readiness} message={readinessMessage} compact />}
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

function ProgramStockArt({ program, name }: { program: boolean; name: string }) {
  return (
    <span className={`program-stock-art${program ? " is-program" : ""}`}>
      <span className="stock-rule" />
      <b>{program ? initials(name) : "Folder"}</b>
      <span className="stock-copy">{program ? "Household screening program" : "Cloudframe collection"}</span>
    </span>
  );
}

function initials(value: string): string {
  return value.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word.charAt(0)).join("").toUpperCase();
}

function uniqueThumbnails(values: FolderThumbnail[]): FolderThumbnail[] {
  const seen: Record<string, boolean> = {};
  return values.filter(value => {
    if (seen[value.nodeId]) return false;
    seen[value.nodeId] = true;
    return true;
  });
}
