import type { ProviderKind } from "@cloudframe/shared";

export const CONTROL_HIT_TARGET = 44;
export const DIRECTION_SEED = "b10bdc63";
export const CHECKED_CONTROL_SELECTORS = [
  '[data-slot="checkbox"][data-state="checked"]',
  '[data-slot="switch"][data-state="checked"]'
] as const;

export function providerName(provider: ProviderKind): string {
  return provider === "google" ? "Google Drive" : "OneDrive";
}
