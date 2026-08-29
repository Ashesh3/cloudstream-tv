import { describe, expect, it } from "vitest";
import {
  RuntimeRateLimitConfigurationError,
  createRuntimeRateLimiter,
} from "@cloudframe/server";

const now = new Date("2026-08-27T08:00:30.000Z");
const secret = "r".repeat(32);
const policy = { limit: 2, windowSeconds: 60 };

describe("process-local rate limiting", () => {
  it("counts within one fixed window and rejects after the limit", async () => {
    const limiter = createRuntimeRateLimiter({ secret });

    await expect(limiter.consume("url-vending", "device-1", now, policy))
      .resolves.toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 30 });
    await expect(limiter.consume("url-vending", "device-1", now, policy))
      .resolves.toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 30 });
    await expect(limiter.consume("url-vending", "device-1", now, policy))
      .resolves.toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 30 });
  });

  it("allows exactly ten of twenty concurrent consumes", async () => {
    const limiter = createRuntimeRateLimiter({ secret });

    const results = await Promise.all(Array.from({ length: 20 }, () =>
      limiter.consume("admin-login", "203.0.113.7", now, {
        limit: 10,
        windowSeconds: 60,
      })
    ));

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(10);
    expect(results.filter((result) => result.remaining === 0)).toHaveLength(11);
  });

  it("starts fresh in the next fixed window", async () => {
    const limiter = createRuntimeRateLimiter({ secret });
    await limiter.consume("url-vending", "device-1", now, {
      limit: 1,
      windowSeconds: 60,
    });

    await expect(limiter.consume(
      "url-vending",
      "device-1",
      new Date(now.getTime() + 31_000),
      { limit: 1, windowSeconds: 60 },
    )).resolves.toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 59 });
  });

  it("keeps subjects and buckets independent", async () => {
    const limiter = createRuntimeRateLimiter({ secret });
    await limiter.consume("url-vending", "device-1", now, { limit: 1, windowSeconds: 60 });

    await expect(limiter.consume("url-vending", "device-2", now, { limit: 1, windowSeconds: 60 }))
      .resolves.toMatchObject({ allowed: true });
    await expect(limiter.consume("url_vending", "device-1", now, { limit: 1, windowSeconds: 60 }))
      .resolves.toMatchObject({ allowed: true });
  });

  it("clamps policy values to the public bounds", async () => {
    const limiter = createRuntimeRateLimiter({ secret });
    const result = await limiter.consume(
      "url-vending",
      "device-1",
      now,
      { limit: Number.POSITIVE_INFINITY, windowSeconds: -5 },
    );

    expect(result).toEqual({ allowed: true, remaining: 9_999, retryAfterSeconds: 1 });
  });

  it.each([
    "",
    "url vending",
    "url@vending",
    "URL-vending",
    "a".repeat(65),
  ])("rejects invalid bucket %j without exposing it", async (bucket) => {
    const limiter = createRuntimeRateLimiter({ secret });
    const error = await limiter.consume(bucket, "raw-subject", now, policy)
      .catch((value) => value);

    expect(error).toMatchObject({ code: "RATE_LIMIT_BUCKET_INVALID" });
    expect(String(error)).not.toContain("raw-subject");
    if (bucket) expect(String(error)).not.toContain(bucket);
  });

  it.each(["", "short", ` ${"x".repeat(32)}`, `${"x".repeat(32)} `])(
    "fails fast for an invalid configured secret: %j",
    (configuredSecret) => {
      expect(() => createRuntimeRateLimiter({ secret: configuredSecret }))
        .toThrow(new RuntimeRateLimitConfigurationError("RATE_LIMIT_SECRET_INVALID"));
    },
  );

  it.each([
    `${"x".repeat(16)} ${"x".repeat(16)}`,
    `${"x".repeat(16)}\t${"x".repeat(16)}`,
    `${"x".repeat(16)}\n${"x".repeat(16)}`,
    `${"x".repeat(16)}\u0085${"x".repeat(16)}`,
    `${"x".repeat(16)}\u2007${"x".repeat(16)}`,
  ])("rejects configured secrets containing internal whitespace", (configuredSecret) => {
    expect(() => createRuntimeRateLimiter({ secret: configuredSecret }))
      .toThrow(new RuntimeRateLimitConfigurationError("RATE_LIMIT_SECRET_INVALID"));
  });

  it("fails open without retaining state when the request clock is invalid", async () => {
    const fallback = new Date("2026-08-27T09:00:00.000Z");
    const limiter = createRuntimeRateLimiter({ secret, now: () => fallback });

    await expect(limiter.consume("admin-login", "device-1", new Date(NaN), {
      limit: 1,
      windowSeconds: 60,
    })).resolves.toMatchObject({ allowed: true, remaining: 1 });
    await expect(limiter.consume("admin-login", "device-1", fallback, {
      limit: 1,
      windowSeconds: 60,
    })).resolves.toMatchObject({ allowed: true });
  });
});
