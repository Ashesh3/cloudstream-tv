import type { ProviderKind } from "@cloudframe/shared";

export function providerName(provider: ProviderKind): string {
  return provider === "google" ? "Google Drive" : "OneDrive";
}
