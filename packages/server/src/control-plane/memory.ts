import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import type { VersionedAeadKeyring } from "../crypto/aead";
import type { ControlPlaneTelemetryObserver } from "./telemetry";
import {
  decryptControlPlaneEnvelope,
  encryptControlPlaneDocument,
  type ControlPlaneEnvelopeV1
} from "./envelope";
import { cloneControlPlaneDocument } from "./schema";
import {
  ControlPlaneStoreError,
  createControlPlaneStore,
  type ControlDurableStore,
  type ControlHotCache,
  type DeferredTasks,
  type RecoveryMirror,
  type StoredControlEnvelope
} from "./store";

type MirrorStatus = Awaited<ReturnType<ControlHotCache["getMirrorStatus"]>>;

function cloneStored(value: StoredControlEnvelope): StoredControlEnvelope {
  return structuredClone(value);
}

export class MemoryControlDurableStore implements ControlDurableStore {
  readCount = 0;
  writeAttempts = 0;
  lastIfNoneMatch: string | undefined;
  readonly ifNoneMatches: Array<string | undefined> = [];
  private value: StoredControlEnvelope | null;
  private etagCounter: number;

  constructor(
    initial: StoredControlEnvelope | null,
    private conflictsRemaining = 0,
    private readonly keys?: Record<string, Uint8Array>,
    private replaceFailuresRemaining = 0
  ) {
    this.value = initial === null ? null : cloneStored(initial);
    this.etagCounter = initial === null
      ? 0
      : Number.parseInt(initial.etag.replace(/^etag-/, ""), 10) || 1;
  }

  get currentEtag(): string | undefined {
    return this.value?.etag;
  }

  get currentRevision(): number | undefined {
    return this.value?.envelope.revision;
  }

  get currentDocument(): ControlPlaneDocumentV2 | undefined {
    if (!this.value || !this.keys) return undefined;
    try {
      return decryptControlPlaneEnvelope(this.value.envelope, this.keys);
    } catch {
      return undefined;
    }
  }

  async inspect() {
    return this.value === null
      ? { status: "missing" as const }
      : { status: "present" as const, etag: this.value.etag };
  }

  async read(ifNoneMatch?: string) {
    this.readCount += 1;
    this.lastIfNoneMatch = ifNoneMatch;
    this.ifNoneMatches.push(ifNoneMatch);
    if (this.value === null) return null;
    if (ifNoneMatch !== undefined && ifNoneMatch === this.value.etag) {
      return { notModified: true } as const;
    }
    return cloneStored(this.value);
  }

  async create(envelope: ControlPlaneEnvelopeV1): Promise<{ etag: string }> {
    const etag = this.nextEtag();
    this.value = { envelope: structuredClone(envelope), etag };
    return { etag };
  }

  async replace(
    envelope: ControlPlaneEnvelopeV1,
    expectedEtag: string
  ): Promise<{ etag: string }> {
    this.writeAttempts += 1;
    if (this.replaceFailuresRemaining > 0) {
      this.replaceFailuresRemaining -= 1;
      throw new Error("Injected durable replace failure");
    }
    if (
      this.conflictsRemaining > 0 ||
      this.value === null ||
      this.value.etag !== expectedEtag
    ) {
      if (this.conflictsRemaining > 0) this.conflictsRemaining -= 1;
      throw new ControlPlaneStoreError("CONTROL_PLANE_CONFLICT");
    }
    const etag = this.nextEtag();
    this.value = { envelope: structuredClone(envelope), etag };
    return { etag };
  }

  replaceOutOfBand(document: ControlPlaneDocumentV2, keyring?: VersionedAeadKeyring): void {
    if (!keyring && !this.keys) {
      throw new Error("A keyring is required");
    }
    const activeKeyring = keyring ?? {
      currentVersion: Object.keys(this.keys!)[0],
      keys: this.keys!
    };
    const etag = this.nextEtag();
    this.value = {
      envelope: encryptControlPlaneDocument(document, activeKeyring),
      etag
    };
  }

  removeOutOfBand(): void {
    this.value = null;
  }

