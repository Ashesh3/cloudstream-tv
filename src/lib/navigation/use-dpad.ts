"use client";

import { useEffect } from "react";
import { useFocusContext } from "./focus-context";

interface UseDpadOptions {
  onBack?: () => void;
  enabled?: boolean;
}

export function useDpad({ onBack, enabled = true }: UseDpadOptions = {}) {
  const { moveFocus, selectFocused } = useFocusContext();

  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      switch (event.key) {
        case "ArrowUp":
          event.preventDefault();
          moveFocus("up");
          break;
        case "ArrowDown":
          event.preventDefault();
          moveFocus("down");
          break;
        case "ArrowLeft":
          event.preventDefault();
          moveFocus("left");
          break;
        case "ArrowRight":
          event.preventDefault();
          moveFocus("right");
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          selectFocused();
          break;
        case "Escape":
        case "Backspace":
          event.preventDefault();
          onBack?.();
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [enabled, moveFocus, selectFocused, onBack]);
}
