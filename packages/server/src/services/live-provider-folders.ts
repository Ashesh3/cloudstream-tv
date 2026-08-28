import { createHmac } from "node:crypto";

import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderNode,
  type ProviderRegistry,
} from "@cloudframe/providers";
import {
  CONTROL_PLANE_LIMITS,
  type ControlPlaneDocumentV2,
  type ControlPlaneRoot,
  type ControlPlaneSource,
  type ControlRootDto,
  type ControlSourceDto,
  type ProviderFolderDto,
} from "@cloudframe/shared";

import { createOrEnableRootMutation } from "../control-plane/mutations";
import type {
  ControlMutationResult,
  ControlPlaneStore,
} from "../control-plane/store";
import type { ControlRequestContext } from "./control-auth";
import type { CredentialBroker } from "./credential-broker";

export interface BrowseLiveProviderFoldersInput {
  householdId: string;
  sourceId: string;
  providerFolderId?: string;
  cursor: string | null;
  pageSize: number;
}

export interface ResolveLiveProviderAncestryInput {
  householdId: string;
  sourceId: string;
  providerNodeId: string;
}

export interface CreateLiveProviderRootInput
  extends ResolveLiveProviderAncestryInput {
  displayName?: string;
}

export interface LiveProviderFolderPage {
  source: ControlSourceDto;
  current: ProviderFolderDto;
  breadcrumbs: ProviderFolderDto[];
  folders: ProviderFolderDto[];
  nextCursor: string | null;
}

export interface ResolvedLiveProviderAncestry {
  current: ProviderFolderDto;
  breadcrumbs: ProviderFolderDto[];
  ancestryProviderIds: string[];
}

export interface LiveProviderFolderService {
  browse(input: BrowseLiveProviderFoldersInput): Promise<LiveProviderFolderPage>;
  resolveAncestry(
    input: ResolveLiveProviderAncestryInput,
  ): Promise<ResolvedLiveProviderAncestry>;
  createRoot(
    input: CreateLiveProviderRootInput,
  ): Promise<{ root: ControlRootDto }>;
}

export type LiveProviderFolderErrorCode =
  | "INVALID_PAGE_SIZE"
  | "PROVIDER_ANCESTRY_CYCLE"
  | "PROVIDER_FOLDER_NOT_FOUND"
  | "PROVIDER_FOLDER_OUTSIDE_SOURCE"
  | "PROVIDER_FOLDER_REQUIRED"
  | "SOURCE_CHANGED"
  | "SOURCE_NOT_FOUND";

export class LiveProviderFolderError extends Error {
  constructor(readonly code: LiveProviderFolderErrorCode) {
    super(code);
    this.name = "LiveProviderFolderError";
  }
}

export type LiveProviderFolderConfigurationErrorCode =
  "ROOT_ID_SECRET_INVALID";

export class LiveProviderFolderConfigurationError extends Error {
  constructor(readonly code: LiveProviderFolderConfigurationErrorCode) {
    super(code);
    this.name = "LiveProviderFolderConfigurationError";
  }
}

export interface CreateLiveProviderFolderServiceOptions {
  controlStore: ControlPlaneStore;
  controlState: () => ControlRequestContext;
  credentialBroker: CredentialBroker;
  providers: ProviderRegistry;
  /** Configured deployment secret supplied by the final Task 18 composition. */
  rootIdSecret: string;
  now?: () => Date;
}

interface LiveSourceContext {
  context: ControlRequestContext;
  source: ControlPlaneSource;
  adapter: ProviderAdapter;
  credentials: ProviderCredentials;
  credentialRefreshed: boolean;
}

interface ResolvedNodes {
  current: ProviderNode;
  breadcrumbs: ProviderNode[];
  ancestryProviderIds: string[];
}

function folderError(code: LiveProviderFolderErrorCode): LiveProviderFolderError {
  return new LiveProviderFolderError(code);
}

function requireRootIdSecret(value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") < 32
  ) {
    throw new LiveProviderFolderConfigurationError("ROOT_ID_SECRET_INVALID");
  }
  return value;
}

function providerReauthRequired(): ProviderError {
  return new ProviderError(
    "PROVIDER_REAUTH_REQUIRED",
    "Provider authorization is required.",
    { retryable: false },
  );
}

function requireActiveSource(
  context: ControlRequestContext,
  householdId: string,
  sourceId: string,
): ControlPlaneSource {
  if (
    context.revision !== context.document.revision ||
    context.document.householdId !== householdId
  ) {
    throw folderError("SOURCE_NOT_FOUND");
  }
  const source = context.document.sources[sourceId];
  if (!source || source.status === "disabled") {
    throw folderError("SOURCE_NOT_FOUND");
  }
  if (source.status === "reauth-required") throw providerReauthRequired();
  return source;
}

