import { ProviderError, type ProviderAdapter, type ProviderKind, type ProviderRegistry } from "./types";

export function createProviderRegistry(
  adapters: Partial<Record<ProviderKind, ProviderAdapter>>
): ProviderRegistry {
  return {
    get(provider) {
      const adapter = adapters[provider];
      if (!adapter) {
        throw new ProviderError(
          "PROVIDER_NOT_CONFIGURED",
          "This provider is not configured.",
          { retryable: false },
        );
      }
      return adapter;
    }
  };
}
