import type { Device, Household } from "@cloudframe/shared";
import type { ProviderRegistry } from "@cloudframe/providers";
import type { AppRepository } from "../firestore/repository";
import type { SourceService } from "./sources";

const MAX_THUMBNAIL_BATCH = 100;
const RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer"
} as const;

interface BrowseAuthorization {
  authorizeNode(device: Device, household: Household, nodeId: string): Promise<{
    id: string;
    sourceId: string;
    providerNodeId: string;
    kind: "folder" | "image" | "video";
    hasPreview: boolean;
    thumbnailRevision: string | null;
  }>;
}

interface SafeLogger {
  info(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface MediaUrlServiceDependencies {
  repository: AppRepository;
  browse: BrowseAuthorization;
  providers: ProviderRegistry;
  sourceService: Pick<SourceService, "getUsableCredentials">;
  logger?: SafeLogger;
}

export function createMediaUrlService(dependencies: MediaUrlServiceDependencies) {
  async function media(device: Device, household: Household, nodeId: string) {
    const node = await dependencies.browse.authorizeNode(device, household, nodeId);
    if (node.kind === "folder") {
      throw new MediaUrlServiceError("MEDIA_NOT_AVAILABLE", "Media is unavailable.");
    }
    const source = await requireSource(node.sourceId, household.id);
    const credentials = await dependencies.sourceService.getUsableCredentials(
      source.id,
      household.id
    );
    const temporary = await dependencies.providers.get(source.provider).getMediaUrl({
      credentials,
      providerNodeId: node.providerNodeId
    });
    dependencies.logger?.info("Issued temporary media URL", {
      sourceId: source.id,
      nodeId: node.id,
      provider: source.provider
    });
    return {
      url: temporary.url,
      expiresAt: temporary.expiresAt,
      revision: node.thumbnailRevision,
      responseHeaders: RESPONSE_HEADERS
    };
  }

  async function thumbnails(
    device: Device,
    household: Household,
    nodeIds: string[],
    maxDimension: number
  ) {
    if (
      nodeIds.length > MAX_THUMBNAIL_BATCH ||
      new Set(nodeIds).size !== nodeIds.length ||
      !Number.isInteger(maxDimension) ||
      maxDimension < 64 ||
      maxDimension > 4096
    ) {
      throw new MediaUrlServiceError(
        "THUMBNAIL_BATCH_TOO_LARGE",
        "Thumbnail request is invalid."
      );
    }
    const items = [];
    for (const nodeId of nodeIds) {
      try {
        const node = await dependencies.browse.authorizeNode(device, household, nodeId);
        if (node.kind === "folder" || !node.hasPreview) {
          items.push({ nodeId, status: "unavailable" as const });
          continue;
        }
        const source = await requireSource(node.sourceId, household.id);
        const credentials = await dependencies.sourceService.getUsableCredentials(source.id, household.id);
        const temporary = await dependencies.providers.get(source.provider).getThumbnailUrl({
          credentials,
          providerNodeId: node.providerNodeId,
          maxDimension
        });
        items.push(temporary
          ? {
              nodeId,
              status: "ready" as const,
              url: temporary.url,
              expiresAt: temporary.expiresAt,
              revision: node.thumbnailRevision
            }
          : { nodeId, status: "unavailable" as const });
      } catch (error) {
        if (isSafeUnavailable(error)) {
          items.push({ nodeId, status: "unavailable" as const });
          continue;
        }
        throw error;
      }
    }
    dependencies.logger?.info("Issued temporary thumbnail URLs", {
      deviceId: device.id,
      requestedCount: nodeIds.length,
      readyCount: items.filter(item => item.status === "ready").length
    });
    return { items, responseHeaders: RESPONSE_HEADERS };
  }

  async function requireSource(sourceId: string, householdId: string) {
    const source = await dependencies.repository.getSource(sourceId);
    if (!source || source.householdId !== householdId || source.status === "disabled") {
      throw new MediaUrlServiceError("MEDIA_NOT_AVAILABLE", "Media is unavailable.");
    }
    return source;
  }

  return { media, thumbnails };
}

function isSafeUnavailable(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "NODE_NOT_FOUND" || error.code === "MEDIA_NOT_AVAILABLE")
  );
}

export type MediaUrlServiceErrorCode =
  | "MEDIA_NOT_AVAILABLE"
  | "THUMBNAIL_BATCH_TOO_LARGE";

export class MediaUrlServiceError extends Error {
  constructor(readonly code: MediaUrlServiceErrorCode, message: string) {
    super(message);
    this.name = "MediaUrlServiceError";
  }
}
