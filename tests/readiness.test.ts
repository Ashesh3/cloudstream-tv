import { describe, expect, it } from "vitest";
import {
  createDeferredTaskTracker,
  createReadinessController,
} from "@cloudframe/server";

describe("self-hosted readiness", () => {
  it("tracks startup, terminal failures, and draining without losing liveness", () => {
    const readiness = createReadinessController();
    expect(readiness.snapshot()).toEqual({ live: true, ready: false, draining: false });

    readiness.markReady();
    expect(readiness.snapshot()).toEqual({ live: true, ready: true, draining: false });

    readiness.beginDrain();
    expect(readiness.snapshot()).toEqual({ live: true, ready: false, draining: true });

    readiness.fail("SQLITE_UNAVAILABLE");
    expect(readiness.snapshot()).toEqual({
      live: true,
      ready: false,
      draining: true,
      errorCode: "SQLITE_UNAVAILABLE",
    });
  });

  it("drains only the tasks present at the start and handles rejections", async () => {
    const tracker = createDeferredTaskTracker();
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    tracker.run(first);
    tracker.run(Promise.reject(new Error("background failure")));
    expect(tracker.pending()).toBe(2);

    const drain = tracker.drain(1_000);
    tracker.run(new Promise<void>(() => undefined));
    release();
    await drain;

    expect(tracker.pending()).toBe(1);
  });

  it("returns when the drain timeout elapses", async () => {
    const tracker = createDeferredTaskTracker();
    tracker.run(new Promise<void>(() => undefined));
    const started = performance.now();

    await tracker.drain(10);

    expect(performance.now() - started).toBeGreaterThanOrEqual(5);
    expect(tracker.pending()).toBe(1);
  });
});
