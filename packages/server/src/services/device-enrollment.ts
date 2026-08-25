import type {
  ApproveDeviceRequestBody,
  Device,
  DeviceRequest,
  DeviceSession,
  UpdateDeviceBody
} from "@cloudframe/shared";
import { hashOpaqueToken } from "../auth/tokens";
import type { ApiAppDependencies } from "../http/app";
import { HttpError } from "../http/errors";
import { SESSION_LIFETIME_MS } from "./admin-auth";

export const DEVICE_REQUEST_LIFETIME_MS = 30 * 60 * 1000;

export function validateName(value: unknown): string {
  if (typeof value !== "string") throw invalidName();
  const name = value.trim();
  if (!name || name.length > 80) throw invalidName();
  return name;
}

export function validateRootIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(
      400,
      "ROOT_ASSIGNMENT_REQUIRED",
      "At least one root must be assigned."
    );
  }
  if (
    value.some(root => typeof root !== "string" || !root) ||
    new Set(value).size !== value.length
  ) {
    throw invalidRoots();
  }
  return [...value];
}

export async function validateRootsExist(
  dependencies: ApiAppDependencies,
  rootIds: string[]
): Promise<void> {
  const roots = await Promise.all(
    rootIds.map(rootId => dependencies.repository.getRoot(rootId))
  );
  if (
    roots.some(
      root =>
        !root ||
        !root.enabled ||
        root.householdId !== dependencies.config.householdId
    )
  ) {
    throw invalidRoots();
  }
}

export async function approveRequest(
  dependencies: ApiAppDependencies,
  requestId: string,
  body: ApproveDeviceRequestBody,
  now: Date
): Promise<Device> {
  const name = validateName(body.name);
  const rootIds = validateRootIds(body.rootIds);
  await validateRootsExist(dependencies, rootIds);
  const request = await dependencies.repository.getDeviceRequest(requestId);
  if (!request || request.householdId !== dependencies.config.householdId) {
    throw new HttpError(404, "DEVICE_REQUEST_NOT_FOUND", "Device request not found.");
  }
  if (request.status !== "pending") {
    throw new HttpError(409, "DEVICE_REQUEST_RESOLVED", "Device request is already resolved.");
  }
  if (request.expiresAt <= now) {
    await dependencies.repository.expireDeviceRequest({
      requestId,
      householdId: dependencies.config.householdId,
      now
    });
    throw new HttpError(410, "DEVICE_REQUEST_EXPIRED", "Device request has expired.");
  }
  const createId = dependencies.createId!;
  const deviceId = createId("device");
  const device: Device = {
    id: deviceId,
    householdId: dependencies.config.householdId,
    name,
    enabled: true,
    assignedRootIds: rootIds,
    mediaOrder: null,
    slideshowSeconds: null,
    createdAt: now,
    approvedAt: now,
    lastSeenAt: now,
    revokedAt: null
  };
  const session: DeviceSession = {
    id: createId("device-session"),
    householdId: dependencies.config.householdId,
    deviceId,
    tokenHash: request.requestSecretHash,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
    revokedAt: null
  };
  try {
    await dependencies.repository.approveDeviceRequestWithRoots({
      requestId,
      device,
      session,
      rootIds,
      approvedAt: now
    });
  } catch {
    throw new HttpError(409, "DEVICE_REQUEST_RESOLVED", "Device request is already resolved.");
  }
  return device;
}

export async function updateDevice(
  dependencies: ApiAppDependencies,
  deviceId: string,
  body: UpdateDeviceBody
): Promise<Device> {
  const existing = await dependencies.repository.getDevice(deviceId);
  if (!existing || existing.householdId !== dependencies.config.householdId) {
    throw new HttpError(404, "DEVICE_NOT_FOUND", "Device not found.");
  }
  const rootIds = body.assignedRootIds === undefined
    ? existing.assignedRootIds
    : validateRootIds(body.assignedRootIds);
  await validateRootsExist(dependencies, rootIds);
  const patch: Parameters<typeof dependencies.repository.updateDeviceWithRoots>[0]["patch"] = {};
  if (body.name !== undefined) patch.name = validateName(body.name);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw invalidUpdate();
    patch.enabled = body.enabled;
  }
  if (body.mediaOrder !== undefined) {
    if (![null, "captured-desc", "captured-asc", "name-asc"].includes(body.mediaOrder)) throw invalidUpdate();
    patch.mediaOrder = body.mediaOrder;
  }
  if (body.slideshowSeconds !== undefined) {
    if (body.slideshowSeconds !== null && (!Number.isInteger(body.slideshowSeconds) || body.slideshowSeconds < 2 || body.slideshowSeconds > 300)) throw invalidUpdate();
    patch.slideshowSeconds = body.slideshowSeconds;
  }
  return dependencies.repository.updateDeviceWithRoots({
    deviceId,
    householdId: dependencies.config.householdId,
    rootIds,
    patch
  });
}

export function requestFromToken(
  tokenHash: string,
  id: string,
  householdId: string,
  requestedName: string,
  now: Date
): DeviceRequest {
  return {
    id,
    householdId,
    requestSecretHash: tokenHash,
    requestedName,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(now.getTime() + DEVICE_REQUEST_LIFETIME_MS),
    resolvedAt: null,
    approvedDeviceId: null
  };
}

export function requestHash(raw: string): string {
  return hashOpaqueToken(raw);
}

function invalidName(): HttpError {
  return new HttpError(
    400,
    "INVALID_DEVICE_NAME",
    "Device names must contain 1 to 80 characters."
  );
}

function invalidRoots(): HttpError {
  return new HttpError(
    400,
    "INVALID_ROOT_ASSIGNMENT",
    "Every assigned root must be unique, enabled, and belong to this household."
  );
}

function invalidUpdate(): HttpError {
  return new HttpError(400, "INVALID_DEVICE_UPDATE", "The device update is invalid.");
}
