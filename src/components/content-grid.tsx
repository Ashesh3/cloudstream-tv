"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { VideoCard } from "./video-card";
import { FolderCard } from "./folder-card";
import type { BrowseItem, CloudProvider, WatchHistory } from "@/types";

/**
 * Tailwind breakpoints used by the grid classes:
 *   grid-cols-2  (default, < 768px)
 *   md:grid-cols-3  (>= 768px)
 *   lg:grid-cols-4  (>= 1024px)
 *   xl:grid-cols-5  (>= 1280px)
 *
 * Returns the number of columns currently active so D-pad row/col
 * calculations stay in sync with the CSS grid.
 */
function useColumns(): number {
  const [columns, setColumns] = useState(5); // SSR default (TV is typically xl)

  useEffect(() => {
    function compute() {
      if (window.matchMedia("(min-width: 1280px)").matches) return 5;
      if (window.matchMedia("(min-width: 1024px)").matches) return 4;
      if (window.matchMedia("(min-width: 768px)").matches) return 3;
      return 2;
    }

    setColumns(compute());

    function handleResize() {
      setColumns(compute());
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return columns;
}

interface ContentGridProps {
  items: BrowseItem[];
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
    // Folders first
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    // Alphabetical within each type
    return a.name.localeCompare(b.name);
  });
}

export function ContentGrid({
  items,
  watchHistories,
  onVideoSelect,
  onFolderSelect,
}: ContentGridProps) {
  const sorted = sortItems(items);
  const columns = useColumns();

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-card-gap px-tv-padding py-4">
      {sorted.map((item, index) => {
        const row = Math.floor(index / columns) + 1; // row 0 reserved for breadcrumb
        const col = index % columns;
        const focusId = `grid-r${row}-c${col}`;

        return (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{
              delay: index * 0.03,
              duration: 0.3,
              ease: "easeOut",
            }}
          >
            {item.type === "folder" ? (
              <FolderCard
                folder={item}
                focusId={focusId}
                row={row}
                col={col}
                onSelect={() =>
                  onFolderSelect(item.id, item.provider, item.connectionId)
                }
              />
            ) : (
              <VideoCard
                video={item}
                watchHistory={watchHistories?.get(item.id) ?? null}
                focusId={focusId}
                row={row}
                col={col}
                onSelect={() =>
                  onVideoSelect(item.id, item.provider, item.connectionId, item.mimeType)
                }
              />
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
