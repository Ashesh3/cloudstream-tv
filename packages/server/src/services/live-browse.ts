import {
  ProviderError,
  type ProviderCredentials,
  type ProviderNode,
  type ProviderRegistry
} from "@cloudframe/providers";
import {
  sortBrowseItems,
  type ControlPlaneRoot,
  type ControlPlaneSource,
  type TvBrowseItemDto,
  type TvFolderPageResponse,
  type TvRootDto
} from "@cloudframe/shared";

import type {
  BrowseCursorClaims,
  BrowseHandleCodec,
  BrowseItemClaims
} from "../auth/browse-handles";
import { SealedValueError } from "../crypto/aead";
import type {
  AuthenticatedControlDevice,
  ControlRequestContext
} from "./control-auth";
import {
  CredentialBrokerError,
  type BrokeredProviderCredentials,
  type CredentialBroker
} from "./credential-broker";

const HANDLE_LIFETIME_MS = 30 * 60_000;

export interface LiveBrowseHomeResponse {
  roots: TvRootDto[];
}

export interface AuthorizedBrowseItem {
  claims: BrowseItemClaims;
  id: string;
  root: ControlPlaneRoot;
  source: ControlPlaneSource;
}

export interface LiveBrowseService {
  home(auth: AuthenticatedControlDevice): Promise<LiveBrowseHomeResponse>;
  folder(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
    sealedCursor: string | null,
    pageSize: number
  ): Promise<TvFolderPageResponse>;
  authorizeHandle(
    auth: AuthenticatedControlDevice,
    sealedHandle: string
  ): AuthorizedBrowseItem;
  authorizeClaims(
    auth: AuthenticatedControlDevice,
    claims: BrowseItemClaims,
  ): AuthorizedBrowseItem;
}

export interface CreateLiveBrowseServiceOptions {
  handles: BrowseHandleCodec;
  credentialBroker: CredentialBroker;
  providers: ProviderRegistry;
  now?: () => Date;
}

export type LiveBrowseErrorCode =
  | "DEVICE_UNAUTHORIZED"
  | "INVALID_PAGE_SIZE"
  | "ITEM_NOT_FOUND"
  | "NAVIGATION_EXPIRED";

export class LiveBrowseError extends Error {
  constructor(readonly code: LiveBrowseErrorCode) {
    super(code);
    this.name = "LiveBrowseError";
  }
}

function browseError(code: LiveBrowseErrorCode): LiveBrowseError {
  return new LiveBrowseError(code);
}

function activeDevice(
  auth: AuthenticatedControlDevice,
  context: ControlRequestContext
) {
  const device = context.document.devices[auth.deviceId];
  if (
    context.revision !== context.document.revision ||
    context.document.householdId !== auth.householdId ||
    !device ||
    !device.enabled ||
    device.revokedAt !== null ||
    device.sessionVersion !== auth.sessionVersion
  ) {
    throw browseError("DEVICE_UNAUTHORIZED");
  }
  return device;
}

function activeRootAndSource(
  auth: AuthenticatedControlDevice,
  context: ControlRequestContext,
  claims: Pick<
    BrowseItemClaims | BrowseCursorClaims,
    | "householdId"
    | "deviceId"
    | "sourceId"
    | "rootId"
    | "rootProviderNodeId"
    | "credentialVersion"
  >
): { root: ControlPlaneRoot; source: ControlPlaneSource } {
  const device = activeDevice(auth, context);
  if (
    claims.householdId !== auth.householdId ||
    claims.deviceId !== auth.deviceId
  ) {
    throw browseError("ITEM_NOT_FOUND");
  }
  const root = context.document.roots[claims.rootId];
  if (
    !root ||
    !root.enabled ||
    !device.assignedRootIds.includes(root.id) ||
    root.sourceId !== claims.sourceId ||
    root.providerNodeId !== claims.rootProviderNodeId
  ) {
    throw browseError("ITEM_NOT_FOUND");
  }
  const source = context.document.sources[claims.sourceId];
  if (!source || source.status !== "healthy") {
    throw browseError("ITEM_NOT_FOUND");
  }
  if (source.credentialVersion !== claims.credentialVersion) {
    throw browseError("NAVIGATION_EXPIRED");
  }
  return { root, source };
}

function openItem(
  handles: BrowseHandleCodec,
  sealedHandle: string
): BrowseItemClaims {
  try {
    return handles.openItem(sealedHandle);
  } catch (error) {
    if (error instanceof SealedValueError) {
      throw browseError("NAVIGATION_EXPIRED");
    }
    throw error;
  }
}

function openCursor(
  handles: BrowseHandleCodec,
  sealedCursor: string
): BrowseCursorClaims {
  try {
    return handles.openCursor(sealedCursor);
  } catch (error) {
    if (error instanceof SealedValueError) {
      throw browseError("NAVIGATION_EXPIRED");
    }
    throw error;
  }
}

