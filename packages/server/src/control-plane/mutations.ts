import {
  CONTROL_PLANE_LIMITS,
  type ControlPlaneDevice,
  type ControlPlaneDocumentV2,
  type ControlPlaneRequest,
  type ControlPlaneRoot,
  type ControlPlaneSource,
  type EncryptedSecret,
  type UpdateAdminSettingsBody,
  type UpdateDeviceBody
} from "@cloudframe/shared";
import { parseControlPlaneDocument } from "./schema";
import type { ControlMutationResult } from "./store";

export type ControlMutationErrorCode =
  | "CONTROL_PLANE_LIMIT_EXCEEDED"
  | "DEVICE_ALREADY_EXISTS"
  | "DEVICE_NOT_FOUND"
  | "DEVICE_REVOKED"
  | "DEVICE_REQUEST_EXPIRED"
  | "DEVICE_REQUEST_NOT_FOUND"
  | "DEVICE_REQUEST_RESOLVED"
  | "INVALID_ROOT_ASSIGNMENT"
  | "ROOT_IDENTITY_MISMATCH"
  | "SOURCE_IDENTITY_MISMATCH"
  | "SOURCE_NOT_FOUND";

export class ControlMutationError extends Error {
  constructor(readonly code: ControlMutationErrorCode) {
    super(code);
    this.name = "ControlMutationError";
  }
}

export interface VerifiedSourceAccount {
  provider: ControlPlaneSource["provider"];
  providerAccountId: string;
  providerRootId: string;
  accountLabel: string;
  encryptedRefreshToken?: EncryptedSecret;
  encryptedBootstrapAccessToken: EncryptedSecret | null;
  bootstrapAccessTokenExpiresAt: string | null;
}

function clone(document: ControlPlaneDocumentV2): ControlPlaneDocumentV2 {
  return parseControlPlaneDocument(document);
}

function unchanged<T>(
  document: ControlPlaneDocumentV2,
  result: T
): ControlMutationResult<T> {
  return { changed: false, next: clone(document), result };
}

