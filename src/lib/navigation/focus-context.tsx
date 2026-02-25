"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface FocusableElement {
  id: string;
  element: HTMLElement;
  row: number;
  col: number;
  onSelect?: () => void;
}

type Direction = "up" | "down" | "left" | "right";

interface FocusContextType {
  focusedId: string | null;
  register: (item: FocusableElement) => void;
  unregister: (id: string) => void;
  setFocus: (id: string) => void;
  moveFocus: (direction: Direction) => void;
  selectFocused: () => void;
}

const FocusContext = createContext<FocusContextType | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const itemsRef = useRef<Map<string, FocusableElement>>(new Map());

  const setFocus = useCallback((id: string) => {
    const item = itemsRef.current.get(id);
    if (item) {
      setFocusedId(id);
      item.element.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const register = useCallback(
    (item: FocusableElement) => {
      itemsRef.current.set(item.id, item);
      // Auto-focus the first registered item if nothing is focused
      setFocusedId((current) => {
        if (current === null) {
          item.element.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
          return item.id;
        }
        return current;
      });
    },
    []
  );

  const unregister = useCallback(
    (id: string) => {
      const removedItem = itemsRef.current.get(id);
      itemsRef.current.delete(id);

      setFocusedId((current) => {
        if (current !== id) return current;

        // The focused item was removed; move focus to the nearest neighbor
        if (!removedItem || itemsRef.current.size === 0) return null;

        const remaining = Array.from(itemsRef.current.values());
        remaining.sort((a, b) => {
          const distA =
            Math.abs(a.row - removedItem.row) +
            Math.abs(a.col - removedItem.col);
          const distB =
            Math.abs(b.row - removedItem.row) +
            Math.abs(b.col - removedItem.col);
          return distA - distB;
        });

        const nearest = remaining[0];
        nearest.element.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
        });
        return nearest.id;
      });
    },
    []
  );

  const moveFocus = useCallback(
    (direction: Direction) => {
      const currentId = focusedId;
      if (currentId === null) return;

      const current = itemsRef.current.get(currentId);
      if (!current) return;

      const items = Array.from(itemsRef.current.values());
      let candidates: FocusableElement[];

      switch (direction) {
        case "left":
          candidates = items
            .filter((item) => item.row === current.row && item.col < current.col)
            .sort((a, b) => b.col - a.col); // closest col first (highest col that is still lower)
          break;

        case "right":
          candidates = items
            .filter((item) => item.row === current.row && item.col > current.col)
            .sort((a, b) => a.col - b.col); // closest col first (lowest col that is still higher)
          break;

        case "up":
          candidates = items
            .filter((item) => item.row < current.row)
            .sort((a, b) => {
              const rowDiff = b.row - a.row; // closest row first (highest row that is still lower)
              if (rowDiff !== 0) return rowDiff;
              return (
                Math.abs(a.col - current.col) - Math.abs(b.col - current.col)
              ); // then closest col
            });
          break;

        case "down":
          candidates = items
            .filter((item) => item.row > current.row)
            .sort((a, b) => {
              const rowDiff = a.row - b.row; // closest row first (lowest row that is still higher)
              if (rowDiff !== 0) return rowDiff;
              return (
                Math.abs(a.col - current.col) - Math.abs(b.col - current.col)
              ); // then closest col
            });
          break;
      }

      if (candidates.length > 0) {
        const target = candidates[0];
        setFocusedId(target.id);
        target.element.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    },
    [focusedId]
  );

  const selectFocused = useCallback(() => {
    if (focusedId === null) return;
    const item = itemsRef.current.get(focusedId);
    item?.onSelect?.();
  }, [focusedId]);

  return (
    <FocusContext.Provider
      value={{ focusedId, register, unregister, setFocus, moveFocus, selectFocused }}
    >
      {children}
    </FocusContext.Provider>
  );
}

export function useFocusContext(): FocusContextType {
  const context = useContext(FocusContext);
  if (!context) {
    throw new Error("useFocusContext must be used within a FocusProvider");
  }
  return context;
}
