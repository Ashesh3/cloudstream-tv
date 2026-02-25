"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { FocusProvider, useDpad } from "@/lib/navigation";
import { ContentGrid, Breadcrumb } from "@/components";
import type { BrowseItem, CloudProvider } from "@/types";

/* ------------------------------------------------------------------ */
/*  Inner component (requires FocusProvider ancestor)                   */
/* ------------------------------------------------------------------ */

function FolderViewInner() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();

  const folderId = params.folderId as string;
  const provider = searchParams.get("provider") ?? "";
  const connectionId = searchParams.get("connectionId") ?? "";
  const folderName = searchParams.get("name") ?? folderId;

  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus container so D-pad works immediately
  useEffect(() => {
    if (!loading) containerRef.current?.focus();
  }, [loading]);

  // D-pad with back navigation
  useDpad({
    onBack: () => router.back(),
  });

  /* ---- Fetch folder contents ---- */
  useEffect(() => {
    if (!connectionId || !folderId) return;

    setLoading(true);
    setError(null);

    const qs = new URLSearchParams({ connectionId, folderId });
    fetch(`/api/browse?${qs}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load folder contents");
        return res.json();
      })
      .then((data) => {
        setItems(data.items ?? []);
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Failed to load folder contents"
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [connectionId, folderId]);

  /* ---- Navigation callbacks ---- */
  const onVideoSelect = useCallback(
    (videoId: string, videoProvider: CloudProvider, videoConnectionId: string, mimeType: string) => {
      const qs = new URLSearchParams({
        provider: videoProvider,
        connectionId: videoConnectionId,
        mimeType,
      });
      router.push(`/play/${encodeURIComponent(videoId)}?${qs}`);
    },
    [router]
  );

  const onFolderSelect = useCallback(
    (
      subFolderId: string,
      folderProvider: CloudProvider,
      folderConnectionId: string
    ) => {
      const qs = new URLSearchParams({
        provider: folderProvider,
        connectionId: folderConnectionId,
        name: subFolderId,
      });
      router.push(`/folder/${encodeURIComponent(subFolderId)}?${qs}`);
    },
    [router]
  );

  /* ---- Breadcrumb ---- */
  const breadcrumbSegments = [
    { label: "Home", href: "/" },
    { label: decodeURIComponent(folderName), href: "#" },
  ];

  function handleBreadcrumbNavigate(href: string) {
    if (href === "/") {
      router.push("/");
    } else {
      // Current folder — no-op
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -40 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      ref={containerRef}
      tabIndex={-1}
      className="min-h-screen bg-tv-bg text-tv-text outline-none"
    >
      {/* Breadcrumb */}
      <Breadcrumb
        segments={breadcrumbSegments}
        onNavigate={handleBreadcrumbNavigate}
      />

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center" style={{ minHeight: "calc(100vh - 80px)" }}>
          <div className="flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tv-accent" />
            <p className="text-tv-sm text-tv-text-dim">Loading folder...</p>
          </div>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="flex items-center justify-center" style={{ minHeight: "calc(100vh - 80px)" }}>
          <div className="text-center">
            <p className="text-tv-lg text-tv-warning mb-2">Error</p>
            <p className="text-tv-sm text-tv-text-dim">{error}</p>
          </div>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && items.length === 0 && (
        <div className="flex items-center justify-center" style={{ minHeight: "calc(100vh - 80px)" }}>
          <div className="text-center">
            <svg
              className="w-16 h-16 text-tv-text-dim mx-auto mb-4"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
            <p className="text-tv-lg text-tv-text-dim">This folder is empty</p>
          </div>
        </div>
      )}

      {/* Content grid */}
      {!loading && !error && items.length > 0 && (
        <ContentGrid
          items={items}
          onVideoSelect={onVideoSelect}
          onFolderSelect={onFolderSelect}
        />
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page export with FocusProvider wrapper                              */
/* ------------------------------------------------------------------ */

export default function FolderPage() {
  return (
    <FocusProvider>
      <FolderViewInner />
    </FocusProvider>
  );
}