function authorizeItem(
  auth: AuthenticatedControlDevice,
  context: ControlRequestContext,
  handles: BrowseHandleCodec,
  sealedHandle: string
): AuthorizedBrowseItem {
  activeDevice(auth, context);
  const claims = openItem(handles, sealedHandle);
  const { root, source } = activeRootAndSource(auth, context, claims);
  if (
    (claims.parentProviderNodeId === null &&
      claims.providerNodeId !== root.providerNodeId) ||
    (claims.providerNodeId === root.providerNodeId &&
      claims.parentProviderNodeId !== null)
  ) {
    throw browseError("ITEM_NOT_FOUND");
  }
  return {
    claims,
    id: handles.stableItemId(
      claims.householdId,
      claims.sourceId,
      claims.providerNodeId
    ),
    root,
    source
  };
}

function authorizeCursor(
  auth: AuthenticatedControlDevice,
  context: ControlRequestContext,
  handles: BrowseHandleCodec,
  sealedCursor: string,
  item: AuthorizedBrowseItem
): BrowseCursorClaims {
  activeDevice(auth, context);
  const claims = openCursor(handles, sealedCursor);
  activeRootAndSource(auth, context, claims);
  if (
    claims.householdId !== item.claims.householdId ||
    claims.deviceId !== item.claims.deviceId ||
    claims.sourceId !== item.claims.sourceId ||
    claims.rootId !== item.claims.rootId ||
    claims.folderProviderNodeId !== item.claims.providerNodeId
  ) {
    throw browseError("ITEM_NOT_FOUND");
  }
  return claims;
}

function normalizePageSize(pageSize: number): number {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw browseError("INVALID_PAGE_SIZE");
  }
  return pageSize;
}

function issueTimes(now: Date): { issuedAt: number; expiresAt: number } {
  const issuedAt = now.getTime();
  return { issuedAt, expiresAt: issuedAt + HANDLE_LIFETIME_MS };
}

function rootClaims(
  auth: AuthenticatedControlDevice,
  root: ControlPlaneRoot,
  source: ControlPlaneSource,
  now: Date
): BrowseItemClaims {
  return {
    version: 2,
    householdId: auth.householdId,
    deviceId: auth.deviceId,
    sourceId: source.id,
    rootId: root.id,
    rootProviderNodeId: root.providerNodeId,
    providerNodeId: root.providerNodeId,
    parentProviderNodeId: null,
    kind: "folder",
    name: root.displayName,
    mimeType: null,
    preview: null,
    credentialVersion: source.credentialVersion,
    ...issueTimes(now)
  };
}

function normalizedName(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase("en");
}

function nullableIso(value: Date | null): string | null {
  return value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

interface SafeProviderNode {
  providerNodeId: string;
  name: string;
  kind: "folder" | "image" | "video";
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  createdAtProvider: string | null;
  modifiedAtProvider: string | null;
  thumbnailRevision: string | null;
  hasPreview: boolean;
  preview: { url: string; expiresAt: number } | null;
}

function safePreview(value: ProviderNode["preview"]): { url: string; expiresAt: number } | null {
  if (!value || typeof value !== "object") return null;
  const url = value.url;
  const expiresAt = value.expiresAt;
  if (
    typeof url !== "string" ||
    url.length < 1 ||
    url.length > 4_096 ||
    !(expiresAt instanceof Date)
  ) {
    return null;
  }
  const expiryEpoch = Date.prototype.getTime.call(expiresAt);
  if (!Number.isSafeInteger(expiryEpoch) || expiryEpoch < 1) return null;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { url, expiresAt: expiryEpoch };
}

function safeProviderNode(
  value: ProviderNode,
  expectedParentProviderNodeId: string
): SafeProviderNode | null {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.providerNodeId !== "string" ||
    value.providerNodeId.length === 0 ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.parentProviderId !== expectedParentProviderNodeId ||
    (value.kind !== "folder" &&
      value.kind !== "image" &&
      value.kind !== "video")
  ) {
    return null;
  }
  const capturedAt = value.capturedAt;
  const createdAt = value.createdAt;
  const modifiedAt = value.modifiedAt;
  if (
    (capturedAt !== null && !(capturedAt instanceof Date)) ||
    (createdAt !== null && !(createdAt instanceof Date)) ||
    (modifiedAt !== null && !(modifiedAt instanceof Date))
  ) {
    return null;
  }
  const mimeType = value.kind === "folder" ? null : value.mimeType;
  if (
    value.kind !== "folder" &&
    (typeof mimeType !== "string" || !mimeType.startsWith(`${value.kind}/`))
  ) {
    return null;
  }
  return {
    providerNodeId: value.providerNodeId,
    name: value.name,
    kind: value.kind,
    mimeType,
    size: nullableNonNegativeInteger(value.size),
    width: nullableNonNegativeInteger(value.width),
    height: nullableNonNegativeInteger(value.height),
    capturedAt: nullableIso(capturedAt),
    createdAtProvider: nullableIso(createdAt),
    modifiedAtProvider: nullableIso(modifiedAt),
    thumbnailRevision:
      typeof value.thumbnailRevision === "string" &&
      value.thumbnailRevision.length > 0
        ? value.thumbnailRevision
        : null,
    hasPreview: value.hasPreview === true,
    preview: safePreview(value.preview)
  };
}

