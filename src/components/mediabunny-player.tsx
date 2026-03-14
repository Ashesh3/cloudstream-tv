"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONTROLS_AUTO_HIDE_MS,
  SEEK_STEP_SECONDS,
  WATCH_HISTORY_SAVE_INTERVAL_MS,
} from "@/lib/constants";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface MediaBunnyPlayerProps {
  src: string;
  initialPosition?: number;
  onBack: () => void;
  onProgress?: (position: number, duration: number) => void;
  onError?: () => void;
}

type MediaBunnyModule = typeof import("mediabunny");

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
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function MediaBunnyPlayer({
  src,
  initialPosition = 0,
  onBack,
  onProgress,
  onError,
}: MediaBunnyPlayerProps) {
  /* ---- UI state (React-rendered) ---- */
  const [controlsVisible, setControlsVisible] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Refs for mutable playback state (synchronous access) ---- */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const playingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioContextStartTimeRef = useRef(0);
  const playbackTimeAtStartRef = useRef(initialPosition);
  const totalDurationRef = useRef(0);
  const videoWidthRef = useRef(1920);
  const videoHeightRef = useRef(1080);

  // Async generator iterators
  const videoIteratorRef = useRef<AsyncGenerator | null>(null);
  const audioIteratorRef = useRef<AsyncGenerator | null>(null);

  // mediabunny objects
  const inputRef = useRef<InstanceType<MediaBunnyModule["Input"]> | null>(null);
  const canvasSinkRef = useRef<InstanceType<MediaBunnyModule["CanvasSink"]> | null>(null);
  const audioBufferSinkRef = useRef<InstanceType<MediaBunnyModule["AudioBufferSink"]> | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  // Video render loop
  const nextFrameRef = useRef<{ canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number; duration: number } | null>(null);
  const rafIdRef = useRef<number>(0);

  // Audio playback
  const audioNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const audioLoopIdRef = useRef(0); // Incremented to cancel stale audio loops

  // Controls auto-hide
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Progress save interval
  const progressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track whether component is mounted
  const mountedRef = useRef(true);

  // onProgress / onBack refs to avoid stale closures
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /* ---- getPlaybackTime: master clock using AudioContext ---- */
  const getPlaybackTime = useCallback(() => {
    if (playingRef.current && audioContextRef.current) {
      return (
        audioContextRef.current.currentTime -
        audioContextStartTimeRef.current +
        playbackTimeAtStartRef.current
      );
    }
    return playbackTimeAtStartRef.current;
  }, []);

  /* ---- Show / hide controls ---- */
  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    hideTimeoutRef.current = setTimeout(() => {
      if (playingRef.current) {
        setControlsVisible(false);
      }
    }, CONTROLS_AUTO_HIDE_MS);
  }, []);

  /* ---- Save position helper ---- */
  const savePosition = useCallback(() => {
    const cb = onProgressRef.current;
    if (!cb) return;
    const pos = getPlaybackTime();
    const dur = totalDurationRef.current;
    if (dur > 0) {
      cb(pos, dur);
    }
  }, [getPlaybackTime]);

  /* ---- Stop all scheduled audio nodes ---- */
  const stopAllAudio = useCallback(() => {
    for (const node of audioNodesRef.current) {
      try {
        node.stop();
      } catch {
        // Already stopped
      }
    }
    audioNodesRef.current = [];
  }, []);

  /* ---- Start video iterator from a given time ---- */
  const startVideoIterator = useCallback(async (startTime: number) => {
    // Dispose old iterator
    if (videoIteratorRef.current) {
      try {
        await videoIteratorRef.current.return(undefined);
      } catch {
        // ignore
      }
    }

    if (!canvasSinkRef.current) return;

    const iterator = canvasSinkRef.current.canvases(startTime);
    videoIteratorRef.current = iterator;

    // Get the first frame
    const result = await iterator.next();
    if (!result.done && result.value) {
      nextFrameRef.current = result.value as { canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number; duration: number };
    } else {
      nextFrameRef.current = null;
    }
  }, []);

  /* ---- Update next frame (advance video iterator, skip past frames) ---- */
  const updateNextFrame = useCallback(async () => {
    const iterator = videoIteratorRef.current;
    if (!iterator) return;

    try {
      const result = await iterator.next();
      if (result.done) {
        nextFrameRef.current = null;
        return;
      }
      const frame = result.value as { canvas: HTMLCanvasElement | OffscreenCanvas; timestamp: number; duration: number };

      // If frame is already in the past, skip ahead
      const now = getPlaybackTime();
      if (frame.timestamp + frame.duration < now) {
        // Frame is old, try to get a more recent one
        nextFrameRef.current = frame; // store it temporarily
        // Don't recurse deeply; let the render loop handle it
      } else {
        nextFrameRef.current = frame;
      }
    } catch {
      // Iterator may have been closed
      nextFrameRef.current = null;
    }
  }, [getPlaybackTime]);

  /* ---- Video render loop ---- */
  const renderLoop = useCallback(() => {
    if (!mountedRef.current) return;

    const displayCanvas = displayCanvasRef.current;
    if (!displayCanvas) {
      rafIdRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    const ctx = displayCanvas.getContext("2d");
    if (!ctx) {
      rafIdRef.current = requestAnimationFrame(renderLoop);
      return;
    }

    if (playingRef.current) {
      const now = getPlaybackTime();
      setCurrentTime(now);

      const frame = nextFrameRef.current;
      if (frame && frame.timestamp <= now) {
        // Draw the frame
        ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
        ctx.drawImage(
          frame.canvas as HTMLCanvasElement,
          0,
          0,
          displayCanvas.width,
          displayCanvas.height
        );

        // Request next frame from iterator
        updateNextFrame();
      }
    }

    rafIdRef.current = requestAnimationFrame(renderLoop);
  }, [getPlaybackTime, updateNextFrame]);

  /* ---- Start audio playback loop ---- */
  const startAudioLoop = useCallback(async (startTime: number) => {
    // Dispose old iterator
    if (audioIteratorRef.current) {
      try {
        await audioIteratorRef.current.return(undefined);
      } catch {
        // ignore
      }
    }

    if (!audioBufferSinkRef.current || !audioContextRef.current) return;

    // Increment loop ID to invalidate any previous audio loop
    audioLoopIdRef.current++;
    const loopId = audioLoopIdRef.current;

    const iterator = audioBufferSinkRef.current.buffers(startTime);
    audioIteratorRef.current = iterator;

    const audioContext = audioContextRef.current;
    const gainNode = gainNodeRef.current;
    if (!gainNode) return;

    // Run the audio scheduling loop
    (async () => {
      try {
        for await (const wrappedBuffer of iterator) {
          // Check if this loop has been superseded
          if (audioLoopIdRef.current !== loopId || !mountedRef.current) {
            break;
          }

          // Check if still playing
          if (!playingRef.current) {
            break;
          }

          const { buffer, timestamp } = wrappedBuffer as { buffer: AudioBuffer; timestamp: number; duration: number };

          const node = audioContext.createBufferSource();
          node.buffer = buffer;
          node.connect(gainNode);

          const startTimestamp =
            audioContextStartTimeRef.current + timestamp - playbackTimeAtStartRef.current;

          if (startTimestamp >= audioContext.currentTime) {
            node.start(startTimestamp);
          } else {
            const offset = audioContext.currentTime - startTimestamp;
            if (offset < buffer.duration) {
              node.start(audioContext.currentTime, offset);
            } else {
              // This buffer is entirely in the past, skip it
              continue;
            }
          }

          audioNodesRef.current.push(node);

          // Clean up finished nodes periodically
          if (audioNodesRef.current.length > 20) {
            audioNodesRef.current = audioNodesRef.current.filter((n) => {
              try {
                // If we can still access it, it's valid. We'll keep the recent ones.
                return true;
              } catch {
                return false;
              }
            });
            // Keep only the last 10
            if (audioNodesRef.current.length > 10) {
              audioNodesRef.current = audioNodesRef.current.slice(-10);
            }
          }

          // Throttle if audio is >1 second ahead of playback time
          const currentPlaybackTime = getPlaybackTime();
          if (timestamp - currentPlaybackTime >= 1) {
            await new Promise<void>((resolve) => {
              const id = setInterval(() => {
                if (
                  audioLoopIdRef.current !== loopId ||
                  !mountedRef.current ||
                  !playingRef.current
                ) {
                  clearInterval(id);
                  resolve();
                  return;
                }
                if (timestamp - getPlaybackTime() < 1) {
                  clearInterval(id);
                  resolve();
                }
              }, 50);
            });
          }
        }
      } catch {
        // Iterator closed or error, that's fine
      }
    })();
  }, [getPlaybackTime]);

  /* ---- Play ---- */
  const play = useCallback(async () => {
    if (playingRef.current) return;

    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    audioContextStartTimeRef.current = audioContext.currentTime;
    playingRef.current = true;
    setIsPlaying(true);

    // Start audio loop from current position
    await startAudioLoop(playbackTimeAtStartRef.current);

    showControls();
  }, [startAudioLoop, showControls]);

  /* ---- Pause ---- */
  const pause = useCallback(() => {
    if (!playingRef.current) return;

    // Record current position
    playbackTimeAtStartRef.current = getPlaybackTime();
    playingRef.current = false;
    setIsPlaying(false);
    setControlsVisible(true);

    // Stop all audio
    stopAllAudio();
    audioLoopIdRef.current++; // Cancel audio loop

    // Suspend audio context to stop scheduling
    if (audioContextRef.current && audioContextRef.current.state === "running") {
      audioContextRef.current.suspend();
    }
  }, [getPlaybackTime, stopAllAudio]);

  /* ---- Toggle play / pause ---- */
  const togglePlay = useCallback(() => {
    if (playingRef.current) {
      pause();
    } else {
      play();
    }
  }, [play, pause]);

  /* ---- Seek ---- */
  const seekToTime = useCallback(
    async (seconds: number) => {
      const clampedSeconds = Math.max(0, Math.min(seconds, totalDurationRef.current));
      const wasPlaying = playingRef.current;

      if (wasPlaying) {
        pause();
      }

      playbackTimeAtStartRef.current = clampedSeconds;
      setCurrentTime(clampedSeconds);

      // Restart video iterator from the new time
      await startVideoIterator(clampedSeconds);

      // Draw the first frame at the new position
      const displayCanvas = displayCanvasRef.current;
      const frame = nextFrameRef.current;
      if (displayCanvas && frame) {
        const ctx = displayCanvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);
          ctx.drawImage(
            frame.canvas as HTMLCanvasElement,
            0,
            0,
            displayCanvas.width,
            displayCanvas.height
          );
        }
      }

      if (wasPlaying && clampedSeconds < totalDurationRef.current) {
        await play();
      }
    },
    [pause, play, startVideoIterator]
  );

  /* ---- Seek by delta ---- */
  const seek = useCallback(
    (delta: number) => {
      const current = getPlaybackTime();
      seekToTime(current + delta);
    },
    [getPlaybackTime, seekToTime]
  );

  /* ---- Back handler (saves position first) ---- */
  const handleBack = useCallback(() => {
    savePosition();
    onBackRef.current();
  }, [savePosition]);

  /* ---- Initialize mediabunny and start playback ---- */
  useEffect(() => {
    let disposed = false;

    async function init() {
      try {
        setLoading(true);
        setError(null);

        const mb = await import("mediabunny");

        if (disposed) return;

        // Create input
        const input = new mb.Input({
          source: new mb.UrlSource(src),
          formats: mb.ALL_FORMATS,
        });
        inputRef.current = input;

        // Get tracks and duration in parallel
        const [videoTrack, audioTrack, totalDuration] = await Promise.all([
          input.getPrimaryVideoTrack(),
          input.getPrimaryAudioTrack(),
          input.computeDuration(),
        ]);

        if (disposed) return;

        if (!videoTrack) {
          // No video track — fall back to native player
          if (onErrorRef.current) {
            onErrorRef.current();
            return;
          }
          setError("No video track found in this file");
          setLoading(false);
          return;
        }

        // Check if WebCodecs can decode this video codec
        if (videoTrack.codec === null || !(await videoTrack.canDecode())) {
          // Codec not supported by WebCodecs — fall back to native <video> player
          // (TV browsers often have hardware decoders for HEVC/etc. that WebCodecs can't access)
          if (onErrorRef.current) {
            onErrorRef.current();
            return;
          }
          setError("This video codec is not supported by the browser's WebCodecs API");
          setLoading(false);
          return;
        }

        // Check audio track decodability (audio-only failure is non-fatal, just skip audio)
        let usableAudioTrack = audioTrack;
        if (audioTrack && (audioTrack.codec === null || !(await audioTrack.canDecode()))) {
          usableAudioTrack = null;
        }

        totalDurationRef.current = totalDuration;
        setDuration(totalDuration);

        videoWidthRef.current = videoTrack.displayWidth;
        videoHeightRef.current = videoTrack.displayHeight;

        // Set canvas dimensions
        const displayCanvas = displayCanvasRef.current;
        if (displayCanvas) {
          displayCanvas.width = videoTrack.displayWidth;
          displayCanvas.height = videoTrack.displayHeight;
        }

        // Create canvas sink
        const canvasSink = new mb.CanvasSink(videoTrack, {
          poolSize: 2,
          fit: "contain",
        });
        canvasSinkRef.current = canvasSink;

        // Create audio buffer sink and audio context
        if (usableAudioTrack) {
          const audioContext = new AudioContext({
            sampleRate: usableAudioTrack.sampleRate,
          });
          audioContextRef.current = audioContext;

          const gainNode = audioContext.createGain();
          gainNode.gain.value = 1;
          gainNode.connect(audioContext.destination);
          gainNodeRef.current = gainNode;

          const audioBufferSink = new mb.AudioBufferSink(usableAudioTrack);
          audioBufferSinkRef.current = audioBufferSink;
        } else {
          // No audio track; create a basic AudioContext for timing
          const audioContext = new AudioContext();
          audioContextRef.current = audioContext;
        }

        // Set initial position
        const startTime = initialPosition > 0 ? initialPosition : 0;
        playbackTimeAtStartRef.current = startTime;
        setCurrentTime(startTime);

        // Start video iterator
        await startVideoIterator(startTime);

        if (disposed) return;

        // Draw the first frame
        const frame = nextFrameRef.current;
        if (displayCanvas && frame) {
          const ctx = displayCanvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(
              frame.canvas as HTMLCanvasElement,
              0,
              0,
              displayCanvas.width,
              displayCanvas.height
            );
          }
        }

        setLoading(false);

        // Start render loop
        rafIdRef.current = requestAnimationFrame(renderLoop);

        // Auto-play
        // Small delay to ensure the audio context can be resumed (user gesture required)
        // We'll rely on the first interaction or try immediately
        try {
          await play();
        } catch {
          // AudioContext may need user interaction to resume; that's fine,
          // user can click play
        }
      } catch (err) {
        if (!disposed) {
          // Try falling back to native player
          if (onErrorRef.current) {
            onErrorRef.current();
            return;
          }
          setError(
            err instanceof Error ? err.message : "Failed to initialize player"
          );
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      disposed = true;
      mountedRef.current = false;

      // Cancel render loop
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }

      // Stop audio
      stopAllAudio();
      audioLoopIdRef.current++;

      // Close iterators
      if (videoIteratorRef.current) {
        videoIteratorRef.current.return(undefined).catch(() => {});
      }
      if (audioIteratorRef.current) {
        audioIteratorRef.current.return(undefined).catch(() => {});
      }

      // Close audio context
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(() => {});
        audioContextRef.current = null;
      }

      // Dispose input
      if (inputRef.current) {
        inputRef.current.dispose();
        inputRef.current = null;
      }

      // Clear hide timeout
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }

      // Clear progress interval
      if (progressIntervalRef.current) {
        clearInterval(progressIntervalRef.current);
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

  /* ---- Seek to position (click on seek bar) ---- */
  const seekToPosition = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.stopPropagation();
      const bar = e.currentTarget;
      const rect = bar.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(1, (e.clientX - rect.left) / rect.width)
      );
      const dur = totalDurationRef.current;
      seekToTime(fraction * dur);
      showControls();
    },
    [seekToTime, showControls]
  );

  /* ---- Computed values ---- */
  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;

  /* ---- Loading state ---- */
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tv-accent" />
          <p className="text-tv-sm text-tv-text-dim">Initializing player...</p>
        </div>
      </div>
    );
  }

  /* ---- Error state ---- */
  if (error) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="text-center">
          <p className="text-tv-lg text-tv-warning mb-2">
            Unable to play video
          </p>
          <p className="text-tv-sm text-tv-text-dim mb-6">{error}</p>
          <button
            onClick={() => onBackRef.current()}
            className="bg-white/10 backdrop-blur text-white px-6 py-3 rounded-lg hover:bg-white/20 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-black z-50">
      {/* Video canvas */}
      <canvas
        ref={displayCanvasRef}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          position: "absolute",
          inset: 0,
        }}
      />

      {/* Custom overlay controls */}
      <div
        className={`absolute inset-0 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onMouseMove={showControls}
      >
        {/* Top: Back button */}
        <div className="absolute top-8 left-8 z-10">
          <button
            onClick={handleBack}
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
            onClick={togglePlay}
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
          <div
            className="relative w-full h-5 rounded-full cursor-pointer group"
            onClick={seekToPosition}
          >
            <div className="absolute inset-y-[9px] inset-x-0 h-2 rounded-full bg-white/20" />
            {/* Progress */}
            <div
              className="absolute inset-y-[9px] left-0 h-2 rounded-full bg-tv-accent"
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
