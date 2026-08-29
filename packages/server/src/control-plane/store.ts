import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import type { ControlPlaneTelemetryObserver } from "./telemetry.ts";

export interface LoadedControlPlaneSnapshot {
  document: ControlPlaneDocumentV2;
  etag: string;
}

export interface ControlMutationResult<T> {
  changed: boolean;
  next: ControlPlaneDocumentV2;
  result: T;
}

export type ControlMutationReducer<T> = (current: ControlPlaneDocumentV2) => ControlMutationResult<T>;

export interface ControlPlaneStore {
  load(): Promise<LoadedControlPlaneSnapshot>;
  mutate<T>(name: string, reducer: ControlMutationReducer<T>): Promise<T>;
  withTelemetry?<T>(observer: ControlPlaneTelemetryObserver | undefined, requestId: string, operation: () => Promise<T>): Promise<T>;
}

export type ControlPlaneStoreErrorCode = "CONTROL_PLANE_CONFLICT" | "CONTROL_PLANE_INVALID" | "CONTROL_PLANE_UNAVAILABLE";

export class ControlPlaneStoreError extends Error {
  constructor(readonly code: ControlPlaneStoreErrorCode) {
    super(code);
    this.name = "ControlPlaneStoreError";
  }
}
