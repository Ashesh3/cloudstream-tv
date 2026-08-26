import type {
  AdminProviderFolderPageResponse,
  AssignedRoot,
  ProviderFolderDto,
  Source
} from "@cloudframe/shared";
import { encodeSourceDto } from "@cloudframe/shared";
import type {
  ProviderAdapter,
  ProviderCredentials,
  ProviderNode,
  ProviderRegistry
} from "@cloudframe/providers";
import {
  RepositoryError,
  assignedRootDocumentId,
  type AppRepository
} from "../firestore/repository";
import type { SourceService } from "./sources";

const MAX_ANCESTRY_DEPTH = 256;

export interface BrowseProviderFoldersInput {
  householdId: string;
  sourceId: string;
  providerFolderId?: string;
  cursor: string | null;
  pageSize: number;
}

export interface ResolveProviderAncestryInput {
  householdId: string;
  sourceId: string;
  providerNodeId: string;
}

export type ProviderFolderErrorCode =
  | "PROVIDER_ROOT_MISSING"
  | "PROVIDER_FOLDER_REQUIRED"
  | "PROVIDER_ANCESTRY_CYCLE"
  | "PROVIDER_FOLDER_OUTSIDE_SOURCE"
  | "INVALID_PAGE_SIZE";

export class ProviderFolderError extends Error {
  constructor(readonly code: ProviderFolderErrorCode, message: string) {
    super(message);
    this.name = "ProviderFolderError";
  }
}

export interface ProviderFolderService {
  browse(input: BrowseProviderFoldersInput): Promise<AdminProviderFolderPageResponse>;
  resolveAncestry(input: ResolveProviderAncestryInput): Promise<{
    current: ProviderFolderDto;
    breadcrumbs: ProviderFolderDto[];
    ancestryProviderIds: string[];
  }>;
  createRootFromProvider(input: {
    householdId: string;
    sourceId: string;
    providerNodeId: string;
    displayName?: string;
  }): Promise<{ root: AssignedRoot; started: boolean; runId?: string }>;
}

