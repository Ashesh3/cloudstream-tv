import { useState } from "react";

interface MediaCardProps {
  name: string;
  kind: "image" | "video";
  thumbnailUrl?: string;
  focused: boolean;
  resumeProgress?: number;
  onThumbnailError?: () => void;
  onSelect?: () => void;
}

export function MediaCard({ name, kind, thumbnailUrl, focused, resumeProgress = 0, onThumbnailError, onSelect }: MediaCardProps) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  const unavailable = !thumbnailUrl || failedUrl === thumbnailUrl;
  const percent = Math.round(Math.max(0, Math.min(1, resumeProgress)) * 100);
  return (
    <button
      type="button"
      className={`tv-card cloudframe-card media-card${focused ? " is-focused" : ""}`}
      aria-label={`${name}, ${kind}`}
      onClick={onSelect}
      tabIndex={focused ? 0 : -1}
    >
      <span className="card-visual media-preview" data-preview={unavailable ? "unavailable" : "ready"}>
        {thumbnailUrl && failedUrl !== thumbnailUrl && <img src={thumbnailUrl} alt="" referrerPolicy="no-referrer" onError={() => { setFailedUrl(thumbnailUrl); onThumbnailError?.(); }} />}
        {unavailable ? <span className="media-stock cloudframe-media-fallback">{kind === "video" ? "Video" : "Photo"}</span> : null}
        {kind === "video" && <span className="video-badge">Video</span>}
        {kind === "video" && percent > 0 && (
          <span className="resume-track" role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      <span className="card-copy"><strong>{name}</strong><small>{kind === "video" ? "Motion" : "Photo"}</small></span>
    </button>
  );
}
