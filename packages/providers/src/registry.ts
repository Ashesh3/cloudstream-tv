import type { ProviderAdapter, ProviderKind, ProviderRegistry } from "./types";

export function createProviderRegistry(
  adapters: Record<ProviderKind, ProviderAdapter>
): ProviderRegistry {
  return {
    get(provider) {
      return adapters[provider];
    }
  };
}