function changed<T>(
  document: ControlPlaneDocumentV2,
  result: T
): ControlMutationResult<T> {
  return { changed: true, next: parseControlPlaneDocument(document), result };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertRootIds(
  document: ControlPlaneDocumentV2,
  rootIds: readonly string[]
): string[] {
  if (new Set(rootIds).size !== rootIds.length) {
    throw new ControlMutationError("INVALID_ROOT_ASSIGNMENT");
  }
  for (const rootId of rootIds) {
    const root = document.roots[rootId];
    if (!root || !root.enabled) {
      throw new ControlMutationError("INVALID_ROOT_ASSIGNMENT");
    }
  }
  return [...rootIds];
}

function expired(request: ControlPlaneRequest, now: Date): boolean {
  return Date.parse(request.expiresAt) <= now.getTime();
}

function pruneExpired(
  document: ControlPlaneDocumentV2,
  now: Date,
  retainedRequestId?: string
): boolean {
  let pruned = false;
  for (const [requestId, request] of Object.entries(
    document.pendingDeviceRequests
  )) {
    if (requestId === retainedRequestId) continue;
    if (expired(request, now)) {
      delete document.pendingDeviceRequests[requestId];
      pruned = true;
    }
  }
  return pruned;
}

export function updateSettingsMutation(
  document: ControlPlaneDocumentV2,
  input: UpdateAdminSettingsBody
): ControlMutationResult<ControlPlaneDocumentV2["household"]> {
  const next = clone(document);
  const household = {
    ...next.household,
    ...(input.allowNewDeviceRequests === undefined
      ? {}
      : { allowNewDeviceRequests: input.allowNewDeviceRequests }),
    ...(input.defaultMediaOrder === undefined
      ? {}
      : { defaultMediaOrder: input.defaultMediaOrder }),
    ...(input.defaultSlideshowSeconds === undefined
      ? {}
      : { defaultSlideshowSeconds: input.defaultSlideshowSeconds })
  };
  if (same(household, next.household)) {
    return unchanged(document, next.household);
  }
  next.household = household;
  return changed(next, next.household);
}

export function rotatePassphraseMutation(
  document: ControlPlaneDocumentV2,
  newHash: string
): ControlMutationResult<ControlPlaneDocumentV2["household"]> {
  const next = clone(document);
  if (next.household.adminPassphraseHash === newHash) {
    return unchanged(document, next.household);
  }
  next.household = {
    ...next.household,
    adminPassphraseHash: newHash,
    adminPassphraseVersion: next.household.adminPassphraseVersion + 1
  };
  return changed(next, next.household);
}

export function createDeviceRequestMutation(
  document: ControlPlaneDocumentV2,
  request: ControlPlaneRequest
): ControlMutationResult<ControlPlaneRequest> {
  const next = clone(document);
  const now = new Date(request.createdAt);
  const pruned = pruneExpired(next, now, request.id);
  const existing = next.pendingDeviceRequests[request.id];
  if (existing) {
    if (!same(existing, request)) {
      throw new ControlMutationError("DEVICE_REQUEST_RESOLVED");
    }
    return pruned ? changed(next, existing) : unchanged(document, existing);
  }
  if (
    Object.keys(next.pendingDeviceRequests).length >=
    CONTROL_PLANE_LIMITS.pendingRequests
  ) {
    throw new ControlMutationError("CONTROL_PLANE_LIMIT_EXCEEDED");
  }
  next.pendingDeviceRequests[request.id] = structuredClone(request);
  return changed(next, next.pendingDeviceRequests[request.id]);
}

export function resolveDeviceRequestMutation(
  document: ControlPlaneDocumentV2,
  requestId: string,
  status: "denied" | "expired",
  now = new Date(document.updatedAt)
): ControlMutationResult<ControlPlaneRequest> {
  const next = clone(document);
  const request = next.pendingDeviceRequests[requestId];
  if (!request) {
    throw new ControlMutationError("DEVICE_REQUEST_NOT_FOUND");
  }
  pruneExpired(next, now, requestId);
  const resolvedStatus = request.status === "pending" && expired(request, now)
    ? "expired"
    : status;
  if (request.status !== "pending") {
    if (request.status === resolvedStatus) {
      return same(next, document)
        ? unchanged(document, request)
        : changed(next, request);
    }
    throw new ControlMutationError("DEVICE_REQUEST_RESOLVED");
  }
  request.status = resolvedStatus;
  request.resolvedAt = now.toISOString();
  request.approvedDeviceId = null;
  return changed(next, request);
}

export function approveDeviceRequestMutation(
  document: ControlPlaneDocumentV2,
  requestId: string,
  device: ControlPlaneDevice,
  rootIds: readonly string[]
): ControlMutationResult<ControlPlaneDevice> {
  const next = clone(document);
  const request = next.pendingDeviceRequests[requestId];
  if (!request) {
    throw new ControlMutationError("DEVICE_REQUEST_NOT_FOUND");
  }
  const approvedAt = new Date(device.approvedAt);
  if (request.status !== "pending") {
    if (
      request.status === "approved" &&
      request.approvedDeviceId === device.id &&
      same(next.devices[device.id], device)
    ) {
      return unchanged(document, next.devices[device.id]);
    }
    throw new ControlMutationError("DEVICE_REQUEST_RESOLVED");
  }
  if (expired(request, approvedAt)) {
    throw new ControlMutationError("DEVICE_REQUEST_EXPIRED");
  }
  pruneExpired(next, approvedAt, requestId);
  const assignedRootIds = assertRootIds(next, rootIds);
  const existing = next.devices[device.id];
  if (existing) {
    throw new ControlMutationError("DEVICE_ALREADY_EXISTS");
  }
  if (Object.keys(next.devices).length >= CONTROL_PLANE_LIMITS.devices) {
    throw new ControlMutationError("CONTROL_PLANE_LIMIT_EXCEEDED");
  }
  const approvedDevice = { ...structuredClone(device), assignedRootIds };
  next.devices[device.id] = approvedDevice;
  request.status = "approved";
  request.resolvedAt = device.approvedAt;
  request.approvedDeviceId = device.id;
  return changed(next, approvedDevice);
}

export function updateDeviceMutation(
  document: ControlPlaneDocumentV2,
  deviceId: string,
  patch: UpdateDeviceBody
): ControlMutationResult<ControlPlaneDevice> {
  const next = clone(document);
  const device = next.devices[deviceId];
  if (!device) {
    throw new ControlMutationError("DEVICE_NOT_FOUND");
  }
  if (device.revokedAt !== null && patch.enabled === true) {
    throw new ControlMutationError("DEVICE_REVOKED");
  }
  const updated: ControlPlaneDevice = {
    ...device,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.assignedRootIds === undefined
      ? {}
      : { assignedRootIds: assertRootIds(next, patch.assignedRootIds) }),
    ...(patch.mediaOrder === undefined ? {} : { mediaOrder: patch.mediaOrder }),
    ...(patch.slideshowSeconds === undefined
      ? {}
      : { slideshowSeconds: patch.slideshowSeconds })
  };
  if (same(updated, device)) {
    return unchanged(document, device);
  }
  next.devices[deviceId] = updated;
  return changed(next, updated);
}

