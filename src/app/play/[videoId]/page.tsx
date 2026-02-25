"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { TVPlayer } from "@/components/tv-player";
import type { CloudProvider, WatchHistory } from "@/types";

export default function PlayPage() {
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();

  const videoId = params.videoId as string;
  const provider = (searchParams.get("provider") ?? "google") as CloudProvider;
  const connectionId = searchParams.get("connectionId") ?? "";
  const mimeType = searchParams.get("mimeType") ?? "video/mp4";

  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [initialPosition, setInitialPosition] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Fetch stream URL and watch history in parallel ---- */
  useEffect(() => {
    if (!videoId || !connectionId) return;

    setLoading(true);
    setError(null);

    const streamParams = new URLSearchParams({
      fileId: videoId,
      provider,
      connectionId,
    });

    const historyParams = new URLSearchParams({
      fileId: videoId,
    });

    Promise.all([
      fetch(`/api/stream-url?${streamParams}`).then((res) => {
        if (!res.ok) throw new Error("Failed to get stream URL");
        return res.json();
      }),
      fetch(`/api/watch-history?${historyParams}`)
        .then((res) => res.json())
        .catch(() => ({ history: null })),
    ])
      .then(([streamData, historyData]) => {
        setStreamUrl(streamData.url);
        const history = historyData.history as WatchHistory | null;
        if (history && history.position > 0) {
          setInitialPosition(history.position);
        }
      })
      .catch((err) => {
        setError(
          err instanceof Error ? err.message : "Failed to load video"
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, [videoId, provider, connectionId]);

  /* ---- Progress save callback ---- */
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (!videoId) return;

      fetch("/api/watch-history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: videoId,
          provider,
          position,
          duration,
        }),
      }).catch(() => {
        // Silently fail progress saves
      });
    },
    [videoId, provider]
  );

  /* ---- Loading state ---- */
  if (loading) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tv-accent" />
          <p className="text-tv-sm text-tv-text-dim">Loading video...</p>
        </div>
      </div>
    );
  }

  /* ---- Error state ---- */
  if (error || !streamUrl) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="text-center">
          <p className="text-tv-lg text-tv-warning mb-2">
            Unable to play video
          </p>
          <p className="text-tv-sm text-tv-text-dim mb-6">
            {error ?? "Stream URL not available"}
          </p>
          <button
            onClick={() => router.back()}
            className="bg-white/10 backdrop-blur text-white px-6 py-3 rounded-lg hover:bg-white/20 transition-colors"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  /* ---- Player ---- */
  return (
    <TVPlayer
      src={streamUrl}
      mimeType={mimeType}
      initialPosition={initialPosition}
      onBack={() => router.back()}
      onProgress={handleProgress}
    />
  );
}
