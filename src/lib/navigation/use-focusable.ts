"use client";

import { useEffect, useRef } from "react";
import { useFocusContext } from "./focus-context";

interface UseFocusableOptions {
  id: string;
  row: number;
  col: number;
  onSelect?: () => void;
}

export function useFocusable({ id, row, col, onSelect }: UseFocusableOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const { focusedId, register, unregister } = useFocusContext();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    register({ id, element, row, col, onSelect });

    return () => {
      unregister(id);
    };
  }, [id, row, col, onSelect, register, unregister]);

  return {
    ref,
    isFocused: focusedId === id,
  };
}
