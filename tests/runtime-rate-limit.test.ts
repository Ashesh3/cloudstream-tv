import {
  RuntimeRateLimitConfigurationError,
  createRuntimeRateLimiter,
  type RateLimitRuntimeCache,
} from "@cloudframe/server";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

const now = new Date("2026-08-27T08:00:30.000Z");
const secret = "r".repeat(32);
const policy = { limit: 2, windowSeconds: 60 };

describe("best-effort Runtime Cache rate limiting", () => {
  it("stores only an HMAC request subject in the exact fixed-window key", async () => {
    const harness = createHarness();

    await harness.limiter.consume(
      "admin-login",
      "203.0.113.7",
      now,
      policy,
    );

    const windowStart = Math.floor(now.getTime() / 60_000) * 60_000;
    const hmacSubject = createHmac("sha256", secret)
      .update("203.0.113.7")
      .digest("base64url");
    expect(harness.cache.keys).toEqual([
      `rate:admin-login:${hmacSubject}:${windowStart}`,
    ]);
    expect(harness.cache.keys.join(" ")).not.toContain("203.0.113.7");
  });

  it("stores exact JSON state with a TTL of two windows", async () => {
    const harness = createHarness();

    const result = await harness.limiter.consume(
      "url-vending",
      "device-1",
      now,
      policy,
    );

    const windowStart = Math.floor(now.getTime() / 60_000) * 60_000;
    expect(result).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 30,
    });
    expect(harness.cache.sets).toEqual([
      {
        value: { count: 1, expiresAt: windowStart + 60_000 },
        options: { name: "", ttl: 120 },
      },
    ]);
  });

  it("counts within a window and rejects after the configured limit", async () => {
    const harness = createHarness();

    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 30,
    });
    expect(harness.cache.sets.at(-1)?.value).toEqual({
      count: 2,
      expiresAt: Math.floor(now.getTime() / 60_000) * 60_000 + 60_000,
    });
  });

  it("starts a fresh count in the next fixed window", async () => {
    const harness = createHarness();
    await harness.limiter.consume("url-vending", "device-1", now, {
      limit: 1,
      windowSeconds: 60,
    });

    const next = new Date(now.getTime() + 31_000);
    await expect(
      harness.limiter.consume("url-vending", "device-1", next, {
        limit: 1,
        windowSeconds: 60,
      }),
    ).resolves.toMatchObject({ allowed: true, remaining: 0 });
    expect(harness.cache.keys).toHaveLength(2);
  });

  it("fails open only for the limiter when cache is unavailable", async () => {
    const harness = createHarness();
    harness.cache.failGet = true;

    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toEqual({
      allowed: true,
      remaining: 2,
      retryAfterSeconds: 30,
    });
    expect(harness.cache.sets).toHaveLength(0);

    harness.cache.failGet = false;
    harness.cache.failSet = true;
    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toEqual({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 30,
    });
  });

  it("treats malformed or expired cache values as an empty best-effort window", async () => {
    const harness = createHarness();
    harness.cache.nextGet = { count: "private-subject", expiresAt: 0 };

    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    expect(harness.cache.sets[0]?.value).toEqual({
      count: 1,
      expiresAt: Math.floor(now.getTime() / 60_000) * 60_000 + 60_000,
    });
  });

  it("preserves a canonical bucket while clamping policy values", async () => {
    const harness = createHarness();
    const result = await harness.limiter.consume(
      "url-vending",
      "device-1",
      now,
      { limit: Number.POSITIVE_INFINITY, windowSeconds: -5 },
    );

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9_999);
    const [key] = harness.cache.keys;
    expect(key!.split(":")[1]).toBe("url-vending");
    expect(harness.cache.sets[0]?.options.ttl).toBe(2);
  });

  it.each([
    "",
    "url vending",
    "url@vending",
    "URL-vending",
    "a".repeat(65),
  ])("rejects invalid bucket %j before cache access", async (bucket) => {
    const harness = createHarness();

    const error = await harness.limiter
      .consume(bucket, "raw-subject", now, policy)
      .catch((value) => value);

    expect(error).toMatchObject({ code: "RATE_LIMIT_BUCKET_INVALID" });
    if (bucket) expect(String(error)).not.toContain(bucket);
    expect(String(error)).not.toContain("raw-subject");
    expect(harness.cache.keys).toHaveLength(0);
  });

  it("keeps distinct valid buckets distinct without lossy normalization", async () => {
    const harness = createHarness();

    await harness.limiter.consume("url-vending", "device-1", now, policy);
    await harness.limiter.consume("url_vending", "device-1", now, policy);

    expect(harness.cache.keys[0]).not.toBe(harness.cache.keys[1]);
    expect(harness.cache.keys.map((key) => key.split(":")[1])).toEqual([
      "url-vending",
      "url_vending",
    ]);
  });

  it("treats an impossible cached count as malformed and rewrites count one", async () => {
    const harness = createHarness();
    const windowStart = Math.floor(now.getTime() / 60_000) * 60_000;
    harness.cache.nextGet = {
      count: 10_001,
      expiresAt: windowStart + 60_000,
    };

    await expect(
      harness.limiter.consume("url-vending", "device-1", now, policy),
    ).resolves.toMatchObject({ allowed: true, remaining: 1 });
    expect(harness.cache.sets[0]?.value).toEqual({
      count: 1,
      expiresAt: windowStart + 60_000,
    });
  });

  it.each(["", "short", ` ${"x".repeat(32)}`, `${"x".repeat(32)} `])(
    "fails fast for an invalid configured secret without cache access: %j",
    (configuredSecret) => {
      const cache = new RecordingCache();
      expect(() =>
        createRuntimeRateLimiter({ cache, secret: configuredSecret }),
      ).toThrow(new RuntimeRateLimitConfigurationError("RATE_LIMIT_SECRET_INVALID"));
      expect(cache.keys).toHaveLength(0);
    },
  );

  it.each([
    `${"x".repeat(16)} ${"x".repeat(16)}`,
    `${"x".repeat(16)}\t${"x".repeat(16)}`,
    `${"x".repeat(16)}\n${"x".repeat(16)}`,
    `${"x".repeat(16)}\u0085${"x".repeat(16)}`,
    `${"x".repeat(16)}\u2007${"x".repeat(16)}`,
  ])("rejects configured secrets containing internal whitespace", (configuredSecret) => {
    const cache = new RecordingCache();

    const error = (() => {
      try {
        createRuntimeRateLimiter({ cache, secret: configuredSecret });
      } catch (value) {
        return value;
      }
    })();

    expect(error).toMatchObject({ code: "RATE_LIMIT_SECRET_INVALID" });
    expect(String(error)).not.toContain(configuredSecret);
    expect(cache.keys).toHaveLength(0);
  });

  it("never includes the raw subject in cache failure errors", async () => {
    const cache: RateLimitRuntimeCache = {
      async get(key) {
        throw new Error(`cache failed for ${key}`);
      },
      async set() {
        throw new Error("unreachable");
      },
    };
    const limiter = createRuntimeRateLimiter({ cache, secret });
    const rawSubject = "203.0.113.99";

    const result = await limiter.consume("admin-login", rawSubject, now, policy);

    expect(JSON.stringify(result)).not.toContain(rawSubject);
  });
});

function createHarness() {
  const cache = new RecordingCache();
  return {
    cache,
    limiter: createRuntimeRateLimiter({ cache, secret }),
  };
}

class RecordingCache implements RateLimitRuntimeCache {
  readonly values = new Map<string, unknown>();
  readonly keys: string[] = [];
  readonly sets: Array<{
    value: unknown;
    options: { name?: string; tags?: string[]; ttl?: number };
  }> = [];
  failGet = false;
  failSet = false;
  nextGet: unknown | undefined;

  async get(key: string): Promise<unknown | null> {
    this.keys.push(key);
    if (this.failGet) throw new Error("synthetic cache read failure");
    if (this.nextGet !== undefined) {
      const value = this.nextGet;
      this.nextGet = undefined;
      return value;
    }
    return structuredClone(this.values.get(key) ?? null);
  }

  async set(
    key: string,
    value: unknown,
    options?: { name?: string; tags?: string[]; ttl?: number },
  ): Promise<void> {
    if (this.failSet) throw new Error("synthetic cache write failure");
    this.values.set(key, structuredClone(value));
    this.sets.push({ value: structuredClone(value), options: { ...options } });
  }
}
