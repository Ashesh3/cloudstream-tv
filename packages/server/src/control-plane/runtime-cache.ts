import { getCache, type RuntimeCache } from "@vercel/functions";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import type {
  ControlHotCache,
  StoredControlEnvelope
} from "./store";

const CONTROL_CACHE_TTL_SECONDS = 300;

export interface VercelRuntimeControlCacheOptions {
  environment: string;
  householdId: string;
}

type MirrorStatus = Awaited<ReturnType<ControlHotCache["getMirrorStatus"]>>;

export class ControlCacheOperationError extends Error {
  readonly code = "CONTROL_CACHE_OPERATION_FAILED";

  constructor() {
    super("CONTROL_CACHE_OPERATION_FAILED");
    this.name = "ControlCacheOperationError";
  }
}

export class ControlCacheCorruptError extends Error {
  readonly code = "CONTROL_CACHE_CORRUPT";

  constructor() {
    super("CONTROL_CACHE_CORRUPT");
    this.name = "ControlCacheCorruptError";
  }
}

const envelopeSchema = z
  .object({
    envelopeVersion: z.literal(1),
    keyVersion: z.string(),
    revision: z.number().int().safe().positive(),
    iv: z.string(),
    ciphertext: z.string(),
    authTag: z.string()
  })
  .strict();

const storedEnvelopeSchema = z
  .object({
    envelope: envelopeSchema,
    etag: z.string().min(1)
  })
  .strict();

function isStoredControlEnvelope(value: unknown): value is StoredControlEnvelope {
  return storedEnvelopeSchema.safeParse(value).success;
}

function isMirrorStatus(value: unknown): value is MirrorStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { status?: unknown; revision?: unknown };
  return (
    (candidate.status === "current" || candidate.status === "delayed") &&
    (candidate.revision === null ||
      (typeof candidate.revision === "number" &&
        Number.isSafeInteger(candidate.revision) &&
        candidate.revision > 0))
  );
}

function cacheOperationFailed(): ControlCacheOperationError {
  return new ControlCacheOperationError();
}

async function verifiedSet(
  runtime: RuntimeCache,
  key: string,
  value: unknown,
  options: { tags: string[]; ttl: number }
): Promise<void> {
  try {
    await runtime.set(key, value, options);
  } catch {
    // Runtime Cache can fail after accepting a write, so verification decides.
  }
  let verified: unknown;
  try {
    verified = await runtime.get(key);
  } catch {
    throw cacheOperationFailed();
  }
  if (!isDeepStrictEqual(verified, value)) {
    throw cacheOperationFailed();
  }
}

export function createVercelRuntimeControlCache(
  options: VercelRuntimeControlCacheOptions
): ControlHotCache {
  const runtime: RuntimeCache = getCache({ namespace: "cloudframe-control" });
  const controlKey = `v2:${options.environment}:${options.householdId}`;
  const statusKey = `mirror-status:v2:${options.environment}:${options.householdId}`;
  const tag = `cloudframe-control:${options.environment}:${options.householdId}`;
  const cacheOptions = { tags: [tag], ttl: CONTROL_CACHE_TTL_SECONDS };

  return {
    async get() {
      const value = await runtime.get(controlKey);
      if (value === null) {
        return null;
      }
      if (!isStoredControlEnvelope(value)) {
        throw new ControlCacheCorruptError();
      }
      return structuredClone(value);
    },

    async set(value, ttlSeconds) {
      const stored = structuredClone(value);
      await verifiedSet(runtime, controlKey, stored, {
        tags: [tag],
        ttl: ttlSeconds
      });
    },

    async delete() {
      try {
        await runtime.delete(controlKey);
      } catch {
        // Runtime Cache delete errors are verified through the subsequent read.
      }
      let verified: unknown;
      try {
        verified = await runtime.get(controlKey);
      } catch {
        throw cacheOperationFailed();
      }
      if (verified !== null) {
        throw cacheOperationFailed();
      }
      return "unverifiable";
    },

    async getMirrorStatus() {
      const value = await runtime.get(statusKey);
      return isMirrorStatus(value)
        ? structuredClone(value)
        : { status: "current", revision: null };
    },

    async setMirrorStatus(value) {
      const stored = structuredClone(value);
      await verifiedSet(runtime, statusKey, stored, cacheOptions);
    }
  };
}
