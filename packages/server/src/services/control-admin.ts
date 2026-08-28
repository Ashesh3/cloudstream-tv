import {
  type AdminSnapshotResponse,
  type ApproveDeviceRequestBody,
  type AssignedRootDto,
  type ControlDeviceDto,
  type ControlPlaneDevice,
  type ControlPlaneDocumentV2,
  type ControlPlaneRequest,
  type ControlPlaneRoot,
  type DeviceDto,
  type DeviceRequestDto,
  type SourceImpactResponse,
  type UpdateAdminSettingsBody,
  type UpdateDeviceBody
} from "@cloudframe/shared";
import { hashPassphrase, verifyPassphrase } from "../auth/passphrase";
import {
  approveDeviceRequestMutation,
  removeRootMutation,
  removeSourceMutation,
  resolveDeviceRequestMutation,
  revokeDeviceMutation,
  rotatePassphraseMutation,
  updateDeviceMutation,
  updateSettingsMutation
} from "../control-plane/mutations";
import type {
  ControlHotCache,
  ControlMutationResult,
  ControlPlaneStore
} from "../control-plane/store";

export type ControlAdminServiceErrorCode =
  | "DEVICE_NOT_FOUND"
  | "HOUSEHOLD_NOT_FOUND"
  | "INVALID_CREDENTIALS"
  | "INVALID_PASSPHRASE"
  | "ROOT_NOT_FOUND"
  | "SOURCE_NOT_FOUND";

export class ControlAdminServiceError extends Error {
  constructor(readonly code: ControlAdminServiceErrorCode) {
    super(code);
    this.name = "ControlAdminServiceError";
  }
}

export interface ControlAdminService {
  recoveryStatus(): Promise<{
    status: "current" | "delayed";
    revision: number | null;
  }>;
  snapshot(householdId: string): Promise<AdminSnapshotResponse>;
  updateSettings(
    householdId: string,
    input: UpdateAdminSettingsBody
  ): Promise<{ revision: number }>;
  rotatePassphrase(
    householdId: string,
    current: string,
    next: string
  ): Promise<{ revision: number }>;
  approveRequest(
    householdId: string,
    requestId: string,
    input: ApproveDeviceRequestBody,
    now?: Date
  ): Promise<{ device: DeviceDto }>;
  denyRequest(
    householdId: string,
    requestId: string
  ): Promise<{ request: DeviceRequestDto }>;
  updateDevice(
    householdId: string,
    deviceId: string,
    input: UpdateDeviceBody
  ): Promise<{ device: DeviceDto }>;
  revokeDevice(
    householdId: string,
    deviceId: string
  ): Promise<{ revoked: true }>;
  sourceImpact(
    householdId: string,
    sourceId: string
  ): Promise<SourceImpactResponse>;
  removeSource(
    householdId: string,
    sourceId: string
  ): Promise<{ removed: true } & SourceImpactResponse>;
  rootImpact(
    householdId: string,
    rootId: string
  ): Promise<SourceImpactResponse>;
  removeRoot(
    householdId: string,
    rootId: string
  ): Promise<{ removed: true } & SourceImpactResponse>;
}

export interface ControlAdminServiceDependencies {
  store: ControlPlaneStore;
  cache: ControlHotCache;
  passphrasePepper: string;
  now?: () => Date;
  createId?: (prefix: string) => string;
}

const collator = new Intl.Collator("en", {
  sensitivity: "base",
  numeric: true
});

function compareText(left: string, right: string): number {
  return collator.compare(left, right);
}

function compareCreatedNewest(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string }
): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    compareText(left.id, right.id)
  );
}

function assertHousehold(
  document: ControlPlaneDocumentV2,
  householdId: string
): void {
  if (document.householdId !== householdId) {
    throw new ControlAdminServiceError("HOUSEHOLD_NOT_FOUND");
  }
}

function encodeControlDevice(value: ControlPlaneDevice): ControlDeviceDto {
  return {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    assignedRootIds: [...value.assignedRootIds],
    mediaOrder: value.mediaOrder,
    slideshowSeconds: value.slideshowSeconds,
    createdAt: value.createdAt,
    approvedAt: value.approvedAt,
    revokedAt: value.revokedAt
  };
}

function encodeDevice(value: ControlPlaneDevice): DeviceDto {
  return {
    ...encodeControlDevice(value),
    lastSeenAt: value.approvedAt
  };
}

function encodeRequest(value: ControlPlaneRequest): DeviceRequestDto {
  return {
    id: value.id,
    requestedName: value.requestedName,
    status: value.status,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    resolvedAt: value.resolvedAt,
    approvedDeviceId: value.approvedDeviceId
  };
}

