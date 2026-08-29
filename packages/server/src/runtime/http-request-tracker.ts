import type { Server } from "node:http";

export interface HttpRequestTracker {
  run(controller: AbortController, operation: Promise<void>): Promise<void>;
  drain(server: Pick<Server, "close" | "closeAllConnections">, timeoutMs: number): Promise<void>;
  activeCount(): number;
}

export function createHttpRequestTracker(): HttpRequestTracker {
  const active = new Map<Promise<void>, AbortController>();

  async function run(controller: AbortController, operation: Promise<void>): Promise<void> {
    const tracked = operation.finally(() => { active.delete(tracked); });
    active.set(tracked, controller);
    return tracked;
  }

  async function drain(server: Pick<Server, "close" | "closeAllConnections">, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closeError: Error | undefined;
    const closed = new Promise<void>((resolve, reject) => {
      try {
        server.close(error => error ? reject(error) : resolve());
      } catch (error) {
        closeError = error instanceof Error ? error : new Error("HTTP_SERVER_CLOSE_FAILED");
        resolve();
      }
    });
    const requests = Promise.allSettled([...active.keys()]).then(() => undefined);
    const graceful = Promise.all([closed, requests]).then(() => undefined);
    const deadline = new Promise<"timeout">(resolve => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, timeoutMs));
    });
    const result = await Promise.race([graceful.then(() => "graceful" as const), deadline]);
    if (result === "timeout") {
      for (const controller of active.values()) controller.abort();
      server.closeAllConnections();
    }
    if (timer) clearTimeout(timer);
    if (closeError) throw closeError;
  }

  return { run, drain, activeCount: () => active.size };
}
