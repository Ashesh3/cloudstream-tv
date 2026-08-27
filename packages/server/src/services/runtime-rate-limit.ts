import { createHmac } from "node:crypto";

import { getCache } from "@vercel/functions";

export const RUNTIME_RATE_LIMIT_BOUNDS = {
  bucketLength: 64,
  limit: { min: 1, max: 10_000 },
  windowSeconds: { min: 1, max: 86_400 },
} as const;

export interface RuntimeRateLimitPolicy {
  limit: number;
  windowSeconds: number;
}

export interface RuntimeRateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitRuntimeCache {
  get(key: string): Promise<unknown | null>;
  set(
    key: string,
    value: unknown,
    options?: { name?: string; tags?: string[]; ttl?: number },
  ): Promise<void>;
}

export interface RuntimeRateLimiter {
  /** Best-effort only: Runtime Cache does not provide an atomic increment. */
  consume(
    bucket: string,
    subject: string,
    now: Date,
    policy: RuntimeRateLimitPolicy,
  ): Promise<RuntimeRateLimitResult>;
}

export interface CreateRuntimeRateLimiterOptions {
  secret: string;
  cache?: RateLimitRuntimeCache;
}

export type RuntimeRateLimitConfigurationErrorCode =
  "RATE_LIMIT_SECRET_INVALID";

export class RuntimeRateLimitConfigurationError extends Error {
  constructor(readonly code: RuntimeRateLimitConfigurationErrorCode) {
    super(code);
    this.name = "RuntimeRateLimitConfigurationError";
  }
}

interface CachedWindow {
  count: number;
  expiresAt: number;
}

function requireSecret(value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") < 32
  ) {
    throw new RuntimeRateLimitConfigurationError("RATE_LIMIT_SECRET_INVALID");
  }
  return value;
}

function clampInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return minimum;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function safeBucket(value: string): string {
  const bucket = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, RUNTIME_RATE_LIMIT_BOUNDS.bucketLength);
  return bucket || "default";
}

function safePolicy(policy: RuntimeRateLimitPolicy): RuntimeRateLimitPolicy {
  return {
    limit: clampInteger(
      policy.limit,
      RUNTIME_RATE_LIMIT_BOUNDS.limit.min,
      RUNTIME_RATE_LIMIT_BOUNDS.limit.max,
    ),
    windowSeconds: clampInteger(
      policy.windowSeconds,
      RUNTIME_RATE_LIMIT_BOUNDS.windowSeconds.min,
      RUNTIME_RATE_LIMIT_BOUNDS.windowSeconds.max,
    ),
  };
}

function cachedWindow(value: unknown, expectedExpiry: number): CachedWindow | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const candidate = value as Partial<CachedWindow>;
    if (
      Object.keys(value).length !== 2 ||
      !Number.isSafeInteger(candidate.count) ||
      (candidate.count as number) < 0 ||
      candidate.expiresAt !== expectedExpiry
    ) {
      return null;
    }
    return {
      count: candidate.count as number,
      expiresAt: candidate.expiresAt,
    };
  } catch {
    return null;
  }
}

function retryAfterSeconds(nowMs: number, expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - nowMs) / 1_000));
}

export function createRuntimeRateLimiter(
  options: CreateRuntimeRateLimiterOptions,
): RuntimeRateLimiter {
  const secret = requireSecret(options.secret);
  const cache =
    options.cache ?? getCache({ namespace: "cloudframe-rate-limits" });

  async function consume(
    requestedBucket: string,
    subject: string,
    requestedNow: Date,
    requestedPolicy: RuntimeRateLimitPolicy,
  ): Promise<RuntimeRateLimitResult> {
    const policy = safePolicy(requestedPolicy);
    const nowMs = Number.isFinite(requestedNow.getTime())
      ? requestedNow.getTime()
      : Date.now();
    const windowMs = policy.windowSeconds * 1_000;
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs;
    const retryAfter = retryAfterSeconds(nowMs, expiresAt);
    const hmacSubject = createHmac("sha256", secret)
      .update(subject)
      .digest("base64url");
    const key = `rate:${safeBucket(requestedBucket)}:${hmacSubject}:${windowStart}`;

    let value: unknown;
    try {
      value = await cache.get(key);
    } catch {
      return {
        allowed: true,
        remaining: policy.limit,
        retryAfterSeconds: retryAfter,
      };
    }

    const current = cachedWindow(value, expiresAt)?.count ?? 0;
    if (current >= policy.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: retryAfter,
      };
    }

    const nextCount = current + 1;
    const result = {
      allowed: true,
      remaining: Math.max(0, policy.limit - nextCount),
      retryAfterSeconds: retryAfter,
    };
    try {
      await cache.set(
        key,
        { count: nextCount, expiresAt },
        { name: "", ttl: policy.windowSeconds * 2 },
      );
    } catch {
      // The limiter deliberately fails open; authorization is enforced elsewhere.
    }
    return result;
  }

  return { consume };
}
