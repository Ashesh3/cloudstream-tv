import type { ControlPlaneDocumentV2 } from "../../../shared/src/control-plane.ts";
import type { VersionedAeadKeyring } from "../crypto/aead.ts";
import {
  decryptControlPlaneEnvelope,
  encryptControlPlaneDocument,
  type ControlPlaneEnvelopeV1
} from "./envelope.ts";
import { cloneControlPlaneDocument, parseControlPlaneDocument } from "./schema.ts";

const CONTROL_CACHE_TTL_SECONDS = 300;
const MAX_CAS_ATTEMPTS = 3;
const MAX_MIRROR_ATTEMPTS = 3;

export interface StoredControlEnvelope {
  envelope: ControlPlaneEnvelopeV1;
  etag: string;
}

export interface ControlDurableStore {
  read(ifNoneMatch?: string): Promise<StoredControlEnvelope | { notModified: true } | null>;
  create(envelope: ControlPlaneEnvelopeV1): Promise<{ etag: string }>;
  replace(envelope: ControlPlaneEnvelopeV1, expectedEtag: string): Promise<{ etag: string }>;
}

export interface ControlHotCache {
  get(): Promise<StoredControlEnvelope | null>;
  set(value: StoredControlEnvelope, ttlSeconds: number): Promise<void>;
  delete(): Promise<"confirmed" | "unverifiable">;
  getMirrorStatus(): Promise<{ status: "current" | "delayed"; revision: number | null }>;
  setMirrorStatus(value: { status: "current" | "delayed"; revision: number | null }): Promise<void>;
}

export interface RecoveryMirror {
  write(document: ControlPlaneDocumentV2): Promise<void>;
}

export interface DeferredTasks {
  run(promise: Promise<unknown>): void;
}

export interface LoadedControlPlaneSnapshot {
  document: ControlPlaneDocumentV2;
  etag: string;
}

export interface ControlMutationResult<T> {
  changed: boolean;
  next: ControlPlaneDocumentV2;
  result: T;
}

export type ControlMutationReducer<T> = (
  current: ControlPlaneDocumentV2
) => ControlMutationResult<T>;

export interface ControlPlaneStore {
  load(): Promise<LoadedControlPlaneSnapshot>;
  mutate<T>(name: string, reducer: ControlMutationReducer<T>): Promise<T>;
}

export type ControlPlaneStoreErrorCode =
  | "CONTROL_PLANE_CONFLICT"
  | "CONTROL_PLANE_INVALID"
  | "CONTROL_PLANE_UNAVAILABLE";

export class ControlPlaneStoreError extends Error {
  readonly code: ControlPlaneStoreErrorCode;

  constructor(code: ControlPlaneStoreErrorCode) {
    super(code);
    this.name = "ControlPlaneStoreError";
    this.code = code;
  }
}

export interface CreateControlPlaneStoreOptions {
  durable: ControlDurableStore;
  cache: ControlHotCache;
  mirror: RecoveryMirror;
  deferred: DeferredTasks;
  keyring: VersionedAeadKeyring;
  now?: () => Date;
}

function unavailable(): ControlPlaneStoreError {
  return new ControlPlaneStoreError("CONTROL_PLANE_UNAVAILABLE");
}

function conflict(): ControlPlaneStoreError {
  return new ControlPlaneStoreError("CONTROL_PLANE_CONFLICT");
}

function invalid(): ControlPlaneStoreError {
  return new ControlPlaneStoreError("CONTROL_PLANE_INVALID");
}

function isConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "CONTROL_PLANE_CONFLICT"
  );
}

function isCorruptCache(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "CONTROL_CACHE_CORRUPT"
  );
}

function isNotModified(
  value: StoredControlEnvelope | { notModified: true } | null
): value is { notModified: true } {
  return value !== null && "notModified" in value && value.notModified === true;
}

async function replaceCacheBestEffort(
  cache: ControlHotCache,
  value: StoredControlEnvelope
): Promise<void> {
  try {
    await cache.set(value, CONTROL_CACHE_TTL_SECONDS);
  } catch {
    await deleteCacheBestEffort(cache);
  }
}

async function deleteCacheBestEffort(cache: ControlHotCache): Promise<void> {
  try {
    const outcome = await cache.delete();
    if (outcome === "unverifiable") {
      // Blob revalidation, not cache deletion, protects correctness.
      return;
    }
  } catch {
    // The complete origin read below does not trust this cache entry.
  }
}

