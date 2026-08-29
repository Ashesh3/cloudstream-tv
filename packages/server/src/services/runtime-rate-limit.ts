import { createHmac } from "node:crypto";

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

export interface RuntimeRateLimiter {
  consume(
    bucket: string,
    subject: string,
    now: Date,
    policy: RuntimeRateLimitPolicy,
  ): Promise<RuntimeRateLimitResult>;
}

export interface CreateRuntimeRateLimiterOptions {
  secret: string;
  now?: () => Date;
}

export type RuntimeRateLimitConfigurationErrorCode =
  | "RATE_LIMIT_BUCKET_INVALID"
  | "RATE_LIMIT_SECRET_INVALID";

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
    /\p{White_Space}/u.test(value) ||
    Buffer.byteLength(value, "utf8") < 32
  ) {
    throw new RuntimeRateLimitConfigurationError("RATE_LIMIT_SECRET_INVALID");
  }
  return value;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return minimum;
  if (value === Number.POSITIVE_INFINITY) return maximum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function requireBucket(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new RuntimeRateLimitConfigurationError("RATE_LIMIT_BUCKET_INVALID");
  }
  return value;
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

function retryAfterSeconds(nowMs: number, expiresAt: number): number {
  return Math.max(1, Math.ceil((expiresAt - nowMs) / 1_000));
}

export function createRuntimeRateLimiter(
  options: CreateRuntimeRateLimiterOptions,
): RuntimeRateLimiter {
  const secret = requireSecret(options.secret);
  const fallbackNow = options.now ?? (() => new Date());
  const windows = new Map<string, CachedWindow>();

  async function consume(
    requestedBucket: string,
    subject: string,
    requestedNow: Date,
    requestedPolicy: RuntimeRateLimitPolicy,
  ): Promise<RuntimeRateLimitResult> {
    const policy = safePolicy(requestedPolicy);
    const bucket = requireBucket(requestedBucket);
    const requestedTime = requestedNow.getTime();
    if (!Number.isFinite(requestedTime)) {
      const fallbackTime = fallbackNow().getTime();
      const windowMs = policy.windowSeconds * 1_000;
      const usableTime = Number.isFinite(fallbackTime) ? fallbackTime : Date.now();
      const expiresAt = Math.floor(usableTime / windowMs) * windowMs + windowMs;
      return {
        allowed: true,
        remaining: policy.limit,
        retryAfterSeconds: retryAfterSeconds(usableTime, expiresAt),
      };
    }

    const windowMs = policy.windowSeconds * 1_000;
    const windowStart = Math.floor(requestedTime / windowMs) * windowMs;
    const expiresAt = windowStart + windowMs;
    const hmacSubject = createHmac("sha256", secret)
      .update(subject)
      .digest("base64url");
    const key = `rate:${bucket}:${hmacSubject}:${windowStart}`;
    const current = windows.get(key);
    if (current && current.count >= policy.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: retryAfterSeconds(requestedTime, expiresAt),
      };
    }

    const nextCount = (current?.count ?? 0) + 1;
    windows.set(key, { count: nextCount, expiresAt });
    if (windows.size > 1_024) {
      for (const [cachedKey, value] of windows) {
        if (value.expiresAt <= requestedTime) windows.delete(cachedKey);
      }
    }
    return {
      allowed: true,
      remaining: Math.max(0, policy.limit - nextCount),
      retryAfterSeconds: retryAfterSeconds(requestedTime, expiresAt),
    };
  }

  return { consume };
}
