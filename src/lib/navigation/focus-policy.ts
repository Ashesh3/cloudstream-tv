export interface FocusCandidate {
  id: string;
  row: number;
  col: number;
  autoFocus: boolean;
}

function ordered(items: FocusCandidate[]): FocusCandidate[] {
  return [...items].sort((a, b) => a.row - b.row || a.col - b.col);
}

export function chooseInitialFocusId(items: FocusCandidate[]): string | null {
  return ordered(items).find((item) => item.autoFocus)?.id ?? null;
}

export function chooseManualFocusId(items: FocusCandidate[]): string | null {
  return chooseInitialFocusId(items) ?? ordered(items)[0]?.id ?? null;
}

export function chooseReplacementFocusId(
  items: FocusCandidate[],
  removed: { row: number; col: number }
): string | null {
  const candidates = items.filter((item) => item.autoFocus);
  candidates.sort((a, b) => {
    const distanceA = Math.abs(a.row - removed.row) + Math.abs(a.col - removed.col);
    const distanceB = Math.abs(b.row - removed.row) + Math.abs(b.col - removed.col);
    return distanceA - distanceB;
  });
  return candidates[0]?.id ?? null;
}