export function revokeDeviceMutation(
  document: ControlPlaneDocumentV2,
  deviceId: string,
  now: Date
): ControlMutationResult<ControlPlaneDevice> {
  const next = clone(document);
  const device = next.devices[deviceId];
  if (!device) {
    throw new ControlMutationError("DEVICE_NOT_FOUND");
  }
  const pruned = pruneExpired(next, now);
  if (!device.enabled && device.revokedAt !== null) {
    return pruned ? changed(next, device) : unchanged(document, device);
  }
  const revoked = {
    ...device,
    enabled: false,
    sessionVersion: device.sessionVersion + 1,
    revokedAt: now.toISOString()
  };
  next.devices[deviceId] = revoked;
  return changed(next, revoked);
}

export function connectSourceMutation(
  document: ControlPlaneDocumentV2,
  source: ControlPlaneSource
): ControlMutationResult<ControlPlaneSource> {
  const next = clone(document);
  const existing = next.sources[source.id];
  if (existing) {
    if (!same(existing, source)) {
      throw new ControlMutationError("SOURCE_IDENTITY_MISMATCH");
    }
    return unchanged(document, existing);
  }
  if (Object.keys(next.sources).length >= CONTROL_PLANE_LIMITS.sources) {
    throw new ControlMutationError("CONTROL_PLANE_LIMIT_EXCEEDED");
  }
  next.sources[source.id] = structuredClone(source);
  return changed(next, next.sources[source.id]);
}

export function reconnectSourceMutation(
  document: ControlPlaneDocumentV2,
  sourceId: string,
  verifiedAccount: VerifiedSourceAccount
): ControlMutationResult<ControlPlaneSource> {
  const next = clone(document);
  const source = next.sources[sourceId];
  if (!source) {
    throw new ControlMutationError("SOURCE_NOT_FOUND");
  }
  if (
    source.provider !== verifiedAccount.provider ||
    source.providerAccountId !== verifiedAccount.providerAccountId ||
    source.providerRootId !== verifiedAccount.providerRootId
  ) {
    throw new ControlMutationError("SOURCE_IDENTITY_MISMATCH");
  }
  const reconnected: ControlPlaneSource = {
    ...source,
    accountLabel: verifiedAccount.accountLabel,
    encryptedRefreshToken:
      verifiedAccount.encryptedRefreshToken ?? source.encryptedRefreshToken,
    encryptedBootstrapAccessToken:
      verifiedAccount.encryptedBootstrapAccessToken,
    bootstrapAccessTokenExpiresAt:
      verifiedAccount.bootstrapAccessTokenExpiresAt,
    credentialVersion: source.credentialVersion + 1,
    status: "healthy"
  };
  next.sources[sourceId] = reconnected;
  return changed(next, reconnected);
}

