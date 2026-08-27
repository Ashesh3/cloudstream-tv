import { getCache, type RuntimeCache } from "@vercel/functions";
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
        await runtime.delete(controlKey);
        return null;
      }
      return structuredClone(value);
    },

    async set(value, ttlSeconds) {
      await runtime.set(controlKey, structuredClone(value), {
        tags: [tag],
        ttl: ttlSeconds
      });
    },

    async delete() {
      await runtime.delete(controlKey);
    },

    async getMirrorStatus() {
      const value = await runtime.get(statusKey);
      return isMirrorStatus(value)
        ? structuredClone(value)
        : { status: "current", revision: null };
    },

    async setMirrorStatus(value) {
      await runtime.set(statusKey, structuredClone(value), cacheOptions);
    }
  };
}