export function createControlPlaneStore(
  options: CreateControlPlaneStoreOptions
): ControlPlaneStore {
  const { cache, deferred, durable, keyring, mirror } = options;
  const now = options.now ?? (() => new Date());

  function open(stored: StoredControlEnvelope): LoadedControlPlaneSnapshot {
    return {
      document: cloneControlPlaneDocument(
        decryptControlPlaneEnvelope(stored.envelope, keyring.keys)
      ),
      etag: stored.etag
    };
  }

  async function loadFresh(
    maintainCache: boolean
  ): Promise<LoadedControlPlaneSnapshot> {
    let stored: StoredControlEnvelope | { notModified: true } | null;
    try {
      stored = await durable.read();
    } catch {
      throw unavailable();
    }

    if (stored === null || isNotModified(stored)) {
      throw unavailable();
    }

    let snapshot: LoadedControlPlaneSnapshot;
    try {
      snapshot = open(stored);
    } catch {
      throw unavailable();
    }
    if (maintainCache) {
      await replaceCacheBestEffort(cache, stored);
    }
    return snapshot;
  }

  async function loadSnapshot(
    maintainCache: boolean
  ): Promise<LoadedControlPlaneSnapshot> {
    let cached: StoredControlEnvelope | null = null;
    try {
      cached = await cache.get();
    } catch (error) {
      if (maintainCache && isCorruptCache(error)) {
        await deleteCacheBestEffort(cache);
      }
      cached = null;
    }

    if (cached === null) {
      return loadFresh(maintainCache);
    }

    let durableResult: StoredControlEnvelope | { notModified: true } | null;
    try {
      durableResult = await durable.read(cached.etag);
    } catch {
      throw unavailable();
    }

    if (durableResult === null) {
      throw unavailable();
    }

    if (isNotModified(durableResult)) {
      try {
        return open(cached);
      } catch {
        if (maintainCache) {
          await deleteCacheBestEffort(cache);
        }
        return loadFresh(maintainCache);
      }
    }

    let snapshot: LoadedControlPlaneSnapshot;
    try {
      snapshot = open(durableResult);
    } catch {
      throw unavailable();
    }
    if (maintainCache) {
      await replaceCacheBestEffort(cache, durableResult);
    }
    return snapshot;
  }

  async function load(): Promise<LoadedControlPlaneSnapshot> {
    return loadSnapshot(true);
  }

  async function mirrorCommittedDocument(
    document: ControlPlaneDocumentV2
  ): Promise<void> {
    for (let attempt = 1; attempt <= MAX_MIRROR_ATTEMPTS; attempt += 1) {
      try {
        await mirror.write(cloneControlPlaneDocument(document));
        try {
          await cache.setMirrorStatus({ status: "current", revision: document.revision });
        } catch {
          // Recovery status is diagnostic only; the recovery write succeeded.
        }
        return;
      } catch {
        if (attempt === MAX_MIRROR_ATTEMPTS) {
          try {
            await cache.setMirrorStatus({ status: "delayed", revision: document.revision });
          } catch {
            // The authoritative Blob commit and mirror retry result are unchanged.
          }
        }
      }
    }
  }

  async function mutate<T>(
    name: string,
    reducer: ControlMutationReducer<T>
  ): Promise<T> {
    void name;
    const updatedAt = now().toISOString();
    let current = await loadSnapshot(false);

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt += 1) {
      const mutation = reducer(cloneControlPlaneDocument(current.document));
      if (!mutation.changed) {
        return mutation.result;
      }
      if (mutation.next.revision !== current.document.revision + 1) {
        throw invalid();
      }

      let next: ControlPlaneDocumentV2;
      try {
        next = parseControlPlaneDocument({ ...mutation.next, updatedAt });
      } catch {
        throw invalid();
      }
      const envelope = encryptControlPlaneDocument(next, keyring);

      try {
        const committed = await durable.replace(envelope, current.etag);
        await replaceCacheBestEffort(cache, { envelope, etag: committed.etag });
        deferred.run(mirrorCommittedDocument(next));
        return mutation.result;
      } catch (error) {
        if (!isConflict(error)) {
          throw unavailable();
        }
        if (attempt === MAX_CAS_ATTEMPTS) {
          throw conflict();
        }
        current = await loadFresh(false);
      }
    }

    throw conflict();
  }

  return { load, mutate };
}