export function createProviderFolderService(dependencies: {
  repository: AppRepository;
  providers: ProviderRegistry;
  sourceService: Pick<SourceService, "getUsableCredentials">;
  indexing: {
    startSource(sourceId: string, mode: "initial"): Promise<{
      started: boolean;
      sourceId: string;
      runId?: string;
    }>;
  };
  now?: () => Date;
}): ProviderFolderService {
  const now = dependencies.now ?? (() => new Date());
  async function requireContext(householdId: string, sourceId: string) {
    const source = await dependencies.repository.getSource(sourceId);
    if (!source || source.householdId !== householdId || source.status === "disabled") {
      throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found.");
    }
    const providerRootId = source.providerRootId;
    if (!providerRootId) {
      throw new ProviderFolderError("PROVIDER_ROOT_MISSING", "Reconnect this source.");
    }
    const credentials = await dependencies.sourceService.getUsableCredentials(
      source.id,
      source.householdId
    );
    return {
      source: { ...source, providerRootId },
      credentials,
      adapter: dependencies.providers.get(source.provider)
    };
  }

  async function browse(input: BrowseProviderFoldersInput) {
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 200) {
      throw new ProviderFolderError("INVALID_PAGE_SIZE", "Page size is invalid.");
    }
    const context = await requireContext(input.householdId, input.sourceId);
    const currentId = input.providerFolderId ?? context.source.providerRootId!;
    const resolved = currentId === context.source.providerRootId
      ? await resolveProviderRoot(context)
      : await resolveWithContext(context, currentId);
    const page = await context.adapter.listFolder({
      credentials: context.credentials,
      folderId: resolved.current.providerNodeId,
      cursor: input.cursor,
      pageSize: input.pageSize
    });
    const roots = (await dependencies.repository.listRootsForSource(context.source.id))
      .filter(root => root.enabled && root.householdId === input.householdId);
    const rootByProviderId = new Map(
      roots.map(root => [root.providerNodeId, root.id])
    );
    const assign = (folder: ProviderFolderDto): ProviderFolderDto => ({
      ...folder,
      assignedRootId: rootByProviderId.get(folder.providerNodeId) ?? null
    });
    return {
      source: encodeSourceDto(context.source, roots.length),
      current: assign(resolved.current),
      breadcrumbs: resolved.breadcrumbs.map(assign),
      folders: page.items
        .filter(item => item.kind === "folder")
        .map(item => folderDto(item, rootByProviderId)),
      nextCursor: page.nextCursor
    };
  }

  async function resolveAncestry(input: ResolveProviderAncestryInput) {
    const context = await requireContext(input.householdId, input.sourceId);
    return input.providerNodeId === context.source.providerRootId
      ? resolveProviderRoot(context)
      : resolveWithContext(context, input.providerNodeId);
  }

  async function createRootFromProvider(input: {
    householdId: string;
    sourceId: string;
    providerNodeId: string;
    displayName?: string;
  }) {
    const resolved = await service.resolveAncestry(input);
    const createdAt = now();
    const root: AssignedRoot = {
      id: assignedRootDocumentId(input.householdId, input.sourceId, input.providerNodeId),
      householdId: input.householdId,
      sourceId: input.sourceId,
      providerNodeId: input.providerNodeId,
      displayName: input.displayName?.trim().slice(0, 120) || resolved.current.name,
      ancestryProviderIds: [...resolved.ancestryProviderIds],
      enabled: true,
      createdAt
    };
    const saved = await dependencies.repository.enableRootAndResetInitial({
      root,
      sourceId: input.sourceId,
      resetAt: createdAt
    });
    try {
      const launch = await dependencies.indexing.startSource(input.sourceId, "initial");
      return {
        root: saved,
        started: launch.started,
        ...(launch.runId ? { runId: launch.runId } : {})
      };
    } catch (error) {
      throw new ProviderFolderLaunchError(error);
    }
  }

  async function resolveProviderRoot(context: ProviderContext) {
    const root = await context.adapter.getRoot(context.credentials);
    if (root.providerNodeId !== context.source.providerRootId) {
      throw outsideSource();
    }
    requireFolder(root);
    const current = folderDto(root, new Map());
    return { current, breadcrumbs: [current], ancestryProviderIds: [] };
  }

  async function resolveWithContext(
    context: ProviderContext,
    providerNodeId: string
  ) {
    const visited = new Set<string>();
    const reversed: ProviderNode[] = [];
    let current = await context.adapter.getNode({
      credentials: context.credentials,
      providerNodeId
    });
    for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
      requireFolder(current);
      if (visited.has(current.providerNodeId)) {
        throw new ProviderFolderError(
          "PROVIDER_ANCESTRY_CYCLE",
          "Provider folder ancestry is invalid."
        );
      }
      visited.add(current.providerNodeId);
      reversed.push(current);
      if (current.providerNodeId === context.source.providerRootId) {
        const chain = reversed.reverse();
        return {
          current: folderDto(chain.at(-1)!, new Map()),
          breadcrumbs: chain.map(node => folderDto(node, new Map())),
          ancestryProviderIds: chain
            .slice(0, -1)
            .map(node => node.providerNodeId)
        };
      }
      if (!current.parentProviderId) break;
      if (depth + 1 >= MAX_ANCESTRY_DEPTH) break;
      current = await context.adapter.getNode({
        credentials: context.credentials,
        providerNodeId: current.parentProviderId
      });
    }
    throw outsideSource();
  }

  const service: ProviderFolderService = {
    browse,
    resolveAncestry,
    createRootFromProvider
  };
  return service;
}

export class ProviderFolderLaunchError extends Error {
  constructor(readonly cause: unknown) {
    super("The folder was selected, but indexing could not start. Retry indexing.");
    this.name = "ProviderFolderLaunchError";
  }
}

interface ProviderContext {
  source: Source & { providerRootId: string };
  credentials: ProviderCredentials;
  adapter: ProviderAdapter;
}

function requireFolder(node: ProviderNode): void {
  if (node.kind !== "folder") {
    throw new ProviderFolderError(
      "PROVIDER_FOLDER_REQUIRED",
      "Choose a folder."
    );
  }
}

function outsideSource(): ProviderFolderError {
  return new ProviderFolderError(
    "PROVIDER_FOLDER_OUTSIDE_SOURCE",
    "This folder is not inside the connected account."
  );
}

function folderDto(
  node: ProviderNode,
  assignedRoots: ReadonlyMap<string, string>
): ProviderFolderDto {
  return {
    providerNodeId: node.providerNodeId,
    parentProviderId: node.parentProviderId,
    name: node.name,
    assignedRootId: assignedRoots.get(node.providerNodeId) ?? null
  };
}
