export interface ReadinessSnapshot {
  live: true;
  ready: boolean;
  draining: boolean;
  errorCode?: string;
}

export interface ReadinessController {
  markReady(): void;
  fail(code: string): void;
  beginDrain(): void;
  snapshot(): ReadinessSnapshot;
}

export function createReadinessController(): ReadinessController {
  let ready = false;
  let draining = false;
  let errorCode: string | undefined;

  return {
    markReady() {
      if (!draining && errorCode === undefined) ready = true;
    },
    fail(code) {
      ready = false;
      errorCode = code;
    },
    beginDrain() {
      ready = false;
      draining = true;
    },
    snapshot() {
      return {
        live: true,
        ready,
        draining,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    },
  };
}
