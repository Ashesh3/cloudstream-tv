"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { TVPlayer } from "@/components/tv-player";
import { useTransmux } from "@/lib/use-transmux";
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

  const {
    status: transmuxStatus,
    progress: transmuxProgress,
    blobUrl: playableUrl,
    error: transmuxError,
    transmux,
    cleanup,
  } = useTransmux();

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

  /* ---- Transmux if needed once stream URL is available ---- */
  useEffect(() => {
    if (!streamUrl || transmuxStatus !== "idle") return;
    transmux(streamUrl, mimeType).catch(() => {
      // error is captured in transmuxError state
    });
  }, [streamUrl, mimeType, transmux, transmuxStatus]);

  /* ---- Cleanup blob URL on unmount ---- */
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

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

  /* ---- Loading / Transmuxing state ---- */
  if (loading || transmuxStatus === "loading" || transmuxStatus === "transmuxing" || transmuxStatus === "idle") {
    const isTransmuxing = transmuxStatus === "transmuxing";
    const progressPercent = Math.round(transmuxProgress * 100);

    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tv-accent" />
          <p className="text-tv-sm text-tv-text-dim">
            {isTransmuxing
              ? `Converting video... ${progressPercent}%`
              : "Loading video..."}
          </p>
          {isTransmuxing && (
            <div className="w-64 h-2 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-tv-accent rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---- Error state ---- */
  if (error || transmuxError || !playableUrl) {
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center z-50">
        <div className="text-center">
          <p className="text-tv-lg text-tv-warning mb-2">
            Unable to play video
          </p>
          <p className="text-tv-sm text-tv-text-dim mb-6">
            {error ?? transmuxError ?? "Stream URL not available"}
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
      src={playableUrl}
      mimeType="video/mp4"
      initialPosition={initialPosition}
      onBack={() => router.back()}
      onProgress={handleProgress}
    />
  );
}
