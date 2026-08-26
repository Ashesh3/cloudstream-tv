import type { ProviderKind, SourceIndexStateKind } from "@cloudframe/shared";

export const CONTROL_HIT_TARGET = 44;
export const DIRECTION_SEED = "b10bdc63";
export const CHECKED_CONTROL_SELECTORS = [
  '[data-slot="checkbox"][data-state="checked"]',
  '[data-slot="switch"][data-state="checked"]'
] as const;

export const INDEX_COPY: Record<SourceIndexStateKind, {
  title: string;
  description: string;
  tone: "quiet" | "active" | "warning" | "danger";
  action: "none" | "sync" | "reconnect" | "billing";
}> = {
  unselected: { title: "Choose folders", description: "Connected, with no household folders selected.", tone: "quiet", action: "none" },
  queued: { title: "Indexing queued", description: "Your selected folders are waiting for the durable indexer.", tone: "active", action: "sync" },
  indexing: { title: "Indexing selected folders", description: "Cloudframe is preparing this household program.", tone: "active", action: "none" },
  reconciling: { title: "Refreshing access", description: "Folders outside the current program are being removed from TV access.", tone: "active", action: "none" },
  healthy: { title: "Program ready", description: "Selected folders are indexed and available to approved TVs.", tone: "quiet", action: "sync" },
  "quota-exhausted": { title: "Indexing paused", description: "Firestore quota is exhausted. Choose a smaller program or enable billing, then retry.", tone: "danger", action: "billing" },
  "reauth-required": { title: "Reconnect this account", description: "The cloud provider needs renewed authorization before browsing or indexing can continue.", tone: "warning", action: "reconnect" },
  "provider-error": { title: "Provider unavailable", description: "The cloud provider request failed. Retry now or reconnect if the problem persists.", tone: "warning", action: "sync" }
};

export function providerName(provider: ProviderKind): string {
  return provider === "google" ? "Google Drive" : "OneDrive";
}

export function formatIndexMeasure(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Math.max(0, value));
}