export function markSourceReauthRequiredMutation(
  document: ControlPlaneDocumentV2,
  sourceId: string
): ControlMutationResult<ControlPlaneSource> {
  const next = clone(document);
  const source = next.sources[sourceId];
  if (!source) {
    throw new ControlMutationError("SOURCE_NOT_FOUND");
  }
  if (source.status === "reauth-required") {
    return unchanged(document, source);
  }
  const marked = { ...source, status: "reauth-required" as const };
  next.sources[sourceId] = marked;
  return changed(next, marked);
}

export function removeSourceMutation(
  document: ControlPlaneDocumentV2,
  sourceId: string
): ControlMutationResult<{ rootIds: string[]; deviceIds: string[] }> {
  const next = clone(document);
  if (!next.sources[sourceId]) {
    return unchanged(document, { rootIds: [], deviceIds: [] });
  }
  const rootIds = Object.values(next.roots)
    .filter((root) => root.sourceId === sourceId)
    .map((root) => root.id)
    .sort();
  const removedRoots = new Set(rootIds);
  const deviceIds: string[] = [];
  delete next.sources[sourceId];
  for (const rootId of rootIds) delete next.roots[rootId];
  for (const device of Object.values(next.devices)) {
    const assignedRootIds = device.assignedRootIds.filter(
      (rootId) => !removedRoots.has(rootId)
    );
    if (assignedRootIds.length !== device.assignedRootIds.length) {
      device.assignedRootIds = assignedRootIds;
      deviceIds.push(device.id);
    }
  }
  deviceIds.sort();
  return changed(next, { rootIds, deviceIds });
}

export function createOrEnableRootMutation(
  document: ControlPlaneDocumentV2,
  root: ControlPlaneRoot
): ControlMutationResult<ControlPlaneRoot> {
  const next = clone(document);
  if (!next.sources[root.sourceId]) {
    throw new ControlMutationError("SOURCE_NOT_FOUND");
  }
  const existing = next.roots[root.id];
  if (existing) {
    if (
      existing.sourceId !== root.sourceId ||
      existing.providerNodeId !== root.providerNodeId
    ) {
      throw new ControlMutationError("ROOT_IDENTITY_MISMATCH");
    }
    const enabled = { ...existing, ...structuredClone(root), enabled: true };
    if (same(enabled, existing)) {
      return unchanged(document, existing);
    }
    next.roots[root.id] = enabled;
    return changed(next, enabled);
  }
  if (Object.keys(next.roots).length >= CONTROL_PLANE_LIMITS.roots) {
    throw new ControlMutationError("CONTROL_PLANE_LIMIT_EXCEEDED");
  }
  next.roots[root.id] = { ...structuredClone(root), enabled: true };
  return changed(next, next.roots[root.id]);
}

export function removeRootMutation(
  document: ControlPlaneDocumentV2,
  rootId: string
): ControlMutationResult<{ deviceIds: string[] }> {
  const next = clone(document);
  if (!next.roots[rootId]) {
    return unchanged(document, { deviceIds: [] });
  }
  const deviceIds: string[] = [];
  delete next.roots[rootId];
  for (const device of Object.values(next.devices)) {
    const assignedRootIds = device.assignedRootIds.filter(
      (assignedRootId) => assignedRootId !== rootId
    );
    if (assignedRootIds.length !== device.assignedRootIds.length) {
      device.assignedRootIds = assignedRootIds;
      deviceIds.push(device.id);
    }
  }
  deviceIds.sort();
  return changed(next, { deviceIds });
}

export function rotateSourceCredentialsMutation(
  document: ControlPlaneDocumentV2,
  sourceId: string,
  expectedCredentialVersion: number,
  refreshToken: EncryptedSecret
): ControlMutationResult<ControlPlaneSource> {
  const next = clone(document);
  const source = next.sources[sourceId];
  if (!source) {
    throw new ControlMutationError("SOURCE_NOT_FOUND");
  }
  if (source.credentialVersion !== expectedCredentialVersion) {
    return unchanged(document, source);
  }
  if (same(source.encryptedRefreshToken, refreshToken)) {
    return unchanged(document, source);
  }
  const rotated = {
    ...source,
    encryptedRefreshToken: structuredClone(refreshToken),
    credentialVersion: source.credentialVersion + 1
  };
  next.sources[sourceId] = rotated;
  return changed(next, rotated);
}
