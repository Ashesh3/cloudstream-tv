"use client";

import { motion } from "framer-motion";
import { VideoCard } from "./video-card";
import { FolderCard } from "./folder-card";
import type { BrowseItem, CloudProvider, WatchHistory } from "@/types";

interface ContentRowProps {
  title: string;
  items: BrowseItem[];
  rowIndex: number;
  watchHistories?: Map<string, WatchHistory>;
  onVideoSelect: (
    videoId: string,
    provider: CloudProvider,
    connectionId: string,
    mimeType: string
  ) => void;
  onFolderSelect: (
    folderId: string,
    provider: CloudProvider,
    connectionId: string
  ) => void;
}

function sortItems(items: BrowseItem[]): BrowseItem[] {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export function ContentRow({
  title,
  items,
  rowIndex,
  watchHistories,
  onVideoSelect,
  onFolderSelect,
}: ContentRowProps) {
  const sorted = sortItems(items);
  const COLUMNS = 5;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: rowIndex * 0.1, duration: 0.4, ease: "easeOut" }}
    >
      <h2 className="text-tv-lg font-semibold px-tv-padding mb-2">{title}</h2>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-card-gap px-tv-padding pb-4">
        {sorted.map((item, colIndex) => {
          const row = rowIndex * 100 + Math.floor(colIndex / COLUMNS);
          const col = colIndex % COLUMNS;
          const focusId = `row${rowIndex}-col${colIndex}`;

          if (item.type === "folder") {
            return (
              <FolderCard
                key={`folder-${item.id}`}
                folder={item}
                focusId={focusId}
                row={row}
                col={col}
                onSelect={() =>
                  onFolderSelect(item.id, item.provider, item.connectionId)
                }
              />
            );
          }

          return (
            <VideoCard
              key={`video-${item.id}`}
              video={item}
              watchHistory={watchHistories?.get(item.id) ?? null}
              focusId={focusId}
              row={row}
              col={col}
              onSelect={() =>
                onVideoSelect(item.id, item.provider, item.connectionId, item.mimeType)
              }
            />
          );
        })}
      </div>
    </motion.div>
  );
}
