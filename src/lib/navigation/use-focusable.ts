"use client";

import { useEffect, useRef } from "react";
import { useFocusContext } from "./focus-context";

interface UseFocusableOptions {
  id: string;
  row: number;
  col: number;
  autoFocus?: boolean;
  onSelect?: () => void;
}

export function useFocusable({
  id,
  row,
  col,
  autoFocus = true,
  onSelect,
}: UseFocusableOptions) {
  const ref = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  const { focusedId, register, unregister } = useFocusContext();

  onSelectRef.current = onSelect;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    register({
      id,
      element,
      row,
      col,
      autoFocus,
      onSelect: () => onSelectRef.current?.(),
    });

    return () => {
      unregister(id);
    };
  }, [id, row, col, autoFocus, register, unregister]);

  return {
    ref,
    isFocused: focusedId === id,
  };
}
