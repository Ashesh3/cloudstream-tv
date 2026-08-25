import { useState } from "preact/hooks";

interface MediaCardProps {
  name: string;
  kind: "image" | "video";
  thumbnailUrl?: string;
  focused: boolean;
  resumeProgress?: number;
  onSelect?: () => void;
}

export function MediaCard({ name, kind, thumbnailUrl, focused, resumeProgress = 0, onSelect }: MediaCardProps) {
  const [failed, setFailed] = useState(false);
  const percent = Math.round(Math.max(0, Math.min(1, resumeProgress)) * 100);
  return (
    <button
      type="button"
      className={`tv-card media-card${focused ? " is-focused" : ""}`}
      aria-label={`${name}, ${kind}`}
      onClick={onSelect}
      tabIndex={focused ? 0 : -1}
    >
      <span className="card-visual media-preview" data-preview={failed || !thumbnailUrl ? "unavailable" : "ready"}>
        {thumbnailUrl && <img src={thumbnailUrl} alt="" onError={() => setFailed(true)} />}
        {kind === "video" && <span className="video-badge">Video</span>}
        {kind === "video" && percent > 0 && (
          <span className="resume-track" role="progressbar" aria-label="Watched" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
      </span>
      <span className="card-copy"><strong>{name}</strong></span>
    </button>
  );
}