function itemClaims(
  parent: AuthorizedBrowseItem,
  node: SafeProviderNode,
  now: Date,
  credentialVersion: number
): BrowseItemClaims {
  return {
    version: 2,
    householdId: parent.claims.householdId,
    deviceId: parent.claims.deviceId,
    sourceId: parent.claims.sourceId,
    rootId: parent.claims.rootId,
    rootProviderNodeId: parent.claims.rootProviderNodeId,
    providerNodeId: node.providerNodeId,
    parentProviderNodeId: parent.claims.providerNodeId,
    kind: node.kind,
    name: node.name,
    mimeType: node.mimeType,
    preview: node.preview,
    credentialVersion,
    ...issueTimes(now)
  };
}

function itemDto(
  handles: BrowseHandleCodec,
  claims: BrowseItemClaims,
  metadata?: Omit<SafeProviderNode, "providerNodeId" | "name" | "kind" | "mimeType">
): TvBrowseItemDto {
  return {
    id: handles.stableItemId(
      claims.householdId,
      claims.sourceId,
      claims.providerNodeId
    ),
    handle: handles.sealItem(claims),
    name: claims.name,
    normalizedName: normalizedName(claims.name),
    kind: claims.kind,
    mimeType: claims.mimeType,
    size: metadata?.size ?? null,
    width: metadata?.width ?? null,
    height: metadata?.height ?? null,
    capturedAt: metadata?.capturedAt ?? null,
    createdAtProvider: metadata?.createdAtProvider ?? null,
    modifiedAtProvider: metadata?.modifiedAtProvider ?? null,
    thumbnailRevision: metadata?.thumbnailRevision ?? null,
    hasPreview: metadata?.hasPreview ?? false
  };
}

function safeProviderError(error: ProviderError): ProviderError {
  return new ProviderError(error.code, "Provider request failed.", {
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
    reauthReason: error.reauthReason
  });
}

function normalizeDependencyError(error: unknown): never {
  if (error instanceof CredentialBrokerError) {
    throw browseError("ITEM_NOT_FOUND");
  }
  if (error instanceof ProviderError) {
    if (error.code === "PROVIDER_NOT_FOUND") {
      throw browseError("ITEM_NOT_FOUND");
    }
    throw safeProviderError(error);
  }
  throw new ProviderError("PROVIDER_BAD_RESPONSE", "Provider request failed.", {
    retryable: false
  });
}

interface ValidProviderPage {
  items: ProviderNode[];
  nextCursor: string | null;
}

function validProviderPage(value: unknown): ValidProviderPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_PROVIDER_PAGE");
  }
  const page = value as Record<string, unknown>;
  const items = page.items;
  const nextCursor = page.nextCursor;
  if (
    !Array.isArray(items) ||
    (nextCursor !== null &&
      (typeof nextCursor !== "string" || nextCursor.length === 0))
  ) {
    throw new Error("INVALID_PROVIDER_PAGE");
  }
  return { items: items as ProviderNode[], nextCursor };
}

function normalizeProviderPage(value: unknown): ValidProviderPage {
  try {
    return validProviderPage(value);
  } catch {
    throw new ProviderError("PROVIDER_BAD_RESPONSE", "Provider request failed.", {
      retryable: false
    });
  }
}

