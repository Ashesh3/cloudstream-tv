import type { Ref } from "preact";
import type { ViewerMediaItem, ViewerUrlState } from "@cloudframe/tv-core";
import { useEffect } from "preact/hooks";

import { loadVideoJs } from "../videojs";

export interface VideoPlayerProps {
  item: ViewerMediaItem;
  url?: ViewerUrlState;
  videoRef: Ref<HTMLVideoElement>;
  controlsVisible: boolean;
  buffering: boolean;
  currentSeconds: number;
  durationSeconds: number;
  bufferedPercent: number;
  onLoadedMetadata: (element: HTMLVideoElement) => void;
  onPlaying: () => void;
  onPlay: () => void;
  onCanPlay: () => void;
  onPause: (element: HTMLVideoElement) => void;
  onWaiting: () => void;
  onTimeUpdate: (element: HTMLVideoElement) => void;
  onProgress: (element: HTMLVideoElement) => void;
  onSeeked: (element: HTMLVideoElement) => void;
  onEnded: (element: HTMLVideoElement) => void;
  onError: (element: HTMLVideoElement) => void;
}

export function VideoPlayer(props: VideoPlayerProps) {
  const source = props.url?.status === "ready" ? props.url.url : undefined;
  useEffect(() => {
    void loadVideoJs();
  }, []);
  return (
    <div className="video-stage">
      <video-player class="cloudframe-video-player">
        <media-container class="cloudframe-media-container">
          {source ? (
            <video
              ref={props.videoRef}
              className="viewer-video"
              src={source}
              aria-label={`Playing ${props.item.name}`}
              preload="metadata"
              playsInline
              onLoadedMetadata={event => props.onLoadedMetadata(event.currentTarget)}
              onPlaying={props.onPlaying}
              onPlay={props.onPlay}
              onPause={event => props.onPause(event.currentTarget)}
              onWaiting={props.onWaiting}
              onCanPlay={props.onCanPlay}
              onTimeUpdate={event => props.onTimeUpdate(event.currentTarget)}
              onProgress={event => props.onProgress(event.currentTarget)}
              onLoadedData={event => props.onProgress(event.currentTarget)}
              onSeeked={event => props.onSeeked(event.currentTarget)}
              onEnded={event => props.onEnded(event.currentTarget)}
              onError={event => props.onError(event.currentTarget)}
            />
          ) : <div className="viewer-loading" role="status">Preparing video…</div>}
        </media-container>
      </video-player>
      <div className={`video-controls${props.controlsVisible ? " is-visible" : ""}`} aria-hidden={!props.controlsVisible}>
        <span>{props.buffering ? "Buffering…" : "Play / Pause"}</span>
        <span>−10s</span>
        <time>{formatTime(props.currentSeconds)} / {formatTime(props.durationSeconds)}</time>
        <span>+10s</span>
        <span className="buffered-track" role="progressbar" aria-label="Buffered" aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.bufferedPercent}>
          <i style={{ width: `${props.bufferedPercent}%` }} />
        </span>
      </div>
    </div>
  );
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}
