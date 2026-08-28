export type ControlPlaneTelemetryEvent =
  | {
      level: "info";
      event:
        | "control_plane_blob_read"
        | "control_plane_cache_hit"
        | "control_plane_cache_miss";
      requestId: string;
      householdId: string;
      count: 1;
    }
  | {
      level: "info";
      event: "control_plane_mirror_write";
      requestId: string;
      householdId: string;
      revision: number;
      count: 1;
    }
  | {
      level: "error";
      event: "control_plane_mirror_failed";
      requestId: string;
      householdId: string;
      revision: number;
      errorCode: "CONTROL_PLANE_MIRROR_FAILED";
      count: 1;
    }
  | {
      level: "info";
      event: "control_plane_restore_read";
      requestId: string;
      householdId: string;
      count: 1;
    };

export interface ControlPlaneTelemetryObserver {
  emit(event: ControlPlaneTelemetryEvent): void;
}

export function safeControlPlaneTelemetry(
  observer: ControlPlaneTelemetryObserver | undefined,
  event: ControlPlaneTelemetryEvent
): void {
  try {
    observer?.emit(event);
  } catch {
    // Telemetry cannot affect control state.
  }
}
