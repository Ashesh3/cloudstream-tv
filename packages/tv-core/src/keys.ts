export type TvKeyAction =
  | "left"
  | "right"
  | "up"
  | "down"
  | "enter"
  | "back"
  | "exit"
  | "menu"
  | "play"
  | "pause"
  | "play-pause";

export interface TvKeyLike {
  key?: string;
  keyCode?: number;
  which?: number;
}

const KEY_NAMES: Record<string, TvKeyAction> = {
  ArrowLeft: "left",
  Left: "left",
  ArrowRight: "right",
  Right: "right",
  ArrowUp: "up",
  Up: "up",
  ArrowDown: "down",
  Down: "down",
  Enter: "enter",
  Accept: "enter",
  Escape: "back",
  Esc: "back",
  Backspace: "back",
  GoBack: "back",
  ContextMenu: "menu",
  MediaPlay: "play",
  MediaPause: "pause",
  MediaPlayPause: "play-pause"
};

const KEY_CODES: Record<number, TvKeyAction> = {
  8: "back",
  13: "enter",
  19: "pause",
  27: "back",
  37: "left",
  38: "up",
  39: "right",
  40: "down",
  415: "play",
  457: "menu",
  461: "back",
  10182: "exit",
  10009: "back",
  10252: "play-pause",
  65361: "left",
  65362: "up",
  65363: "right",
  65364: "down",
  65376: "enter",
  65385: "pause"
};

export function normalizeTvKey(event: TvKeyLike): TvKeyAction | null {
  if (event.key && KEY_NAMES[event.key]) return KEY_NAMES[event.key]!;
  const code = typeof event.keyCode === "number" ? event.keyCode : event.which;
  return typeof code === "number" ? KEY_CODES[code] ?? null : null;
}

export function shouldHandleTvKey(action: TvKeyAction, repeat: boolean): boolean {
  return !repeat || action === "left" || action === "right" || action === "up" || action === "down";
}
