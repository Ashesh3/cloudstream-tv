"use client";

import { useState, useCallback } from "react";

interface TransmuxState {
  status: "idle" | "loading" | "transmuxing" | "ready" | "error";
  progress: number;
  blobUrl: string | null;
  error: string | null;
}

const NATIVE_TYPES = ["video/mp4", "video/webm", "video/ogg"];

function isNativelyPlayable(mimeType: string): boolean {
  return NATIVE_TYPES.some((t) => mimeType.startsWith(t));
}

export function useTransmux() {
  const [state, setState] = useState<TransmuxState>({
    status: "idle",
    progress: 0,
    blobUrl: null,
    error: null,
  });

  const transmux = useCallback(async (src: string, mimeType: string): Promise<string> => {
    // If natively playable, return the URL as-is
    if (isNativelyPlayable(mimeType)) {
      setState({ status: "ready", progress: 1, blobUrl: src, error: null });
      return src;
    }

    setState({ status: "loading", progress: 0, blobUrl: null, error: null });

    try {
      const {
        Input,
        Output,
        Conversion,
        UrlSource,
        BufferTarget,
        MATROSKA,
        Mp4OutputFormat,
      } = await import("mediabunny");

      setState((s) => ({ ...s, status: "transmuxing" }));

      const input = new Input({
        source: new UrlSource(src),
        formats: [MATROSKA],
      });

      const target = new BufferTarget();
      const output = new Output({
        target,
        format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      });

      const conversion = await Conversion.init({
        input,
        output,
        showWarnings: false,
      });

      conversion.onProgress = (progress: number) => {
        setState((s) => ({ ...s, progress }));
      };

      if (!conversion.isValid) {
        throw new Error(
          "Cannot transmux this file. Discarded tracks: " +
            conversion.discardedTracks.map((t) => t.reason).join(", ")
        );
      }

      await conversion.execute();

      const buffer = target.buffer;
      if (!buffer) throw new Error("Transmuxing produced no output");

      const blob = new Blob([buffer], { type: "video/mp4" });
      const blobUrl = URL.createObjectURL(blob);

      setState({ status: "ready", progress: 1, blobUrl, error: null });
      return blobUrl;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ status: "error", progress: 0, blobUrl: null, error: message });
      throw err;
    }
  }, []);

  const cleanup = useCallback(() => {
    setState((s) => {
      if (s.blobUrl && s.blobUrl.startsWith("blob:")) {
        URL.revokeObjectURL(s.blobUrl);
      }
      return { status: "idle", progress: 0, blobUrl: null, error: null };
    });
  }, []);

  return { ...state, transmux, cleanup };
}
