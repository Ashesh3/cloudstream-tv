"use client";

import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-tv-bg px-8">
          <h1 className="mb-4 text-tv-xl font-bold text-tv-text">
            Something went wrong
          </h1>
          <p className="mb-8 text-tv-base text-tv-text-dim">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-tv-accent px-8 py-4 text-tv-base font-semibold text-white transition-opacity hover:opacity-90"
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
