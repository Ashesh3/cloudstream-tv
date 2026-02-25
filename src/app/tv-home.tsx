"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { QRCode } from "react-qrcode-logo";
import {
  FocusProvider,
  useDpad,
} from "@/lib/navigation";
import { ContentRow } from "@/components";
import { POLL_INTERVAL_MS } from "@/lib/constants";
import type { BrowseItem, CloudProvider } from "@/types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Store sessionId in both localStorage and a cookie for API routes. */
function persistSessionId(id: string) {
  localStorage.setItem("tv-session-id", id);
  document.cookie = `tv-session-id=${encodeURIComponent(id)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FolderGroup {
  connectionId: string;
  provider: string;
  email: string;
  folderName: string;
  items: BrowseItem[];
}

type ViewState = "pairing" | "loading" | "empty" | "browse";

/* ------------------------------------------------------------------ */
/*  Inner component (requires FocusProvider ancestor)                   */
/* ------------------------------------------------------------------ */

function TVHomeInner() {
  const router = useRouter();

  const [viewState, setViewState] = useState<ViewState>("loading");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [folderGroups, setFolderGroups] = useState<FolderGroup[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // D-pad navigation (no back handler on home)
  useDpad();

  /* ---- Session bootstrap ---- */
  useEffect(() => {
    const stored = localStorage.getItem("tv-session-id");
    if (stored) {
      // Ensure the cookie stays in sync with localStorage
      persistSessionId(stored);
      setSessionId(stored);
    } else {
      // Create a pairing session
      fetch("/api/pairing", { method: "POST" })
        .then((res) => res.json())
        .then((data) => {
          setPairingCode(data.code);
          setViewState("pairing");
        })
        .catch(() => {
          setViewState("empty");
        });
    }
  }, []);

  /* ---- Poll pairing status ---- */
  useEffect(() => {
    if (!pairingCode || sessionId) return;

    function checkStatus() {
      fetch(`/api/pairing/status?code=${encodeURIComponent(pairingCode!)}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.paired && data.sessionId) {
            persistSessionId(data.sessionId);
            setSessionId(data.sessionId);
            setPairingCode(null);
          }
        })
        .catch(() => {
          // Silently retry on next poll
        });
    }

    pollRef.current = setInterval(checkStatus, POLL_INTERVAL_MS);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [pairingCode, sessionId]);

  /* ---- Fetch content once session is set ---- */
  useEffect(() => {
    if (!sessionId) return;
    setViewState("loading");

    fetch("/api/browse")
      .then((res) => res.json())
      .then((data) => {
        const groups: FolderGroup[] = data.folders ?? [];
        setFolderGroups(groups);
        setViewState(groups.length > 0 ? "browse" : "empty");
      })
      .catch(() => {
        setViewState("empty");
      });
  }, [sessionId]);

  /* ---- Navigation callbacks ---- */
  const onVideoSelect = useCallback(
    (videoId: string, provider: CloudProvider, connectionId: string, mimeType: string) => {
      if (!sessionId) return;
      const params = new URLSearchParams({
        provider,
        connectionId,
        mimeType,
      });
      router.push(`/play/${encodeURIComponent(videoId)}?${params}`);
    },
    [router, sessionId]
  );

  const onFolderSelect = useCallback(
    (folderId: string, provider: CloudProvider, connectionId: string) => {
      if (!sessionId) return;
      const params = new URLSearchParams({
        provider,
        connectionId,
        name: folderId,
      });
      router.push(`/folder/${encodeURIComponent(folderId)}?${params}`);
    },
    [router, sessionId]
  );

  /* ---- Render ---- */
  return (
    <div className="min-h-screen bg-tv-bg text-tv-text">
      {/* Title bar */}
      <header className="px-tv-padding pt-8 pb-4">
        <h1 className="text-tv-xl font-bold">TV Video</h1>
      </header>

      <AnimatePresence mode="wait">
        {/* ---- Pairing Screen ---- */}
        {viewState === "pairing" && pairingCode && (
          <motion.div
            key="pairing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center"
            style={{ minHeight: "calc(100vh - 120px)" }}
          >
            <p className="text-tv-sm text-tv-text-dim mb-4">
              Scan the QR code or enter this code on your phone:
            </p>
            <div className="text-tv-2xl font-mono font-bold tracking-[0.3em] text-tv-accent">
              {pairingCode}
            </div>
            <div className="mt-6 rounded-xl overflow-hidden bg-white p-2">
              <QRCode
                value={`${window.location.origin}/setup?code=${encodeURIComponent(pairingCode)}`}
                size={200}
                qrStyle="dots"
                eyeRadius={8}
                bgColor="#FFFFFF"
                fgColor="#000000"
                quietZone={8}
              />
            </div>
            <div className="mt-6 flex items-center gap-3 text-tv-text-dim">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-tv-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-tv-accent" />
              </span>
              <span className="text-tv-sm">Waiting for connection...</span>
            </div>
          </motion.div>
        )}

        {/* ---- Loading ---- */}
        {viewState === "loading" && (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex items-center justify-center"
            style={{ minHeight: "calc(100vh - 120px)" }}
          >
            <div className="flex flex-col items-center gap-4">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tv-accent" />
              <p className="text-tv-sm text-tv-text-dim">
                Loading your videos...
              </p>
            </div>
          </motion.div>
        )}

        {/* ---- Empty State ---- */}
        {viewState === "empty" && (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center justify-center"
            style={{ minHeight: "calc(100vh - 120px)" }}
          >
            <svg
              className="w-20 h-20 text-tv-text-dim mb-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-2.625 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0 1 18 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0 1 18 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 0 1 6 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-1.5c0-.621.504-1.125 1.125-1.125m-1.125 2.625c0 .621.504 1.125 1.125 1.125m0 0A1.125 1.125 0 0 0 7.5 16.5M4.875 18.75C5.496 18.75 6 18.246 6 17.625"
              />
            </svg>
            <p className="text-tv-lg text-tv-text-dim">
              No content available
            </p>
            <p className="text-tv-sm text-tv-text-dim mt-2">
              Use your phone to connect cloud storage
            </p>
          </motion.div>
        )}

        {/* ---- Browse UI ---- */}
        {viewState === "browse" && (
          <motion.div
            key="browse"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="pb-12 overflow-y-auto"
            style={{ maxHeight: "calc(100vh - 120px)" }}
          >
            <div className="space-y-row-gap">
              {folderGroups.map((group, index) => (
                <ContentRow
                  key={`${group.connectionId}-${group.folderName}`}
                  title={group.folderName}
                  items={group.items}
                  rowIndex={index}
                  onVideoSelect={onVideoSelect}
                  onFolderSelect={onFolderSelect}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Exported wrapper with FocusProvider                                 */
/* ------------------------------------------------------------------ */

export default function TVHome() {
  return (
    <FocusProvider>
      <TVHomeInner />
    </FocusProvider>
  );
}
