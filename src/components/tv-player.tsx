"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import videojs from "video.js";
import type Player from "video.js/dist/types/player";
import "video.js/dist/video-js.css";
import {
  CONTROLS_AUTO_HIDE_MS,
  SEEK_STEP_SECONDS,
  WATCH_HISTORY_SAVE_INTERVAL_MS,
} from "@/lib/constants";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  if (h > 0) {
    return `${h}:${pad(m)}:${pad(sec)}`;
  }
  return `${m}:${pad(sec)}`;
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TVPlayerProps {
  src: string;
  mimeType?: string;
  initialPosition?: number;
  onBack: () => void;
  onProgress?: (position: number, duration: number) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TVPlayer({
  src,
  mimeType = "video/mp4",
  initialPosition = 0,
  onBack,
  onProgress,
}: TVPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(true);

  /* ---- Show / hide controls ---- */
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      // Only auto-hide when playing
      if (playerRef.current && !playerRef.current.paused()) {
        setControlsVisible(false);
      }
    }, CONTROLS_AUTO_HIDE_MS);
  }, []);

  /* ---- Save position helper ---- */
  const savePosition = useCallback(() => {
    const player = playerRef.current;
    if (!player || !onProgress) return;
    const pos = player.currentTime() ?? 0;
    const dur = player.duration() ?? 0;
    if (dur > 0) {
      onProgress(pos, dur);
    }
  }, [onProgress]);

  /* ---- Back handler (saves position first) ---- */
  const handleBack = useCallback(() => {
    savePosition();
    onBack();
  }, [savePosition, onBack]);

  /* ---- Toggle play / pause ---- */
  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused()) {
      player.play();
    } else {
      player.pause();
    }
  }, []);

  /* ---- Seek ---- */
  const seek = useCallback((delta: number) => {
    const player = playerRef.current;
    if (!player) return;
    const cur = player.currentTime() ?? 0;
    const dur = player.duration() ?? 0;
    player.currentTime(Math.max(0, Math.min(dur, cur + delta)));
  }, []);

  /* ---- Initialize Video.js ---- */
  useEffect(() => {
    if (!containerRef.current) return;

    // Create video element
    const videoEl = document.createElement("video-js");
    videoEl.classList.add("vjs-big-play-centered");
    videoEl.style.width = "100%";
    videoEl.style.height = "100%";
    containerRef.current.appendChild(videoEl);

    const player = videojs(videoEl, {
      controls: false,
      autoplay: true,
      preload: "metadata" as const,
      fluid: false,
      responsive: false,
      sources: [{ src, type: mimeType }],
    });

    playerRef.current = player;

    player.ready(() => {
      // Set initial position
      if (initialPosition > 0) {
        player.currentTime(initialPosition);
      }
    });

    // Event listeners
    player.on("play", () => setIsPlaying(true));
    player.on("pause", () => {
      setIsPlaying(false);
      setControlsVisible(true);
    });
    player.on("timeupdate", () => {
      setCurrentTime(player.currentTime() ?? 0);
      setDuration(player.duration() ?? 0);

      // Track buffered range
      const buffered = player.buffered();
      if (buffered && buffered.length > 0) {
        setBufferedEnd(buffered.end(buffered.length - 1));
      }
    });
    player.on("loadedmetadata", () => {
      setDuration(player.duration() ?? 0);
    });

    return () => {
      if (playerRef.current) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  /* ---- Periodic progress save ---- */
  useEffect(() => {
    if (!onProgress) return;

    progressIntervalRef.current = setInterval(() => {
      savePosition();
    }, WATCH_HISTORY_SAVE_INTERVAL_MS);

    return () => {
      if (progressIntervalRef.current)
        clearInterval(progressIntervalRef.current);
    };
  }, [onProgress, savePosition]);

  /* ---- Keyboard handler ---- */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      showControls();

      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seek(-SEEK_STEP_SECONDS);
          break;
        case "ArrowRight":
          e.preventDefault();
          seek(SEEK_STEP_SECONDS);
          break;
        case "Escape":
        case "Backspace":
          e.preventDefault();
          handleBack();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showControls, togglePlay, seek, handleBack]);

  /* ---- Auto-hide controls on play state change ---- */
  useEffect(() => {
    if (isPlaying) {
      showControls();
    }
  }, [isPlaying, showControls]);

  /* ---- Computed values ---- */
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  return (
    <div className="fixed inset-0 bg-black z-50">
      {/* Video container */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Custom overlay controls */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={showControls}
      >
        {/* Top: Back button */}
        <div className="absolute top-8 left-8">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleBack();
            }}
            className="bg-white/10 backdrop-blur rounded-full p-4 hover:bg-white/20 transition-colors"
          >
            <svg
              className="w-6 h-6 text-white"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        </div>

        {/* Center: Play / Pause */}
        <div className="absolute inset-0 flex items-center justify-center">
          <button
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            className="bg-white/10 backdrop-blur rounded-full p-6 hover:bg-white/20 transition-colors"
          >
            {isPlaying ? (
              <svg
                className="w-20 h-20 text-white"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
              </svg>
            ) : (
              <svg
                className="w-20 h-20 text-white"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>
        </div>

        {/* Bottom: Seek bar and time */}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-8 pb-8 pt-16">
          {/* Seek bar */}
          <div className="relative w-full h-2 rounded-full bg-white/20 cursor-pointer group">
            {/* Buffered range */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-white/30"
              style={{ width: `${Math.min(bufferedPercent, 100)}%` }}
            />
            {/* Progress */}
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-tv-accent"
              style={{ width: `${Math.min(progressPercent, 100)}%` }}
            />
            {/* Thumb */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-6 h-6 rounded-full bg-white shadow-lg transition-transform group-hover:scale-110"
              style={{ left: `${Math.min(progressPercent, 100)}%` }}
            />
          </div>

          {/* Time display */}
          <div className="flex justify-between mt-3 text-sm text-white/80 font-mono">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
