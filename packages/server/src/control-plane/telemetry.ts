export type ControlPlaneTelemetryEvent =
  | {
      level: "info";
      event: "control_plane_sqlite_read";
      requestId: string;
      householdId: string;
      count: 1;
    }
  | {
      level: "info";
      event: "control_plane_sqlite_write";
      requestId: string;
      householdId: string;
      revision: number;
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
