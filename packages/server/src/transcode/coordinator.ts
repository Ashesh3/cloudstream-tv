import { randomBytes } from "node:crypto";
import type { ProviderKind } from "@cloudframe/shared";
import type { TranscodeCache } from "./cache.ts";
import type { TranscodeCatalog } from "./catalog.ts";
import type { MediaProbeService } from "./probe.ts";
import { cacheIdentity, type TranscodeProfile } from "./profile.ts";
import type { TranscodeSourceGateway } from "./source-gateway.ts";
import type { AuthorizedTranscodeSource } from "./source-authorizer.ts";
import {
  TranscodeError,
  type MediaProbe,
  type TranscodeErrorCode,
  type TranscodeSegmentFile,
  type TranscodeSourceBinding,
} from "./types.ts";
import type { TranscodeProgress, WindowEncoder } from "./window-encoder.ts";

const LEASE_MS = 45_000;

export interface TranscodePlaybackSession {
  id: string;
  binding: TranscodeSourceBinding;
  cacheKey: string;
  probe: MediaProbe;
  profile: TranscodeProfile;
  expiresAt: number;
}

export interface TranscodeDiagnosticSnapshot {
  active: null | {
    sessionIdSuffix: string;
    itemName: string;
    provider: ProviderKind;
    stage: "probing" | "encoding";
    windowIndex: number | null;
    progressPercent: number | null;
    speed: string | null;
  };
  leaseDeviceName: string | null;
  queuedDemandedWindows: number;
  busyRejections: number;
  cacheBytes: number;
  lastErrorCode: TranscodeErrorCode | null;
}

export interface TranscodeCoordinator {
  createSession(source: AuthorizedTranscodeSource): Promise<TranscodePlaybackSession>;
  session(sessionId: string): TranscodePlaybackSession | null;
  heartbeat(sessionId: string, deviceId: string): void;
  segment(sessionId: string, segmentIndex: number, signal: AbortSignal): Promise<TranscodeSegmentFile>;
  playbackFailure(sessionId: string): { code: TranscodeErrorCode } | null;
  release(sessionId: string, deviceId: string): Promise<void>;
  diagnostic(): TranscodeDiagnosticSnapshot;
  close(): Promise<void>;
}

type TimerHandle = ReturnType<typeof setInterval>;

interface SessionState extends TranscodePlaybackSession {
  deviceName: string;
  releaseActivePin: () => void;
  playbackFailureCode: TranscodeErrorCode | null;
}

interface SegmentWaiter {
  resolve(value: TranscodeSegmentFile): void;
  reject(error: TranscodeError): void;
  signal: AbortSignal;
  abort: () => void;
}

interface WindowJob {
  sessionId: string;
  cacheKey: string;
  windowIndex: number;
  priority: "demand" | "prefetch";
  controller: AbortController;
  promise: Promise<void> | null;
  progress: TranscodeProgress | null;
  releaseGeneratingPin: (() => void) | null;
}

