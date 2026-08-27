import type { TvRootCardDto } from "@cloudframe/shared";

export function ProgramStatus({ readiness, message, compact = false }: {
  readiness: TvRootCardDto["readiness"];
  message: string;
  compact?: boolean;
}) {
  return (
    <span
      className={`program-status${compact ? " is-compact" : ""}`}
      data-readiness={readiness}
      role={readiness === "ready" ? undefined : "status"}
    >
      <i aria-hidden="true" />
      <span>{message}</span>
    </span>
  );
}
