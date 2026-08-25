"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { QRCode } from "react-qrcode-logo";
import {
  FocusProvider,
  useDpad,
  useFocusable,
  useFocusContext,
} from "@/lib/navigation";
import { ContentRow } from "@/components";
import {
  clearStoredSessionId,
  fetchWithSession,
  getStoredSessionId,
  storeSessionId,
} from "@/lib/client/session";
import {
  completeReconfigure,
  dismissReconfigure,
  EMPTY_RECONFIGURE_STATE,
  expireReconfigure,
  shouldPollReconfigure,
  type ReconfigureState,
} from "@/lib/client/reconfigure-state";
import { POLL_INTERVAL_MS } from "@/lib/constants";
import type { BrowseItem, CloudProvider } from "@/types";

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

function ReconfigureButton({ onSelect }: { onSelect: () => void }) {
  const { ref, isFocused } = useFocusable({
    id: "reconfigure",
    row: -1,
    col: 0,
    autoFocus: false,
    onSelect,
  });

  return (
    <div ref={ref}>
      <button
        type="button"
        onClick={onSelect}
        className={`rounded-xl border px-5 py-3 text-tv-sm font-semibold transition-colors hover:border-red-500 hover:bg-red-600 hover:text-white ${
          isFocused
            ? "border-red-500 bg-red-600 text-white"
            : "border-tv-border bg-tv-surface text-tv-text"
        }`}
        title="Manage connected cloud storage"
      >
        Reconfigure
      </button>
    </div>
  );
}

