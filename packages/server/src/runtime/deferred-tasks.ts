export interface DeferredTaskTracker {
  run(promise: Promise<unknown>): void;
  drain(timeoutMs: number): Promise<void>;
  pending(): number;
}

export function createDeferredTaskTracker(): DeferredTaskTracker {
  const tasks = new Set<Promise<void>>();

  return {
    run(promise) {
      const tracked = Promise.resolve(promise)
        .catch(() => undefined)
        .then(() => undefined);
      tasks.add(tracked);
      void tracked.finally(() => tasks.delete(tracked));
    },
    async drain(timeoutMs) {
      const snapshot = [...tasks];
      if (snapshot.length === 0) return;
      const boundedTimeout = Number.isFinite(timeoutMs)
        ? Math.max(0, Math.trunc(timeoutMs))
        : 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(snapshot).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, boundedTimeout);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    pending: () => tasks.size,
  };
}
