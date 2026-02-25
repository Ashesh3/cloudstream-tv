"use client";

import { useFocusable } from "@/lib/navigation";
import type { FolderItem } from "@/types";

interface FolderCardProps {
  folder: FolderItem;
  focusId: string;
  row: number;
  col: number;
  onSelect: () => void;
}

export function FolderCard({
  folder,
  focusId,
  row,
  col,
  onSelect,
}: FolderCardProps) {
  const { ref, isFocused } = useFocusable({ id: focusId, row, col, onSelect });

  return (
    <div
      ref={ref}
      data-focused={isFocused}
      onClick={onSelect}
      className={`tv-card relative w-[300px] h-[170px] flex-shrink-0 rounded-card overflow-hidden cursor-pointer
        bg-gradient-to-b from-tv-card to-tv-surface
        flex flex-col items-center justify-center gap-2
        ${isFocused ? "scale-[var(--scale-focus)] shadow-tv-focus ring-2 ring-tv-focus z-10" : "scale-100 shadow-tv-card"}
        transition-all duration-focus ease-out`}
    >
      {/* Folder icon */}
      <svg
        className={`w-16 h-16 transition-colors duration-focus ${isFocused ? "text-tv-focus" : "text-tv-text-dim"}`}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
      </svg>

      {/* Folder name */}
      <p className="text-tv-sm text-center truncate max-w-[260px] px-2">
        {folder.name}
      </p>
    </div>
  );
}
