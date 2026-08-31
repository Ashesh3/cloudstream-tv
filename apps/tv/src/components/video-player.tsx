import type { Ref } from "react";
import type { ViewerMediaItem, ViewerUrlState } from "@cloudframe/tv-core";
import { useCallback, useEffect, useRef, useState } from "react";

import { attachHlsSource, type HlsPlaybackErrorKind, type HlsPlaybackHandle } from "../media/hls-playback";
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
  onHlsAttached: () => void;
  onHlsFatal: (error: { kind: HlsPlaybackErrorKind }) => void;
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
  const readyUrl = props.url?.status === "ready" ? props.url : undefined;
  const source = readyUrl?.sourceKind === "hls" ? undefined : readyUrl?.url;
  const hlsPlaylist = readyUrl?.sourceKind === "hls" ? readyUrl.url : undefined;
  const [videoJsReady, setVideoJsReady] = useState<boolean | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const hlsHandle = useRef<HlsPlaybackHandle | null>(null);
  const hlsOwnsElementErrors = useRef(false);
  const noReferrer = { referrerPolicy: "no-referrer" } as const;

  useEffect(() => {
    let active = true;
    void loadVideoJs().then(loaded => {
      if (active) setVideoJsReady(loaded);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    hlsHandle.current?.destroy();
    hlsHandle.current = null;
    hlsOwnsElementErrors.current = false;
    const element = videoElement;
    if (!element || !hlsPlaylist) return;
    let active = true;
    let fatalReported = false;
    void attachHlsSource(element, hlsPlaylist, {
      onFatal(error) {
        if (!active || fatalReported) return;
        fatalReported = true;
        props.onHlsFatal(error);
      },
    }).then(handle => {
      if (!active) {
        handle.destroy();
        return;
      }
      hlsHandle.current = handle;
      hlsOwnsElementErrors.current = handle.handlesElementErrors;
      props.onHlsAttached();
    }).catch(() => {
      if (!active || fatalReported) return;
      fatalReported = true;
      props.onHlsFatal({ kind: "unsupported" });
    });
    return () => {
      active = false;
      hlsHandle.current?.destroy();
      hlsHandle.current = null;
      hlsOwnsElementErrors.current = false;
    };
  }, [hlsPlaylist, videoElement]);

  const assignVideo = useCallback((element: HTMLVideoElement | null) => {
    if (video.current !== element) {
      video.current = element;
      setVideoElement(element);
    }
    assignRef(props.videoRef, element);
  }, [props.videoRef]);

  return (
    <section className="video-stage">
      <video-player className="cloudframe-video-player">
        <video-skin className="cloudframe-video-skin">
          {readyUrl ? (
            <video
              key={`${readyUrl.sourceKind}:${readyUrl.url}`}
              ref={assignVideo}
              className="viewer-video"
              src={source}
              controls={videoJsReady === false}
              aria-label={`Playing ${props.item.name}`}
              preload="metadata"
              {...noReferrer}
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
              onError={event => { if (!hlsOwnsElementErrors.current) props.onError(event.currentTarget); }}
            />
          ) : <section className="viewer-loading cloudframe-viewer-loading" role="status">Preparing video…</section>}
        </video-skin>
      </video-player>
      {videoJsReady !== true ? (
        <section className={`video-controls cloudframe-video-controls${props.controlsVisible ? " is-visible" : ""}`} aria-hidden={!props.controlsVisible}>
          <span>{props.buffering ? "Buffering…" : "Play / Pause"}</span>
          <span>−10s</span>
          <time>{formatTime(props.currentSeconds)} / {formatTime(props.durationSeconds)}</time>
          <span>+10s</span>
          <span className="buffered-track" role="progressbar" aria-label="Buffered" aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.bufferedPercent}>
            <i style={{ width: `${props.bufferedPercent}%` }} />
          </span>
        </section>
      ) : null}
    </section>
  );
}

function assignRef<T>(ref: Ref<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}