export function createLiveBrowseService(
  options: CreateLiveBrowseServiceOptions
): LiveBrowseService {
  const now = options.now ?? (() => new Date());

  function authorizeHandle(
    auth: AuthenticatedControlDevice,
    sealedHandle: string
  ): AuthorizedBrowseItem {
    return authorizeItem(auth, auth.context, options.handles, sealedHandle);
  }

  function authorizeClaims(
    auth: AuthenticatedControlDevice,
    claims: BrowseItemClaims,
  ): AuthorizedBrowseItem {
    activeDevice(auth, auth.context);
    const { root, source } = activeRootAndSource(auth, auth.context, claims);
    if (
      (claims.parentProviderNodeId === null &&
        claims.providerNodeId !== root.providerNodeId) ||
      (claims.providerNodeId === root.providerNodeId &&
        claims.parentProviderNodeId !== null)
    ) {
      throw browseError("ITEM_NOT_FOUND");
    }
    return {
      claims,
      id: options.handles.stableItemId(
        claims.householdId,
        claims.sourceId,
        claims.providerNodeId,
      ),
      root,
      source,
    };
  }

  async function home(
    auth: AuthenticatedControlDevice
  ): Promise<LiveBrowseHomeResponse> {
    const device = activeDevice(auth, auth.context);
    const issuedAt = now();
    const roots: TvRootDto[] = [];
    for (const rootId of device.assignedRootIds) {
      const root = auth.context.document.roots[rootId];
      if (!root || !root.enabled) continue;
      const source = auth.context.document.sources[root.sourceId];
      if (!source || source.status !== "healthy") continue;
      const claims = rootClaims(auth, root, source, issuedAt);
      roots.push({
        id: options.handles.stableItemId(
          auth.householdId,
          source.id,
          root.providerNodeId
        ),
        handle: options.handles.sealItem(claims),
        displayName: root.displayName,
        provider: source.provider,
        accountLabel: source.accountLabel
      });
    }
    return { roots };
  }

  async function listFolder(
    item: AuthorizedBrowseItem,
    providerCursor: string | null,
    pageSize: number
  ): Promise<{ page: ValidProviderPage; credentialVersion: number }> {
    let credentials: BrokeredProviderCredentials;
    try {
      credentials = await options.credentialBroker.get(
        item.source.id,
        item.claims.householdId
      );
    } catch (error) {
      normalizeDependencyError(error);
    }
    let adapter;
    try {
      adapter = options.providers.get(item.source.provider);
    } catch (error) {
      normalizeDependencyError(error);
    }
    const operation = (activeCredentials: ProviderCredentials) =>
      adapter.listFolder({
        credentials: activeCredentials,
        folderId: item.claims.providerNodeId,
        cursor: providerCursor,
        pageSize
      });
    try {
      const page = await operation(credentials!);
      return {
        page: normalizeProviderPage(page),
        credentialVersion: credentials!.credentialVersion
      };
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.code === "PROVIDER_REAUTH_REQUIRED" &&
        error.reauthReason !== "invalid_grant"
      ) {
        try {
          credentials = await options.credentialBroker.refresh(
            item.source.id,
            item.claims.householdId
          );
          const page = await operation(credentials);
          return {
            page: normalizeProviderPage(page),
            credentialVersion: credentials.credentialVersion
          };
        } catch (retryError) {
          normalizeDependencyError(retryError);
        }
      }
      normalizeDependencyError(error);
    }
  }

  async function folder(
    auth: AuthenticatedControlDevice,
    sealedHandle: string,
    sealedCursor: string | null,
    requestedPageSize: number
  ): Promise<TvFolderPageResponse> {
    const pageSize = normalizePageSize(requestedPageSize);
    const item = authorizeHandle(auth, sealedHandle);
    if (item.claims.kind !== "folder") {
      throw browseError("ITEM_NOT_FOUND");
    }
    const cursor = sealedCursor !== null
      ? authorizeCursor(
          auth,
          auth.context,
          options.handles,
          sealedCursor,
          item
        )
      : null;
    const listed = await listFolder(
      item,
      cursor?.providerCursor ?? null,
      pageSize
    );
    const issuedAt = now();
    const renewedParentClaims: BrowseItemClaims = {
      ...item.claims,
      credentialVersion: listed.credentialVersion,
      ...issueTimes(issuedAt)
    };
    let children: TvBrowseItemDto[];
    try {
      children = listed.page.items
        .map((node) => safeProviderNode(node, item.claims.providerNodeId))
        .filter((node): node is SafeProviderNode => node !== null)
        .map((node) => {
          const claims = itemClaims(
            item,
            node,
            issuedAt,
            listed.credentialVersion
          );
          return itemDto(options.handles, claims, node);
        });
    } catch (error) {
      normalizeDependencyError(error);
    }
    const order =
      auth.context.document.devices[auth.deviceId]?.mediaOrder ??
      auth.context.document.household.defaultMediaOrder;
    return {
      parent: itemDto(options.handles, renewedParentClaims),
      children: sortBrowseItems(children, order),
      nextCursor:
        listed.page.nextCursor !== null
          ? options.handles.sealCursor({
              version: 2,
              householdId: item.claims.householdId,
              deviceId: item.claims.deviceId,
              sourceId: item.claims.sourceId,
              rootId: item.claims.rootId,
              rootProviderNodeId: item.claims.rootProviderNodeId,
              folderProviderNodeId: item.claims.providerNodeId,
              providerCursor: listed.page.nextCursor,
              credentialVersion: listed.credentialVersion,
              ...issueTimes(issuedAt)
            })
          : null
    };
  }

  return { home, folder, authorizeHandle, authorizeClaims };
}
