import { AsyncLocalStorage } from "node:async_hooks";

import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";

import type { ControlPlaneStore } from "../control-plane/store";

export interface ControlRequestContext {
  document: ControlPlaneDocumentV2;
  revision: number;
}

export interface ControlRequestContextScope {
  runRequest<T>(operation: () => Promise<T>): Promise<T>;
  set(context: ControlRequestContext): void;
  current(): ControlRequestContext;
}

interface RequestContextState {
  context?: ControlRequestContext;
}

export function createControlRequestContextScope(): ControlRequestContextScope {
  const storage = new AsyncLocalStorage<RequestContextState>();
  return {
    runRequest: (operation) => storage.run({}, operation),
    set(context) {
      const state = storage.getStore();
      if (!state || state.context) {
        throw new Error("CONTROL_REQUEST_CONTEXT_INVALID");
      }
      state.context = context;
    },
    current() {
      const context = storage.getStore()?.context;
      if (!context) throw new Error("CONTROL_REQUEST_CONTEXT_MISSING");
      return context;
    }
  };
}

export async function loadControlRequestContext(
  controlStore: ControlPlaneStore,
  scope: ControlRequestContextScope
): Promise<ControlRequestContext> {
  const { document } = await controlStore.load();
  const context = { document, revision: document.revision };
  scope.set(context);
  return context;
}
