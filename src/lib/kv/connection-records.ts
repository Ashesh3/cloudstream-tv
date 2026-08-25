import type { CloudConnection, CloudFolder, CloudProvider } from "@/types";

export interface ConnectionMetadataRecord {
  id: string;
  provider: CloudProvider;
  email: string;
  folders: CloudFolder[];
  createdAt: number;
}

export interface ConnectionTokenRecord {
  accessToken: string;
  refreshToken: string;
  tokenExpiry: number;
}

export function splitConnectionRecords(
  connection: CloudConnection,
  createdAt: number
): {
  metadata: ConnectionMetadataRecord;
  tokens: ConnectionTokenRecord;
} {
  return {
    metadata: {
      id: connection.id,
      provider: connection.provider,
      email: connection.email,
      folders: connection.folders,
      createdAt,
    },
    tokens: {
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      tokenExpiry: connection.tokenExpiry,
    },
  };
}

export function joinConnectionRecords(
  metadata: ConnectionMetadataRecord,
  tokens: ConnectionTokenRecord
): CloudConnection {
  return {
    id: metadata.id,
    provider: metadata.provider,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiry: tokens.tokenExpiry,
    email: metadata.email,
    folders: metadata.folders,
  };
}