function encodeRoot(value: ControlPlaneRoot): AssignedRootDto {
  return {
    id: value.id,
    sourceId: value.sourceId,
    providerNodeId: value.providerNodeId,
    displayName: value.displayName,
    ancestryProviderIds: [...value.ancestryProviderIds],
    enabled: value.enabled,
    createdAt: value.createdAt
  };
}

function impactForRoot(
  document: ControlPlaneDocumentV2,
  rootId: string
): SourceImpactResponse {
  const root = document.roots[rootId];
  if (!root) throw new ControlAdminServiceError("ROOT_NOT_FOUND");
  return {
    roots: [encodeRoot(root)],
    devices: Object.values(document.devices)
      .filter((device) => device.assignedRootIds.includes(rootId))
      .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))
      .map(encodeDevice)
  };
}

function impactForSource(
  document: ControlPlaneDocumentV2,
  sourceId: string
): SourceImpactResponse {
  if (!document.sources[sourceId]) {
    throw new ControlAdminServiceError("SOURCE_NOT_FOUND");
  }
  const roots = Object.values(document.roots)
    .filter((root) => root.sourceId === sourceId)
    .sort((left, right) => compareText(left.displayName, right.displayName) || compareText(left.id, right.id));
  const rootIds = new Set(roots.map((root) => root.id));
  return {
    roots: roots.map(encodeRoot),
    devices: Object.values(document.devices)
      .filter((device) => device.assignedRootIds.some((rootId) => rootIds.has(rootId)))
      .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))
      .map(encodeDevice)
  };
}

