"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GOOGLE_OAUTH, ONEDRIVE_OAUTH } from "@/lib/constants";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface FolderNode {
  id: string;
  name: string;
}

interface BreadcrumbEntry {
  id: string;
  name: string;
}

/* ------------------------------------------------------------------ */
/*  FolderPicker sub-component                                         */
/* ------------------------------------------------------------------ */

function FolderPicker({
  sessionId,
  connectionId,
  provider,
}: {
  sessionId: string;
  connectionId: string;
  provider: string;
}) {
  const [folders, setFolders] = useState<FolderNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbEntry[]>([
    { id: "root", name: "Root" },
  ]);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const currentFolderId = breadcrumb[breadcrumb.length - 1].id;

  const fetchFolders = useCallback(
    async (folderId: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          sessionId,
          connectionId,
          folderId,
        });
        const res = await fetch(`/api/setup/folders?${params}`);
        if (!res.ok) throw new Error("Failed to load folders");
        const data = await res.json();
        setFolders(data.folders ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load folders");
      } finally {
        setLoading(false);
      }
    },
    [sessionId, connectionId]
  );

  useEffect(() => {
    fetchFolders(currentFolderId);
  }, [currentFolderId, fetchFolders]);

  function navigateInto(folder: FolderNode) {
    setBreadcrumb((prev) => [...prev, { id: folder.id, name: folder.name }]);
  }

  function navigateTo(index: number) {
    setBreadcrumb((prev) => prev.slice(0, index + 1));
  }

  function toggleSelect(folder: FolderNode) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(folder.id)) {
        next.delete(folder.id);
      } else {
        next.set(folder.id, folder.name);
      }
      return next;
    });
  }

  async function handleSave() {
    if (selected.size === 0) return;
    setSaving(true);
    try {
      const foldersToSave = Array.from(selected.entries()).map(
        ([id, name]) => ({ id, name })
      );
      const res = await fetch("/api/setup/save-folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          connectionId,
          folders: foldersToSave,
        }),
      });
      if (!res.ok) throw new Error("Failed to save folders");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div className="text-center py-12">
        <div className="text-4xl mb-4">&#10003;</div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          Setup Complete!
        </h2>
        <p className="text-gray-600">
          Your TV should now show your videos. You can close this page.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">
        Select Folders ({provider === "google" ? "Google Drive" : "OneDrive"})
      </h2>

      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm text-gray-500 mb-4 flex-wrap">
        {breadcrumb.map((entry, i) => (
          <span key={entry.id} className="flex items-center gap-1">
            {i > 0 && <span>/</span>}
            <button
              onClick={() => navigateTo(i)}
              className={`hover:text-blue-600 hover:underline ${
                i === breadcrumb.length - 1
                  ? "text-gray-900 font-medium"
                  : "text-gray-500"
              }`}
            >
              {entry.name}
            </button>
          </span>
        ))}
      </nav>

      {/* Folder list */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : error ? (
        <div className="text-red-600 bg-red-50 rounded-lg p-4">{error}</div>
      ) : folders.length === 0 ? (
        <p className="text-gray-500 py-8 text-center">
          No sub-folders found in this directory.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 border border-gray-200 rounded-lg overflow-hidden">
          {folders.map((folder) => (
            <li
              key={folder.id}
              className="flex items-center justify-between px-4 py-3 hover:bg-gray-50"
            >
              <button
                onClick={() => navigateInto(folder)}
                className="flex items-center gap-3 text-gray-900 hover:text-blue-600 min-w-0 flex-1 text-left"
              >
                <svg
                  className="w-5 h-5 text-yellow-500 flex-shrink-0"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                </svg>
                <span className="truncate">{folder.name}</span>
              </button>
              <button
                onClick={() => toggleSelect(folder)}
                className={`ml-3 px-3 py-1 text-sm rounded-md border flex-shrink-0 ${
                  selected.has(folder.id)
                    ? "bg-blue-600 text-white border-blue-600"
                    : "bg-white text-gray-700 border-gray-300 hover:border-blue-400"
                }`}
              >
                {selected.has(folder.id) ? "Selected" : "Select"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Selected summary & save */}
      {selected.size > 0 && (
        <div className="mt-6 border-t border-gray-200 pt-4">
          <p className="text-sm text-gray-600 mb-3">
            {selected.size} folder{selected.size > 1 ? "s" : ""} selected:{" "}
            {Array.from(selected.values()).join(", ")}
          </p>
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Save & Finish"}
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Setup Page                                                    */
/* ------------------------------------------------------------------ */

export default function SetupPage() {
  const searchParams = useSearchParams();

  const [pairingCode, setPairingCode] = useState(
    searchParams.get("code") ?? ""
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [step, setStep] = useState<
    "enter-code" | "connect" | "folders" | "loading"
  >("loading");
  const [error, setError] = useState<string | null>(null);

  // On mount, decide which step we're on
  useEffect(() => {
    const urlCode = searchParams.get("code");
    const paired = searchParams.get("paired");
    const urlConnectionId = searchParams.get("connectionId");
    const urlProvider = searchParams.get("provider");
    const urlError = searchParams.get("error");

    if (urlError) {
      setError(
        urlError === "session_expired"
          ? "Session expired. Please try again."
          : urlError === "oauth_failed"
            ? "OAuth authentication failed. Please try again."
            : `Error: ${urlError}`
      );
      setStep("connect");
      return;
    }

    // Returning from OAuth callback with pairing code, connectionId, provider
    if (paired && urlConnectionId && urlProvider) {
      setPairingCode(paired);
      setConnectionId(urlConnectionId);
      setProvider(urlProvider);

      // Look up sessionId from the pairing code
      fetch(`/api/pairing/status?code=${encodeURIComponent(paired)}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.sessionId) {
            setSessionId(data.sessionId);
            setStep("folders");
          } else {
            setError("Could not find session. Please try again.");
            setStep("enter-code");
          }
        })
        .catch(() => {
          setError("Failed to verify session.");
          setStep("enter-code");
        });
      return;
    }

    // If code is provided in URL, go to connect step
    if (urlCode) {
      setPairingCode(urlCode);
      setStep("connect");
      return;
    }

    // No code, show enter-code form
    setStep("enter-code");
  }, [searchParams]);

  function handleCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pairingCode.trim().length === 0) return;
    // Navigate with code in URL
    window.location.href = `/setup?code=${encodeURIComponent(pairingCode.trim())}`;
  }

  function redirectToGoogle() {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (!clientId) {
      setError("Google client ID not configured");
      return;
    }
    const redirectUri = `${window.location.origin}/setup/callback/google`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_OAUTH.scope,
      access_type: "offline",
      prompt: "consent",
      state: pairingCode,
    });
    window.location.href = `${GOOGLE_OAUTH.authUrl}?${params}`;
  }

  function redirectToOneDrive() {
    const clientId = process.env.NEXT_PUBLIC_ONEDRIVE_CLIENT_ID;
    if (!clientId) {
      setError("OneDrive client ID not configured");
      return;
    }
    const redirectUri = `${window.location.origin}/setup/callback/onedrive`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: ONEDRIVE_OAUTH.scope,
      response_mode: "query",
      state: pairingCode,
    });
    window.location.href = `${ONEDRIVE_OAUTH.authUrl}?${params}`;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-lg mx-auto px-4 py-12">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">TV Video Setup</h1>
          <p className="text-gray-500 mt-1">
            Connect your cloud storage to stream videos on your TV
          </p>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          {/* Error banner */}
          {error && (
            <div className="mb-4 bg-red-50 text-red-700 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          {/* Step: Enter Code */}
          {step === "enter-code" && (
            <form onSubmit={handleCodeSubmit}>
              <label
                htmlFor="pairing-code"
                className="block text-sm font-medium text-gray-700 mb-2"
              >
                Enter the pairing code shown on your TV
              </label>
              <input
                id="pairing-code"
                type="text"
                value={pairingCode}
                onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg text-center text-2xl font-mono tracking-widest text-gray-900 placeholder:text-gray-400 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={pairingCode.trim().length === 0}
                className="mt-4 w-full bg-blue-600 text-white py-3 px-4 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </form>
          )}

          {/* Step: Connect Cloud */}
          {step === "connect" && (
            <div>
              <p className="text-gray-600 mb-1 text-sm">
                Pairing code:{" "}
                <span className="font-mono font-semibold text-gray-900">
                  {pairingCode}
                </span>
              </p>
              <h2 className="text-lg font-semibold text-gray-900 mb-6">
                Connect a cloud source
              </h2>

              <div className="space-y-3">
                {/* Google Drive */}
                <button
                  onClick={redirectToGoogle}
                  className="w-full flex items-center gap-3 px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 text-left"
                >
                  <svg
                    className="w-6 h-6 flex-shrink-0"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M4.433 22l-1.766-3.062 7.567-13.124h3.535L6.2 19h11.6l1.767 3H4.433z"
                      fill="#0066DA"
                    />
                    <path
                      d="M14.233 22l-1.766-3.062L19.6 6.813h3.534L15.567 19h-1.334z"
                      fill="#00AC47"
                    />
                    <path
                      d="M8.034 5.814L9.8 2.75h3.534l7.567 13.126-1.767 3.062-11.1-13.124z"
                      fill="#EA4335"
                    />
                  </svg>
                  <div>
                    <div className="font-medium text-gray-900">
                      Google Drive
                    </div>
                    <div className="text-sm text-gray-500">
                      Connect your Google Drive
                    </div>
                  </div>
                </button>

                {/* OneDrive */}
                <button
                  onClick={redirectToOneDrive}
                  className="w-full flex items-center gap-3 px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 text-left"
                >
                  <svg
                    className="w-6 h-6 flex-shrink-0"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M10.086 8.037l3.463 2.063 4.082-1.636A5.5 5.5 0 0 0 12.5 5a5.48 5.48 0 0 0-2.414.537z"
                      fill="#0364B8"
                    />
                    <path
                      d="M10.086 8.037L7.464 9.6A4.5 4.5 0 0 0 3 14a4.47 4.47 0 0 0 .732 2.463l5.817-2.4z"
                      fill="#0078D4"
                    />
                    <path
                      d="M9.549 14.063l-5.817 2.4A4.5 4.5 0 0 0 7.5 18h9a3.5 3.5 0 0 0 1.131-.187z"
                      fill="#1490DF"
                    />
                    <path
                      d="M13.549 10.1l-4 3.963 8.082 3.75A3.5 3.5 0 0 0 20 14.5a3.48 3.48 0 0 0-2.369-3.036z"
                      fill="#28A8EA"
                    />
                  </svg>
                  <div>
                    <div className="font-medium text-gray-900">OneDrive</div>
                    <div className="text-sm text-gray-500">
                      Connect your Microsoft OneDrive
                    </div>
                  </div>
                </button>
              </div>
            </div>
          )}

          {/* Step: Loading */}
          {step === "loading" && (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          )}

          {/* Step: Folder Picker */}
          {step === "folders" && sessionId && connectionId && provider && (
            <FolderPicker
              sessionId={sessionId}
              connectionId={connectionId}
              provider={provider}
            />
          )}
        </div>
      </div>
    </div>
  );
}
