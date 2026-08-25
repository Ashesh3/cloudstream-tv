import type { CloudConnection, CloudProvider } from "@/types";

export interface ConnectionSummary {
  id: string;
  provider: CloudProvider;
  email: string;
  folders: Array<{ id: string; name: string }>;
}

export function toConnectionSummaries(
  connections: CloudConnection[]
): ConnectionSummary[] {
  return connections.map((connection) => ({
    id: connection.id,
    provider: connection.provider,
    email: connection.email,
    folders: connection.folders.map((folder) => ({
      id: folder.id,
      name: folder.name,
    })),
  }));
}

export function toConnectionManagementState(
  mode: "setup" | "manage",
  connections: CloudConnection[]
): { mode: "setup" | "manage"; connections: ConnectionSummary[] } {
  return {
    mode,
    connections: toConnectionSummaries(connections),
  };
}