export function createControlAdminService(
  dependencies: ControlAdminServiceDependencies
): ControlAdminService {
  const { cache, passphrasePepper, store } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const createId =
    dependencies.createId ?? ((prefix: string) => `${prefix}-${crypto.randomUUID()}`);

  async function load(householdId: string): Promise<ControlPlaneDocumentV2> {
    const { document } = await store.load();
    assertHousehold(document, householdId);
    return document;
  }

  async function mutate<T>(
    householdId: string,
    name: string,
    reducer: (current: ControlPlaneDocumentV2) => ControlMutationResult<T>
  ): Promise<T> {
    return store.mutate(name, (current) => {
      assertHousehold(current, householdId);
      const mutation = reducer(current);
      if (!mutation.changed) return mutation;
      return {
        ...mutation,
        next: { ...mutation.next, revision: current.revision + 1 }
      };
    });
  }

  async function snapshot(householdId: string): Promise<AdminSnapshotResponse> {
    const [document, recoveryCopy] = await Promise.all([
      load(householdId),
      cache.getMirrorStatus()
    ]);
    const currentTime = now().getTime();
    return {
      revision: document.revision,
      household: {
        allowNewDeviceRequests: document.household.allowNewDeviceRequests,
        defaultMediaOrder: document.household.defaultMediaOrder,
        defaultSlideshowSeconds: document.household.defaultSlideshowSeconds
      },
      pendingRequests: Object.values(document.pendingDeviceRequests)
        .filter(
          (request) =>
            request.status === "pending" &&
            Date.parse(request.expiresAt) > currentTime
        )
        .sort(compareCreatedNewest)
        .map((request) => ({
          id: request.id,
          requestedName: request.requestedName,
          status: request.status,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
          resolvedAt: request.resolvedAt,
          approvedDeviceId: request.approvedDeviceId
        })),
      devices: Object.values(document.devices)
        .sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id))
        .map(encodeControlDevice),
      sources: Object.values(document.sources)
        .sort((left, right) => compareText(left.accountLabel, right.accountLabel) || compareText(left.id, right.id))
        .map((source) => ({
          id: source.id,
          provider: source.provider,
          accountLabel: source.accountLabel,
          status: source.status,
          createdAt: source.createdAt
        })),
      roots: Object.values(document.roots)
        .sort((left, right) => compareText(left.displayName, right.displayName) || compareText(left.id, right.id))
        .map((root) => ({
          id: root.id,
          sourceId: root.sourceId,
          displayName: root.displayName,
          enabled: root.enabled,
          createdAt: root.createdAt
        })),
      recoveryCopy
    };
  }

  async function updateSettings(
    householdId: string,
    input: UpdateAdminSettingsBody
  ): Promise<{ revision: number }> {
    return mutate(householdId, "settings", (current) => {
      const mutation = updateSettingsMutation(current, input);
      return {
        ...mutation,
        result: {
          revision: mutation.changed ? current.revision + 1 : current.revision
        }
      };
    });
  }

  async function rotatePassphrase(
    householdId: string,
    currentPassphrase: string,
    nextPassphrase: string
  ): Promise<{ revision: number }> {
    if (
      currentPassphrase.length < 16 ||
      currentPassphrase.length > 1024 ||
      nextPassphrase.length < 16 ||
      nextPassphrase.length > 1024
    ) {
      throw new ControlAdminServiceError("INVALID_PASSPHRASE");
    }
    const document = await load(householdId);
    const expectedHash = document.household.adminPassphraseHash;
    if (!(await verifyPassphrase(expectedHash, currentPassphrase, passphrasePepper))) {
      throw new ControlAdminServiceError("INVALID_CREDENTIALS");
    }
    const nextHash = await hashPassphrase(nextPassphrase, passphrasePepper);
    return mutate(householdId, "passphrase", (current) => {
      if (current.household.adminPassphraseHash !== expectedHash) {
        throw new ControlAdminServiceError("INVALID_CREDENTIALS");
      }
      const mutation = rotatePassphraseMutation(current, nextHash);
      return {
        ...mutation,
        result: {
          revision: mutation.changed ? current.revision + 1 : current.revision
        }
      };
    });
  }

  async function approveRequest(
    householdId: string,
    requestId: string,
    input: ApproveDeviceRequestBody,
    requestedAt?: Date
  ): Promise<{ device: DeviceDto }> {
    const approvedAt = (requestedAt ?? now()).toISOString();
    const deviceId = createId("device");
    return mutate(householdId, "approve-device-request", (current) => {
      const device: ControlPlaneDevice = {
        id: deviceId,
        name: input.name,
        enabled: true,
        assignedRootIds: [...input.rootIds],
        mediaOrder: null,
        slideshowSeconds: null,
        sessionVersion: 1,
        createdAt: approvedAt,
        approvedAt,
        revokedAt: null
      };
      const mutation = approveDeviceRequestMutation(
        current,
        requestId,
        device,
        input.rootIds
      );
      return { ...mutation, result: { device: encodeDevice(mutation.result) } };
    });
  }

  async function denyRequest(
    householdId: string,
    requestId: string
  ): Promise<{ request: DeviceRequestDto }> {
    const resolvedAt = now();
    return mutate(householdId, "deny-device-request", (current) => {
      const mutation = resolveDeviceRequestMutation(
        current,
        requestId,
        "denied",
        resolvedAt
      );
      return { ...mutation, result: { request: encodeRequest(mutation.result) } };
    });
  }

  async function updateDevice(
    householdId: string,
    deviceId: string,
    input: UpdateDeviceBody
  ): Promise<{ device: DeviceDto }> {
    return mutate(householdId, "update-device", (current) => {
      const mutation = updateDeviceMutation(current, deviceId, input);
      return { ...mutation, result: { device: encodeDevice(mutation.result) } };
    });
  }

  async function revokeDevice(
    householdId: string,
    deviceId: string
  ): Promise<{ revoked: true }> {
    const revokedAt = now();
    return mutate(householdId, "revoke-device", (current) => {
      const mutation = revokeDeviceMutation(current, deviceId, revokedAt);
      return { ...mutation, result: { revoked: true as const } };
    });
  }

  async function sourceImpact(
    householdId: string,
    sourceId: string
  ): Promise<SourceImpactResponse> {
    return impactForSource(await load(householdId), sourceId);
  }

  async function removeSource(
    householdId: string,
    sourceId: string
  ): Promise<{ removed: true } & SourceImpactResponse> {
    return mutate(householdId, "remove-source", (current) => {
      const impact = impactForSource(current, sourceId);
      const mutation = removeSourceMutation(current, sourceId);
      return { ...mutation, result: { removed: true as const, ...impact } };
    });
  }

  async function rootImpact(
    householdId: string,
    rootId: string
  ): Promise<SourceImpactResponse> {
    return impactForRoot(await load(householdId), rootId);
  }

  async function removeRoot(
    householdId: string,
    rootId: string
  ): Promise<{ removed: true } & SourceImpactResponse> {
    return mutate(householdId, "remove-root", (current) => {
      const impact = impactForRoot(current, rootId);
      const mutation = removeRootMutation(current, rootId);
      return { ...mutation, result: { removed: true as const, ...impact } };
    });
  }

  return {
    recoveryStatus: () => cache.getMirrorStatus(),
    snapshot,
    updateSettings,
    rotatePassphrase,
    approveRequest,
    denyRequest,
    updateDevice,
    revokeDevice,
    sourceImpact,
    removeSource,
    rootImpact,
    removeRoot
  };
}