export function createTranscodeCoordinator(options: {
  gateway: Pick<TranscodeSourceGateway, "grant">;
  probe: MediaProbeService;
  catalog: Pick<TranscodeCatalog,
    "loadAsset" | "upsertProbe" | "window" | "touchAsset" | "touchSegment" | "totalBytes">;
  cache: Pick<TranscodeCache,
    "loadSegment" | "ensureCapacity" | "pinActive" | "pinGenerating" | "totalBytes">;
  encoder: WindowEncoder;
  profile: TranscodeProfile;
  now?: () => Date;
  createId?: () => string;
  createJobId?: () => string;
  setInterval?: (callback: () => void, milliseconds: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}): TranscodeCoordinator {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => randomBytes(32).toString("base64url"));
  const createJobId = options.createJobId ?? (() => randomBytes(32).toString("base64url"));
  const scheduleInterval = options.setInterval ?? setInterval;
  const cancelInterval = options.clearInterval ?? clearInterval;
  const sessions = new Map<string, SessionState>();
  const waiters = new Map<string, Set<SegmentWaiter>>();
  const demandedQueue: WindowJob[] = [];
  const queuedKeys = new Set<string>();
  let prefetchQueued: WindowJob | null = null;
  let activeJob: WindowJob | null = null;
  let activeProbe: { sessionId: string; controller: AbortController } | null = null;
  let closed = false;
  let busyRejections = 0;
  let lastErrorCode: TranscodeErrorCode | null = null;
  let leaseSessionId: string | null = null;
  const sweepTimer = scheduleInterval(() => sweepExpired(), 5_000);

  async function createSession(source: AuthorizedTranscodeSource): Promise<TranscodePlaybackSession> {
    if (closed) throw expired();
    sweepExpired();
    const lease = leaseSessionId ? sessions.get(leaseSessionId) : undefined;
    if (lease) {
      if (lease.binding.deviceId !== source.binding.deviceId) {
        busyRejections += 1;
        throw new TranscodeError("TRANSCODER_BUSY");
      }
      if (sameBinding(lease.binding, source.binding)) {
        renew(lease);
        return publicSession(lease);
      }
      await expireSession(lease, true);
    }

    const cacheKey = cacheIdentity(source.binding, options.profile);
    let asset = options.catalog.loadAsset(cacheKey);
    if (!asset) {
      if (activeJob || activeProbe) {
        busyRejections += 1;
        throw new TranscodeError("TRANSCODER_BUSY");
      }
      const provisionalId = createId();
      const controller = new AbortController();
      activeProbe = { sessionId: provisionalId, controller };
      const grant = options.gateway.grant(source.binding, createJobId());
      try {
        const probed = await options.probe.probe(grant.inputUrl, controller.signal);
        const segmentCount = Math.ceil(probed.durationMs / options.profile.segmentDurationMs);
        options.catalog.upsertProbe(cacheKey, options.profile.id, probed, segmentCount, now().getTime());
        asset = options.catalog.loadAsset(cacheKey) ?? {
          cacheKey,
          profileId: options.profile.id,
          durationMs: probed.durationMs,
          segmentCount,
          probe: probed,
          totalBytes: 0,
          lastAccessedAt: now().getTime(),
        };
      } catch (error) {
        const normalized = normalizeError(error, "TRANSCODER_SOURCE_UNAVAILABLE");
        lastErrorCode = normalized.code;
        throw normalized;
      } finally {
        grant.revoke();
        activeProbe = null;
      }
    }

    const id = createId();
    const state: SessionState = {
      id,
      binding: structuredClone(source.binding),
      cacheKey,
      probe: structuredClone(asset.probe),
      profile: { ...options.profile },
      expiresAt: now().getTime() + LEASE_MS,
      deviceName: source.auth.device.name,
      releaseActivePin: options.cache.pinActive(cacheKey),
      playbackFailureCode: null,
    };
    sessions.set(id, state);
    leaseSessionId = id;
    options.catalog.touchAsset(cacheKey, now().getTime());
    return publicSession(state);
  }

  function session(sessionId: string): TranscodePlaybackSession | null {
    sweepExpired();
    const value = sessions.get(sessionId);
    if (!value) return null;
    renew(value);
    return publicSession(value);
  }

  function heartbeat(sessionId: string, deviceId: string): void {
    sweepExpired();
    const value = sessions.get(sessionId);
    if (!value || value.binding.deviceId !== deviceId) throw expired();
    renew(value);
  }

  async function segment(
    sessionId: string,
    segmentIndex: number,
    signal: AbortSignal,
  ): Promise<TranscodeSegmentFile> {
    sweepExpired();
    const sessionState = sessions.get(sessionId);
    const segmentCount = sessionState
      ? Math.ceil(sessionState.probe.durationMs / sessionState.profile.segmentDurationMs)
      : 0;
    if (
      !sessionState ||
      !Number.isSafeInteger(segmentIndex) ||
      segmentIndex < 0 ||
      segmentIndex >= segmentCount ||
      signal.aborted
    ) throw expired();
    renew(sessionState);
    const cached = await cachedSegment(sessionState, segmentIndex);
    if (cached) return cached;

    const waiterKey = segmentWaiterKey(sessionState.cacheKey, segmentIndex);
    const promised = new Promise<TranscodeSegmentFile>((resolve, reject) => {
      const waiter: SegmentWaiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          removeWaiter(waiterKey, waiter);
          reject(expired());
          cancelObsoleteActiveJob();
        },
      };
      let set = waiters.get(waiterKey);
      if (!set) {
        set = new Set();
        waiters.set(waiterKey, set);
      }
      set.add(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
    });

    const raced = await cachedSegment(sessionState, segmentIndex);
    if (raced) resolveSegmentWaiters(sessionState.cacheKey, segmentIndex, raced);
    else enqueueDemand(sessionState, Math.floor(segmentIndex / sessionState.profile.segmentsPerWindow));
    return promised;
  }

  async function release(sessionId: string, deviceId: string): Promise<void> {
    const state = sessions.get(sessionId);
    if (!state || state.binding.deviceId !== deviceId) throw expired();
    await expireSession(state, true);
  }

  function playbackFailure(sessionId: string): { code: TranscodeErrorCode } | null {
    const state = sessions.get(sessionId);
    if (!state?.playbackFailureCode) return null;
    const code = state.playbackFailureCode;
    state.playbackFailureCode = null;
    return { code };
  }

  function diagnostic(): TranscodeDiagnosticSnapshot {
    sweepExpired();
    const lease = leaseSessionId ? sessions.get(leaseSessionId) : undefined;
    const activeSession = activeJob ? sessions.get(activeJob.sessionId) : undefined;
    const progress = activeJob?.progress;
    const startMs = activeJob && activeSession
      ? activeJob.windowIndex * activeSession.profile.windowDurationMs
      : 0;
    const progressPercent = activeJob && activeSession && progress?.outTimeMs !== null && progress?.outTimeMs !== undefined
      ? Math.max(0, Math.min(100, Math.round((progress.outTimeMs / Math.min(activeSession.profile.windowDurationMs, activeSession.probe.durationMs - startMs)) * 100)))
      : null;
    return {
      active: activeProbe
        ? {
            sessionIdSuffix: activeProbe.sessionId.slice(-8),
            itemName: lease?.binding.name ?? "",
            provider: lease?.binding.provider ?? "google",
            stage: "probing",
            windowIndex: null,
            progressPercent: null,
            speed: null,
          }
        : activeJob && activeSession
          ? {
              sessionIdSuffix: activeJob.sessionId.slice(-8),
              itemName: activeSession.binding.name,
              provider: activeSession.binding.provider,
              stage: "encoding",
              windowIndex: activeJob.windowIndex,
              progressPercent,
              speed: progress?.speed ?? null,
            }
          : null,
      leaseDeviceName: lease?.deviceName ?? null,
      queuedDemandedWindows: demandedQueue.length,
      busyRejections,
      cacheBytes: options.cache.totalBytes(),
      lastErrorCode,
    };
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    cancelInterval(sweepTimer);
    activeProbe?.controller.abort();
    activeJob?.controller.abort();
    rejectAllWaiters(expired());
    demandedQueue.splice(0);
    queuedKeys.clear();
    prefetchQueued = null;
    const activePromise = activeJob?.promise;
    for (const value of [...sessions.values()]) releaseSessionState(value);
    sessions.clear();
    leaseSessionId = null;
    await activePromise?.catch(() => undefined);
  }

  function enqueueDemand(sessionState: SessionState, windowIndex: number): void {
    const key = windowKey(sessionState.cacheKey, windowIndex);
    if (activeJob?.cacheKey === sessionState.cacheKey && activeJob.windowIndex === windowIndex) {
      activeJob.priority = "demand";
      return;
    }
    if (queuedKeys.has(key)) return;
    if (activeJob?.priority === "prefetch" && !windowHasWaiters(activeJob.cacheKey, activeJob.windowIndex)) {
      activeJob.controller.abort();
    }
    if (prefetchQueued?.cacheKey === sessionState.cacheKey && prefetchQueued.windowIndex === windowIndex) {
      prefetchQueued.priority = "demand";
      demandedQueue.unshift(prefetchQueued);
      queuedKeys.add(key);
      prefetchQueued = null;
    } else {
      demandedQueue.push(makeJob(sessionState, windowIndex, "demand"));
      queuedKeys.add(key);
    }
    void startNextJob();
  }

  function queuePrefetch(sessionState: SessionState, windowIndex: number): void {
    const totalWindows = Math.ceil(
      Math.ceil(sessionState.probe.durationMs / sessionState.profile.segmentDurationMs) /
        sessionState.profile.segmentsPerWindow,
    );
    if (
      closed ||
      windowIndex >= totalWindows ||
      options.catalog.window(sessionState.cacheKey, windowIndex)?.state === "complete" ||
      demandedQueue.length > 0 ||
      prefetchQueued ||
      (activeJob?.cacheKey === sessionState.cacheKey && activeJob.windowIndex === windowIndex)
    ) return;
    prefetchQueued = makeJob(sessionState, windowIndex, "prefetch");
    void startNextJob();
  }

  function makeJob(sessionState: SessionState, windowIndex: number, priority: "demand" | "prefetch"): WindowJob {
    return {
      sessionId: sessionState.id,
      cacheKey: sessionState.cacheKey,
      windowIndex,
      priority,
      controller: new AbortController(),
      promise: null,
      progress: null,
      releaseGeneratingPin: null,
    };
  }

  async function startNextJob(): Promise<void> {
    if (closed || activeJob || activeProbe) return;
    const job = demandedQueue.shift() ?? prefetchQueued;
    if (!job) return;
    if (job === prefetchQueued) prefetchQueued = null;
    queuedKeys.delete(windowKey(job.cacheKey, job.windowIndex));
    const sessionState = sessions.get(job.sessionId);
    if (!sessionState) {
      void startNextJob();
      return;
    }
    activeJob = job;
    job.releaseGeneratingPin = options.cache.pinGenerating(job.cacheKey, job.windowIndex);
    job.promise = runJob(job, sessionState);
    await job.promise.catch(() => undefined);
  }

  async function runJob(job: WindowJob, sessionState: SessionState): Promise<void> {
    let completed = false;
    try {
      await options.cache.ensureCapacity(0);
      const result = await options.encoder.encode({
        jobId: createJobId(),
        cacheKey: sessionState.cacheKey,
        binding: sessionState.binding,
        probe: sessionState.probe,
        windowIndex: job.windowIndex,
        signal: job.controller.signal,
        onProgress: (progress) => { job.progress = progress; },
        onSegmentPromoted: (segmentIndex) => {
          void cachedSegment(sessionState, segmentIndex).then((file) => {
            if (file) resolveSegmentWaiters(sessionState.cacheKey, segmentIndex, file);
          });
        },
      });
      completed = result.complete;
      if (!completed) throw new TranscodeError("TRANSCODER_FAILED");
      await rejectMissingWindowWaiters(sessionState, job.windowIndex, new TranscodeError("TRANSCODER_FAILED"));
    } catch (error) {
      const normalized = job.controller.signal.aborted
        ? expired()
        : normalizeError(error, "TRANSCODER_FAILED");
      if (!job.controller.signal.aborted) {
        lastErrorCode = normalized.code;
        sessionState.playbackFailureCode = normalized.code;
      }
      rejectWindowWaiters(sessionState.cacheKey, job.windowIndex, normalized);
    } finally {
      job.releaseGeneratingPin?.();
      if (activeJob === job) activeJob = null;
      if (completed && job.priority === "demand" && sessions.has(sessionState.id)) {
        queuePrefetch(sessionState, job.windowIndex + 1);
      }
      void startNextJob();
    }
  }

  async function cachedSegment(sessionState: SessionState, segmentIndex: number): Promise<TranscodeSegmentFile | null> {
    const stored = await options.cache.loadSegment(sessionState.cacheKey, segmentIndex);
    if (!stored) return null;
    options.catalog.touchSegment(sessionState.cacheKey, segmentIndex, now().getTime());
    return stored;
  }

  function resolveSegmentWaiters(cacheKey: string, segmentIndex: number, file: TranscodeSegmentFile): void {
    const key = segmentWaiterKey(cacheKey, segmentIndex);
    const set = waiters.get(key);
    if (!set) return;
    waiters.delete(key);
    for (const waiter of set) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(file);
    }
  }

  function rejectWindowWaiters(cacheKey: string, windowIndex: number, error: TranscodeError): void {
    for (const [key, set] of [...waiters]) {
      const [waiterCacheKey, rawIndex] = splitWaiterKey(key);
      if (waiterCacheKey !== cacheKey) continue;
      const index = Number(rawIndex);
      if (Math.floor(index / options.profile.segmentsPerWindow) !== windowIndex) continue;
      waiters.delete(key);
      for (const waiter of set) {
        waiter.signal.removeEventListener("abort", waiter.abort);
        waiter.reject(error);
      }
    }
  }

  async function rejectMissingWindowWaiters(sessionState: SessionState, windowIndex: number, error: TranscodeError): Promise<void> {
    for (let offset = 0; offset < sessionState.profile.segmentsPerWindow; offset += 1) {
      const index = windowIndex * sessionState.profile.segmentsPerWindow + offset;
      const file = await cachedSegment(sessionState, index);
      if (file) resolveSegmentWaiters(sessionState.cacheKey, index, file);
    }
    rejectWindowWaiters(sessionState.cacheKey, windowIndex, error);
  }

  function windowHasWaiters(cacheKey: string, windowIndex: number): boolean {
    for (const key of waiters.keys()) {
      const [waiterCacheKey, rawIndex] = splitWaiterKey(key);
      if (waiterCacheKey === cacheKey && Math.floor(Number(rawIndex) / options.profile.segmentsPerWindow) === windowIndex) return true;
    }
    return false;
  }

  function cancelObsoleteActiveJob(): void {
    if (activeJob && !windowHasWaiters(activeJob.cacheKey, activeJob.windowIndex)) {
      activeJob.controller.abort();
    }
  }

  function removeWaiter(key: string, waiter: SegmentWaiter): void {
    const set = waiters.get(key);
    set?.delete(waiter);
    if (set?.size === 0) waiters.delete(key);
  }

  function sweepExpired(): void {
    const currentTime = now().getTime();
    for (const value of [...sessions.values()]) {
      if (value.expiresAt <= currentTime) void expireSession(value, true);
    }
  }

  async function expireSession(state: SessionState, abortWork: boolean): Promise<void> {
    sessions.delete(state.id);
    if (leaseSessionId === state.id) leaseSessionId = null;
    releaseSessionState(state);
    for (let index = demandedQueue.length - 1; index >= 0; index -= 1) {
      if (demandedQueue[index]!.sessionId === state.id) demandedQueue.splice(index, 1);
    }
    if (prefetchQueued?.sessionId === state.id) prefetchQueued = null;
    rejectSessionWaiters(state.id, expired());
    if (abortWork && activeJob?.sessionId === state.id) activeJob.controller.abort();
  }

  function releaseSessionState(state: SessionState): void {
    state.releaseActivePin();
  }

  function rejectSessionWaiters(sessionId: string, error: TranscodeError): void {
    const state = sessions.get(sessionId);
    if (state) {
      for (const [key, set] of [...waiters]) {
        if (!key.startsWith(`${state.cacheKey}:`)) continue;
        waiters.delete(key);
        for (const waiter of set) waiter.reject(error);
      }
      return;
    }
    // A removed session can still own the active job.
    if (activeJob?.sessionId === sessionId) rejectWindowWaiters(activeJob.cacheKey, activeJob.windowIndex, error);
  }

  function rejectAllWaiters(error: TranscodeError): void {
    for (const set of waiters.values()) for (const waiter of set) waiter.reject(error);
    waiters.clear();
  }

  function renew(state: SessionState): void {
    state.expiresAt = now().getTime() + LEASE_MS;
  }

  return { createSession, session, heartbeat, segment, playbackFailure, release, diagnostic, close };
}