function ReconfigureModal({
  code,
  error,
  onClose,
}: {
  code: string | null;
  error: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    function blockBackgroundRemoteInput(event: KeyboardEvent) {
      if (
        ![
          "ArrowUp",
          "ArrowDown",
          "ArrowLeft",
          "ArrowRight",
          "Enter",
          " ",
          "Escape",
          "Backspace",
        ].includes(event.key)
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape" || event.key === "Backspace") {
        onClose();
      }
    }

    window.addEventListener("keydown", blockBackgroundRemoteInput, true);
    return () => {
      window.removeEventListener("keydown", blockBackgroundRemoteInput, true);
    };
  }, [onClose]);

  const setupUrl = code
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/setup?code=${encodeURIComponent(code)}`
    : "";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.94 }}
        className="relative w-full max-w-xl rounded-2xl border border-tv-border bg-tv-surface p-8 text-center shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-lg px-3 py-2 text-tv-sm text-tv-text-dim hover:bg-tv-card hover:text-white"
          aria-label="Close reconfigure dialog"
        >
          Close
        </button>

        <h2 className="mb-2 text-tv-lg font-bold">Reconfigure cloud storage</h2>
        <p className="mb-6 text-tv-sm text-tv-text-dim">
          Scan this code to add, edit, or remove cloud sources. Your current
          TV session stays connected.
        </p>

        {error ? (
          <p className="rounded-xl bg-red-600/15 px-4 py-3 text-tv-sm text-red-400">
            {error}
          </p>
        ) : code ? (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-xl bg-white p-2">
              <QRCode
                value={setupUrl}
                size={200}
                qrStyle="dots"
                eyeRadius={8}
                bgColor="#FFFFFF"
                fgColor="#000000"
                quietZone={8}
              />
            </div>
            <div className="font-mono text-tv-base font-bold tracking-widest text-tv-accent">
              {code}
            </div>
            <p className="text-tv-xs text-tv-text-dim">
              Press Back on the remote to dismiss
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-10">
            <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-tv-accent" />
            <p className="text-tv-sm text-tv-text-dim">Creating secure QR code...</p>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inner component (requires FocusProvider ancestor)                   */
/* ------------------------------------------------------------------ */

function TVHomeInner() {
  const router = useRouter();
  const { focusedId, setFocus } = useFocusContext();

  const [viewState, setViewState] = useState<ViewState>("loading");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [folderGroups, setFolderGroups] = useState<FolderGroup[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [pairingPollToken, setPairingPollToken] = useState<string | null>(null);
  const [reconfigureState, setReconfigureState] = useState<ReconfigureState>(
    EMPTY_RECONFIGURE_STATE
  );
  const focusBeforeReconfigureRef = useRef<string | null>(null);
  const lastContentFocusRef = useRef<string | null>(null);
  const focusedIdRef = useRef<string | null>(focusedId);

  // D-pad navigation (no back handler on home)
  useDpad();

  /* ---- Session bootstrap ---- */
  useEffect(() => {
    const stored = getStoredSessionId();
    if (stored) {
      // Reissue the HTTP-only cookie after cookie clearing/access-code login.
      fetchWithSession("/api/session", { method: "POST" })
        .then((res) => {
          if (res.status === 404) {
            clearStoredSessionId();
            window.location.reload();
            return;
          }
          setSessionId(stored);
        })
        .catch(() => {
          // The explicit session header still lets TV API calls recover when
          // this browser rejects cookies entirely.
          setSessionId(stored);
        });
    } else {
      // Create a pairing session
      fetch("/api/pairing", { method: "POST" })
        .then((res) => res.json())
        .then((data) => {
          setPairingCode(data.code);
          setPairingPollToken(data.pollToken);
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
      fetch(`/api/pairing/status?code=${encodeURIComponent(pairingCode!)}`, {
        headers: pairingPollToken
          ? { "X-Pairing-Poll-Token": pairingPollToken }
          : {},
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.paired && data.sessionId) {
            storeSessionId(data.sessionId);
            setSessionId(data.sessionId);
            setPairingCode(null);
            setPairingPollToken(null);
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
  }, [pairingCode, pairingPollToken, sessionId]);

  /* ---- Fetch content once session is set ---- */
  useEffect(() => {
    if (!sessionId) return;
    setViewState("loading");

    fetchWithSession("/api/browse")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to browse files");
        return res.json();
      })
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

  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus container so D-pad works immediately without mouse interaction
  useEffect(() => {
    containerRef.current?.focus();
  }, [viewState]);

  useEffect(() => {
    focusedIdRef.current = focusedId;
    if (focusedId && focusedId !== "reconfigure") {
      lastContentFocusRef.current = focusedId;
    }
  }, [focusedId]);

  const loadContent = useCallback(() => {
    return fetchWithSession("/api/browse")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to browse files");
        return res.json();
      })
      .then((data) => {
        const groups: FolderGroup[] = data.folders ?? [];
        setFolderGroups(groups);
        setViewState(groups.length > 0 ? "browse" : "empty");
      })
      .catch(() => {
        setViewState("empty");
      });
  }, []);

  const reconfigure = useCallback(() => {
    if (reconfigureState.code && reconfigureState.pollToken) {
      setReconfigureState((current) => ({ ...current, visible: true }));
      return;
    }

    focusBeforeReconfigureRef.current =
      lastContentFocusRef.current ?? "row0-col0";
    setReconfigureState({
      visible: true,
      code: null,
      pollToken: null,
      error: null,
    });

    fetchWithSession("/api/pairing", { method: "POST" })
      .then((res) => {
        if (!res.ok) throw new Error("Failed to create management code");
        return res.json();
      })
      .then((data) =>
        setReconfigureState({
          visible: true,
          code: data.code,
          pollToken: data.pollToken,
          error: null,
        })
      )
      .catch(() =>
        setReconfigureState({
          visible: true,
          code: null,
          pollToken: null,
          error: "Could not create a QR code. Try again.",
        })
      );
  }, [reconfigureState.code, reconfigureState.pollToken]);

  const closeReconfigure = useCallback(() => {
    setReconfigureState((current) => dismissReconfigure(current));

    const restoreId = focusBeforeReconfigureRef.current ?? "row0-col0";
    window.requestAnimationFrame(() => {
      setFocus(restoreId);
      containerRef.current?.focus();
    });
  }, [setFocus]);

  useEffect(() => {
    if (!shouldPollReconfigure(reconfigureState)) return;

    const checkStatus = () => {
      fetch(
        `/api/pairing/status?code=${encodeURIComponent(reconfigureState.code!)}`,
        {
          headers: {
            "X-Pairing-Poll-Token": reconfigureState.pollToken!,
          },
        }
      )
        .then((res) => {
          if (res.status === 404) {
            setReconfigureState((current) => expireReconfigure(current));
            return null;
          }
          if (!res.ok) throw new Error("Failed to check pairing status");
          return res.json();
        })
        .then((data) => {
          if (!data) return;
          if (data.complete) {
            setViewState("loading");
            setReconfigureState(completeReconfigure());
            void loadContent();

            const restoreId =
              focusBeforeReconfigureRef.current ?? "row0-col0";
            window.requestAnimationFrame(() => {
              setFocus(restoreId);
              containerRef.current?.focus();
            });
          }
        })
        .catch(() => {
          // Keep polling while the modal is open.
        });
    };

    const interval = setInterval(checkStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [reconfigureState, loadContent, setFocus]);

  /* ---- Render ---- */
  return (
    <div ref={containerRef} tabIndex={-1} className="min-h-screen bg-tv-bg text-tv-text outline-none">
      {/* Title bar */}
      <header className="px-tv-padding pt-8 pb-4 flex items-center justify-between">
        <h1 className="text-tv-xl font-bold">TV Video</h1>
        {(viewState === "empty" || viewState === "browse") && (
          <ReconfigureButton onSelect={reconfigure} />
        )}
      </header>

      <AnimatePresence>
        {reconfigureState.visible && (
          <ReconfigureModal
            code={reconfigureState.code}
            error={reconfigureState.error}
            onClose={closeReconfigure}
          />
        )}
      </AnimatePresence>

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
