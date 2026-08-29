import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import { cloneControlPlaneDocument, parseControlPlaneDocument } from "./schema.ts";
import { ControlPlaneStoreError, type ControlPlaneStore } from "./store.ts";

export function controlStoreHarness(document: ControlPlaneDocumentV2, _options: Record<string, unknown> = {}): {
  store: ControlPlaneStore;
  current(): ControlPlaneDocumentV2;
  replace(document: ControlPlaneDocumentV2): void;
  readonly loadCount: number;
  readonly mutateCount: number;
  readonly durable: {
    readonly currentDocument: ControlPlaneDocumentV2;
    readonly readCount: number;
    readonly writeAttempts: number;
    replaceOutOfBand(document: ControlPlaneDocumentV2, ...ignored: unknown[]): void;
    readonly currentRevision: number;
    readonly currentEtag: string;
    readonly ifNoneMatches: Array<string | undefined>;
  };
  readonly cache: { readonly setCount: number };
  readonly mirror: { readonly writeCount: number };
  readonly deferred: { flush(): Promise<void> };
} {
  let current = cloneControlPlaneDocument(document);
  let loadCount = 0;
  let mutateCount = 0;
  let writeCount = 0;
  const ifNoneMatches: Array<string | undefined> = [];
  const store: ControlPlaneStore = {
    async load() {
      loadCount += 1;
      return { document: cloneControlPlaneDocument(current), etag: `memory:${current.revision}` };
    },
    async mutate(_name, reducer) {
      mutateCount += 1;
      const mutation = reducer(cloneControlPlaneDocument(current));
      if (!mutation.changed) return mutation.result;
      if (mutation.next.revision !== current.revision + 1) throw new ControlPlaneStoreError("CONTROL_PLANE_INVALID");
      try { current = parseControlPlaneDocument(mutation.next); }
      catch { throw new ControlPlaneStoreError("CONTROL_PLANE_INVALID"); }
      writeCount += 1;
      return mutation.result;
    },
  };
  const result = {
    store,
    current: () => cloneControlPlaneDocument(current),
    replace(next: ControlPlaneDocumentV2) { current = cloneControlPlaneDocument(next); },
    durable: {
      get currentDocument() { return cloneControlPlaneDocument(current); },
      get readCount() { return loadCount; },
      get writeAttempts() { return writeCount; },
      get currentRevision() { return current.revision; },
      get currentEtag() { return `memory:${current.revision}`; },
      ifNoneMatches,
      replaceOutOfBand(next: ControlPlaneDocumentV2, ..._ignored: unknown[]) { current = cloneControlPlaneDocument(next); },
    },
    cache: { get setCount() { return writeCount; } },
    mirror: { get writeCount() { return writeCount; } },
    deferred: { async flush() { return undefined; } },
  };
  Object.defineProperties(result, {
    loadCount: { enumerable: true, get: () => loadCount },
    mutateCount: { enumerable: true, get: () => writeCount },
  });
  return result as typeof result & { readonly loadCount: number; readonly mutateCount: number };
}
