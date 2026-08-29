export interface ExpiringMemoryCache {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    options?: { name?: string; tags?: string[]; ttl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number | null;
}

export function createExpiringMemoryCache(
  now: () => Date = () => new Date(),
): ExpiringMemoryCache {
  const values = new Map<string, CacheEntry>();

  return {
    async get(key) {
      const entry = values.get(key);
      if (!entry) return null;
      const currentTime = now().getTime();
      if (
        entry.expiresAt !== null &&
        (!Number.isFinite(currentTime) || currentTime >= entry.expiresAt)
      ) {
        values.delete(key);
        return null;
      }
      return structuredClone(entry.value);
    },
    async set(key, value, options) {
      const currentTime = now().getTime();
      const ttl = options?.ttl;
      const expiresAt = ttl === undefined
        ? null
        : Number.isFinite(currentTime) && Number.isSafeInteger(ttl) && ttl > 0
          ? currentTime + ttl * 1_000
          : currentTime;
      values.set(key, { value: structuredClone(value), expiresAt });
    },
    async delete(key) {
      values.delete(key);
    },
  };
}