function sameBinding(left: TranscodeSourceBinding, right: TranscodeSourceBinding): boolean {
  return left.householdId === right.householdId &&
    left.deviceId === right.deviceId &&
    left.deviceSessionVersion === right.deviceSessionVersion &&
    left.sourceId === right.sourceId &&
    left.rootId === right.rootId &&
    left.rootProviderNodeId === right.rootProviderNodeId &&
    left.providerNodeId === right.providerNodeId &&
    left.provider === right.provider &&
    left.contentRevision === right.contentRevision &&
    left.size === right.size &&
    left.credentialVersion === right.credentialVersion;
}

function publicSession(state: SessionState): TranscodePlaybackSession {
  return {
    id: state.id,
    binding: structuredClone(state.binding),
    cacheKey: state.cacheKey,
    probe: structuredClone(state.probe),
    profile: { ...state.profile },
    expiresAt: state.expiresAt,
  };
}

function normalizeError(error: unknown, fallback: TranscodeErrorCode): TranscodeError {
  return error instanceof TranscodeError ? error : new TranscodeError(fallback);
}

function expired(): TranscodeError {
  return new TranscodeError("TRANSCODER_SESSION_EXPIRED");
}

function windowKey(cacheKey: string, windowIndex: number): string {
  return `${cacheKey}:${windowIndex}`;
}

function segmentWaiterKey(cacheKey: string, segmentIndex: number): string {
  return `${cacheKey}:${segmentIndex}`;
}

function splitWaiterKey(key: string): [string, string] {
  const separator = key.lastIndexOf(":");
  return [key.slice(0, separator), key.slice(separator + 1)];
}