function sameSourceIdentity(
  current: ControlPlaneSource,
  expected: ControlPlaneSource,
): boolean {
  return (
    current.provider === expected.provider &&
    current.providerAccountId === expected.providerAccountId &&
    current.providerRootId === expected.providerRootId
  );
}

function revisioned<T>(
  current: ControlPlaneDocumentV2,
  mutation: ControlMutationResult<T>,
): ControlMutationResult<T> {
  if (!mutation.changed) return mutation;
  return {
    ...mutation,
    next: { ...mutation.next, revision: current.revision + 1 },
  };
}

function safeSource(source: ControlPlaneSource): ControlSourceDto {
  return {
    id: source.id,
    provider: source.provider,
    accountLabel: source.accountLabel,
    status: source.status,
    createdAt: source.createdAt,
  };
}

function safeRoot(root: ControlPlaneRoot): ControlRootDto {
  return {
    id: root.id,
    sourceId: root.sourceId,
    displayName: root.displayName,
    enabled: root.enabled,
    createdAt: root.createdAt,
  };
}

function requireFolder(node: ProviderNode): void {
  if (node.kind !== "folder") {
    throw folderError("PROVIDER_FOLDER_REQUIRED");
  }
}

function folderDto(
  node: ProviderNode,
  assignedRoots: ReadonlyMap<string, string>,
): ProviderFolderDto {
  return {
    providerNodeId: node.providerNodeId,
    parentProviderId: node.parentProviderId,
    name: node.name,
    assignedRootId: assignedRoots.get(node.providerNodeId) ?? null,
  };
}

function assignedRoots(
  document: ControlPlaneDocumentV2,
  sourceId: string,
): ReadonlyMap<string, string> {
  return new Map(
    Object.values(document.roots)
      .filter((root) => root.sourceId === sourceId && root.enabled)
      .map((root) => [root.providerNodeId, root.id]),
  );
}

function rootId(
  secret: string,
  householdId: string,
  sourceId: string,
  providerNodeId: string,
): string {
  return `root_${createHmac("sha256", secret)
    .update(
      `${householdId.length}:${householdId}${sourceId.length}:${sourceId}${providerNodeId.length}:${providerNodeId}`,
    )
    .digest("base64url")}`;
}

function visibleName(value: string): string {
  const normalized = value
    .trim()
    .slice(0, CONTROL_PLANE_LIMITS.visibleNameLength);
  if (!normalized) throw folderError("PROVIDER_FOLDER_REQUIRED");
  return normalized;
}

function rootDisplayName(
  requested: string | undefined,
  providerName: string,
): string {
  return visibleName(requested?.trim() ? requested : providerName);
}

function validProviderNodeId(value: string): string {
  if (!value.trim()) throw folderError("PROVIDER_FOLDER_REQUIRED");
  return value;
}

