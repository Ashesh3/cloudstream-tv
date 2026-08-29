import { describe, expect, it, vi } from "vitest";
import { createHttpRequestTracker } from "@cloudframe/server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("HTTP request drain", () => {
  it("waits for the listening server and every tracked request before resolving", async () => {
    const request = deferred<void>();
    let closeCallback!: (error?: Error) => void;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { closeCallback = callback; }),
      closeAllConnections: vi.fn(),
    };
    const tracker = createHttpRequestTracker();
    const controller = new AbortController();
    void tracker.run(controller, request.promise);

    const draining = tracker.drain(server as never, 1_000);
    let resolved = false;
    void draining.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(server.close).toHaveBeenCalledTimes(1);

    request.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    closeCallback();

    await draining;
    expect(tracker.activeCount()).toBe(0);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it("aborts active requests and closes their sockets after the drain deadline", async () => {
    vi.useFakeTimers();
    const request = deferred<void>();
    let closeCallback!: (error?: Error) => void;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { closeCallback = callback; }),
      closeAllConnections: vi.fn(() => closeCallback()),
    };
    const tracker = createHttpRequestTracker();
    const controller = new AbortController();
    void tracker.run(controller, request.promise);

    const draining = tracker.drain(server as never, 100);
    await vi.advanceTimersByTimeAsync(100);

    expect(controller.signal.aborted).toBe(true);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    request.resolve();
    await draining;
    vi.useRealTimers();
  });

  it("still waits for tracked requests when the server was never listening", async () => {
    const request = deferred<void>();
    const server = {
      close: vi.fn(() => { throw Object.assign(new Error("not running"), { code: "ERR_SERVER_NOT_RUNNING" }); }),
      closeAllConnections: vi.fn(),
    };
    const tracker = createHttpRequestTracker();
    void tracker.run(new AbortController(), request.promise);

    const draining = tracker.drain(server as never, 1_000);
    let settled = false;
    void draining.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    request.resolve();

    await expect(draining).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
  });

  it("returns at the deadline even when an application promise ignores cancellation", async () => {
    vi.useFakeTimers();
    let closeCallback!: (error?: Error) => void;
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => { closeCallback = callback; }),
      closeAllConnections: vi.fn(() => closeCallback()),
    };
    const tracker = createHttpRequestTracker();
    const controller = new AbortController();
    void tracker.run(controller, new Promise<void>(() => undefined));

    const draining = tracker.drain(server as never, 100);
    await vi.advanceTimersByTimeAsync(100);

    await expect(draining).resolves.toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
