"use client";

import { useEffect, useState, useCallback, FormEvent } from "react";

type Status = "checking" | "authenticated" | "unauthenticated";

export default function AccessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Check authentication on mount
  useEffect(() => {
    fetch("/api/check-access")
      .then((res) => res.json())
      .then((data) => {
        setStatus(data.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        // If the check endpoint itself fails, assume unauthenticated
        setStatus("unauthenticated");
      });
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!code.trim() || submitting) return;

      setSubmitting(true);
      setError("");

      try {
        const res = await fetch("/api/validate-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: code.trim() }),
        });
        const data = await res.json();

        if (data.valid) {
          // Cookie is now set — reload so the whole app starts fresh
          window.location.reload();
        } else {
          setError(data.error || "Invalid access code");
          setSubmitting(false);
        }
      } catch {
        setError("Network error. Please try again.");
        setSubmitting(false);
      }
    },
    [code, submitting]
  );

  // While checking, show nothing (avoids flash)
  if (status === "checking") {
    return null;
  }

  // Authenticated — render the app
  if (status === "authenticated") {
    return <>{children}</>;
  }

  // Unauthenticated — show access code form
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0a0a0f",
        color: "#e8e8f0",
        fontFamily: "var(--font-inter, system-ui, sans-serif)",
        padding: "1.5rem",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "1.5rem",
          width: "100%",
          maxWidth: "420px",
        }}
      >
        <h1
          style={{
            fontSize: "clamp(1.75rem, 4vw, 2.5rem)",
            fontWeight: 700,
            margin: 0,
            textAlign: "center",
          }}
        >
          Enter Access Code
        </h1>

        <p
          style={{
            fontSize: "clamp(1rem, 2vw, 1.25rem)",
            color: "#8888a0",
            margin: 0,
            textAlign: "center",
          }}
        >
          Enter the code to access this app
        </p>

        <input
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Access code"
          autoFocus
          autoComplete="off"
          style={{
            width: "100%",
            padding: "1rem 1.25rem",
            fontSize: "clamp(1.125rem, 2.5vw, 1.5rem)",
            borderRadius: "0.75rem",
            border: "2px solid #2a2a3e",
            backgroundColor: "#14141f",
            color: "#e8e8f0",
            textAlign: "center",
            outline: "none",
            transition: "border-color 200ms",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "#4f8fff";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "#2a2a3e";
          }}
        />

        {error && (
          <p
            style={{
              color: "#ff6b4f",
              fontSize: "clamp(0.875rem, 2vw, 1.125rem)",
              margin: 0,
              textAlign: "center",
            }}
          >
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !code.trim()}
          style={{
            width: "100%",
            padding: "1rem",
            fontSize: "clamp(1rem, 2.5vw, 1.25rem)",
            fontWeight: 600,
            borderRadius: "0.75rem",
            border: "none",
            backgroundColor:
              submitting || !code.trim() ? "#2a2a3e" : "#4f8fff",
            color: submitting || !code.trim() ? "#8888a0" : "#ffffff",
            cursor: submitting || !code.trim() ? "default" : "pointer",
            transition: "background-color 200ms, color 200ms",
          }}
        >
          {submitting ? "Verifying..." : "Submit"}
        </button>
      </form>
    </div>
  );
}
