"use client";

import { useFocusable } from "@/lib/navigation";
import type { VideoFile, WatchHistory } from "@/types";

interface VideoCardProps {
  video: VideoFile;
  watchHistory?: WatchHistory | null;
  focusId: string;
  row: number;
  col: number;
  onSelect: () => void;
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

export function VideoCard({
  video,
  watchHistory,
  focusId,
  row,
  col,
  onSelect,
}: VideoCardProps) {
  const { ref, isFocused } = useFocusable({ id: focusId, row, col, onSelect });

  const progressPercent =
    watchHistory && watchHistory.duration > 0
      ? (watchHistory.position / watchHistory.duration) * 100
      : 0;

  return (
    <div
      ref={ref}
      data-focused={isFocused}
      onClick={onSelect}
      className={`tv-card relative w-full aspect-video rounded-card overflow-hidden cursor-pointer
        ${isFocused ? "scale-[var(--scale-focus)] shadow-tv-focus ring-2 ring-tv-focus z-10" : "scale-100 shadow-tv-card"}
        transition-all duration-focus ease-out`}
    >
      {/* Thumbnail or placeholder */}
      {video.thumbnailUrl ? (
        <img
          src={video.thumbnailUrl}
          alt={stripExtension(video.name)}
          loading="lazy"
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />
      ) : (
        <div className="absolute inset-0 w-full h-full bg-tv-card flex items-center justify-center">
          <svg
            className="w-16 h-16 text-tv-text-dim"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      )}

      {/* Title overlay with gradient */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-3 py-2">
        <p className="text-tv-xs text-tv-text truncate">
          {stripExtension(video.name)}
        </p>
      </div>

      {/* Watch progress bar */}
      {progressPercent > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-1">
          <div
            className="h-full bg-tv-progress"
            style={{ width: `${Math.min(progressPercent, 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