  corruptOutOfBand(): void {
    const etag = this.nextEtag();
    this.value = {
      envelope: { broken: "ciphertext" } as unknown as ControlPlaneEnvelopeV1,
      etag
    };
  }

  private nextEtag(): string {
    this.etagCounter += 1;
    return `etag-${this.etagCounter}`;
  }
}

export class MemoryControlHotCache implements ControlHotCache {
  deleteCount = 0;
  setCount = 0;
  lastTtlSeconds: number | undefined;
  private value: StoredControlEnvelope | null = null;
  private mirrorStatus: MirrorStatus = { status: "current", revision: null };

  constructor(private setFailuresRemaining = 0) {}

  get currentEtag(): string | undefined {
    return this.value?.etag;
  }

  get currentRevision(): number | undefined {
    return this.value?.envelope.revision;
  }

  async get(): Promise<StoredControlEnvelope | null> {
    return this.value === null ? null : cloneStored(this.value);
  }

  async set(value: StoredControlEnvelope, ttlSeconds: number): Promise<void> {
    this.setCount += 1;
    this.lastTtlSeconds = ttlSeconds;
    if (this.setFailuresRemaining > 0) {
      this.setFailuresRemaining -= 1;
      throw new Error("Injected cache set failure");
    }
    this.value = cloneStored(value);
  }

  async delete(key?: string): Promise<"confirmed"> {
    void key;
    this.deleteCount += 1;
    this.value = null;
    return "confirmed";
  }

  async getMirrorStatus(): Promise<MirrorStatus> {
    return structuredClone(this.mirrorStatus);
  }

  async setMirrorStatus(value: MirrorStatus): Promise<void> {
    this.mirrorStatus = structuredClone(value);
  }

  replaceOutOfBand(value: unknown): void {
    this.value = structuredClone(value) as StoredControlEnvelope;
  }
}

export function createMemoryControlHotCache(
  setFailures = 0
): MemoryControlHotCache {
  return new MemoryControlHotCache(setFailures);
}

export class MemoryRecoveryMirror implements RecoveryMirror {
  writeCount = 0;
  lastDocument: ControlPlaneDocumentV2 | undefined;

  constructor(private failuresRemaining = 0) {}

  async write(document: ControlPlaneDocumentV2): Promise<void> {
    this.writeCount += 1;
    this.lastDocument = cloneControlPlaneDocument(document);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("Injected mirror failure");
    }
  }
}

export class MemoryDeferredTasks implements DeferredTasks {
  private pending: Promise<unknown>[] = [];

  run(promise: Promise<unknown>): void {
    this.pending.push(promise);
  }

  async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
  }
}

export interface ControlStoreHarnessOptions {
  cacheSetFailures?: number;
  conflicts?: number;
  mirrorFailures?: number;
  replaceFailures?: number;
  observer?: ControlPlaneTelemetryObserver;
  requestId?: string;
}

export function controlStoreHarness(
  document: ControlPlaneDocumentV2,
  options: ControlStoreHarnessOptions = {}
) {
  const keyring: VersionedAeadKeyring = {
    currentVersion: "v1",
    keys: { v1: Buffer.alloc(32, 7) }
  };
  const initial = {
    envelope: encryptControlPlaneDocument(document, keyring),
    etag: "etag-1"
  };
  const durable = new MemoryControlDurableStore(
    initial,
    options.conflicts,
    keyring.keys,
    options.replaceFailures
  );
  const cache = createMemoryControlHotCache(options.cacheSetFailures);
  cache.replaceOutOfBand(initial);
  const mirror = new MemoryRecoveryMirror(options.mirrorFailures);
  const deferred = new MemoryDeferredTasks();
  const store = createControlPlaneStore({
    durable,
    cache,
    mirror,
    deferred,
    keyring,
    householdId: document.householdId,
    requestId: () => options.requestId ?? "test-request",
    observer: options.observer
  });

  return {
    cache,
    cacheKey: `v2:test:${document.householdId}`,
    deferred,
    durable,
    mirror,
    store
  };
}