export function createLiveProviderFolderService(
  options: CreateLiveProviderFolderServiceOptions,
): LiveProviderFolderService {
  const rootIdSecret = requireRootIdSecret(options.rootIdSecret);
  const now = options.now ?? (() => new Date());

  async function sourceContext(
    householdId: string,
    sourceId: string,
  ): Promise<LiveSourceContext> {
    const context = options.controlState();
    const source = requireActiveSource(context, householdId, sourceId);
    return {
      context,
      source,
      adapter: options.providers.get(source.provider),
      credentials: await options.credentialBroker.get(source.id, householdId),
      credentialRefreshed: false,
    };
  }

  async function providerCall<T>(
    context: LiveSourceContext,
    operation: (credentials: ProviderCredentials) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(context.credentials);
    } catch (error) {
      if (
        context.credentialRefreshed ||
        !(error instanceof ProviderError) ||
        error.code !== "PROVIDER_REAUTH_REQUIRED" ||
        error.reauthReason === "invalid_grant"
      ) {
        throw error;
      }
      context.credentialRefreshed = true;
      context.credentials = await options.credentialBroker.refresh(
        context.source.id,
        context.context.document.householdId,
      );
      return operation(context.credentials);
    }
  }

  async function getRoot(context: LiveSourceContext): Promise<ProviderNode> {
    let root: ProviderNode;
    try {
      root = await providerCall(context, (activeCredentials) =>
        context.adapter.getRoot(activeCredentials),
      );
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_NOT_FOUND"
      ) {
        throw folderError("PROVIDER_FOLDER_NOT_FOUND");
      }
      throw error;
    }
    requireFolder(root);
    if (root.providerNodeId !== context.source.providerRootId) {
      throw folderError("PROVIDER_FOLDER_OUTSIDE_SOURCE");
    }
    return root;
  }

  async function getNode(
    context: LiveSourceContext,
    providerNodeId: string,
  ): Promise<ProviderNode> {
    try {
      return await providerCall(context, (activeCredentials) =>
        context.adapter.getNode({
          credentials: activeCredentials,
          providerNodeId,
        }),
      );
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_NOT_FOUND"
      ) {
        throw folderError("PROVIDER_FOLDER_NOT_FOUND");
      }
      throw error;
    }
  }

  async function resolveNodes(
    context: LiveSourceContext,
    providerNodeId: string,
  ): Promise<ResolvedNodes> {
    validProviderNodeId(providerNodeId);
    const providerRoot = await getRoot(context);
    if (providerNodeId === context.source.providerRootId) {
      return {
        current: providerRoot,
        breadcrumbs: [providerRoot],
        ancestryProviderIds: [],
      };
    }

    const visited = new Set<string>();
    const reversed: ProviderNode[] = [];
    let current = await getNode(context, providerNodeId);

    while (true) {
      requireFolder(current);
      if (visited.has(current.providerNodeId)) {
        throw folderError("PROVIDER_ANCESTRY_CYCLE");
      }
      visited.add(current.providerNodeId);
      reversed.push(current);

      if (current.parentProviderId === context.source.providerRootId) {
        const breadcrumbs = [...reversed, providerRoot].reverse();
        return {
          current: breadcrumbs.at(-1)!,
          breadcrumbs,
          ancestryProviderIds: breadcrumbs
            .slice(0, -1)
            .map((node) => node.providerNodeId),
        };
      }

      if (
        current.parentProviderId === null ||
        reversed.length === CONTROL_PLANE_LIMITS.ancestryEntries
      ) {
        throw folderError("PROVIDER_FOLDER_OUTSIDE_SOURCE");
      }
      current = await getNode(context, current.parentProviderId);
    }
  }

  async function browse(
    input: BrowseLiveProviderFoldersInput,
  ): Promise<LiveProviderFolderPage> {
    if (
      !Number.isInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > 200
    ) {
      throw folderError("INVALID_PAGE_SIZE");
    }
    const context = await sourceContext(input.householdId, input.sourceId);
    const resolved = await resolveNodes(
      context,
      input.providerFolderId ?? context.source.providerRootId,
    );
    const page = await providerCall(context, (activeCredentials) =>
      context.adapter.listFolder({
        credentials: activeCredentials,
        folderId: resolved.current.providerNodeId,
        cursor: input.cursor,
        pageSize: input.pageSize,
      }),
    );
    const rootByProviderId = assignedRoots(
      context.context.document,
      context.source.id,
    );
    return {
      source: safeSource(context.source),
      current: folderDto(resolved.current, rootByProviderId),
      breadcrumbs: resolved.breadcrumbs.map((node) =>
        folderDto(node, rootByProviderId),
      ),
      folders: page.items
        .filter((node) => node.kind === "folder")
        .map((node) => folderDto(node, rootByProviderId)),
      nextCursor: page.nextCursor,
    };
  }

  async function resolveAncestry(
    input: ResolveLiveProviderAncestryInput,
  ): Promise<ResolvedLiveProviderAncestry> {
    const context = await sourceContext(input.householdId, input.sourceId);
    const resolved = await resolveNodes(context, input.providerNodeId);
    const rootByProviderId = assignedRoots(
      context.context.document,
      context.source.id,
    );
    return {
      current: folderDto(resolved.current, rootByProviderId),
      breadcrumbs: resolved.breadcrumbs.map((node) =>
        folderDto(node, rootByProviderId),
      ),
      ancestryProviderIds: [...resolved.ancestryProviderIds],
    };
  }

  async function createRoot(
    input: CreateLiveProviderRootInput,
  ): Promise<{ root: ControlRootDto }> {
    const context = await sourceContext(input.householdId, input.sourceId);
    await resolveNodes(context, input.providerNodeId);
    const resolved = await resolveNodes(context, input.providerNodeId);
    const id = rootId(
      rootIdSecret,
      input.householdId,
      input.sourceId,
      resolved.current.providerNodeId,
    );
    const createdAt = now().toISOString();

    const saved = await options.controlStore.mutate(
      "create-live-provider-root",
      (current) => {
        if (current.householdId !== input.householdId) {
          throw folderError("SOURCE_NOT_FOUND");
        }
        const source = current.sources[input.sourceId];
        if (
          !source ||
          source.status !== "healthy" ||
          !sameSourceIdentity(source, context.source)
        ) {
          throw folderError("SOURCE_CHANGED");
        }
        const root: ControlPlaneRoot = {
          id,
          sourceId: source.id,
          providerNodeId: resolved.current.providerNodeId,
          displayName: rootDisplayName(input.displayName, resolved.current.name),
          ancestryProviderIds: [...resolved.ancestryProviderIds],
          enabled: true,
          createdAt: current.roots[id]?.createdAt ?? createdAt,
        };
        return revisioned(current, createOrEnableRootMutation(current, root));
      },
    );
    return { root: safeRoot(saved) };
  }

  return { browse, resolveAncestry, createRoot };
}
