import { timingSafeEqual } from "node:crypto";

import type {
  ApproveDeviceRequestBody,
  ControlDeviceDto,
  ControlPlaneDocumentV2,
  ControlPlaneRequest,
  ControlRequestDto,
  TvBootstrapResponse
} from "@cloudframe/shared";

import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import type { SealedSessionCodec } from "../auth/sealed-sessions";
import { hashOpaqueToken, issueOpaqueToken, type OpaqueToken } from "../auth/tokens";
import {
  createDeviceRequestMutation,
  resolveDeviceRequestMutation
} from "../control-plane/mutations";
import type { ControlPlaneStore } from "../control-plane/store";
import type { ControlMutationReducer } from "../control-plane/store";
import type { ControlAdminService } from "./control-admin";
import {
  CONTROL_SESSION_LIFETIME_MS,
  type ControlRequestContext
} from "./control-auth";

export const CONTROL_DEVICE_REQUEST_LIFETIME_MS = 30 * 60 * 1_000;

export type ControlEnrollmentErrorCode =
  | "DEVICE_REQUEST_REQUIRED"
  | "DEVICE_REQUESTS_DISABLED"
  | "HOUSEHOLD_NOT_FOUND"
  | "INVALID_DEVICE_NAME";

export class ControlEnrollmentError extends Error {
  constructor(
    readonly code: ControlEnrollmentErrorCode,
    readonly clearCookie?: string
  ) {
    super(code);
    this.name = "ControlEnrollmentError";
  }
}

export interface ControlEnrollmentStatus {
  enrollment: TvBootstrapResponse["enrollment"];
  deviceCookie?: string;
  setDeviceCookie?: string;
  clearRequestCookie?: string;
}

export interface CreateControlEnrollmentResult {
  request: ControlRequestDto;
  cookie: string;
  setRequestCookie: string;
}

export interface ControlEnrollmentService {
  createRequest(
    requestedName: string,
    requestSubject: string,
    now: Date
  ): Promise<CreateControlEnrollmentResult>;
  status(
    requestCookie: string,
    now: Date,
    context?: ControlRequestContext
  ): Promise<ControlEnrollmentStatus>;
  approve(
    requestId: string,
    input: ApproveDeviceRequestBody,
    now: Date
  ): Promise<{ device: ControlDeviceDto }>;
  deny(
    requestId: string,
    now: Date
  ): Promise<{ request: ControlRequestDto }>;
}

export interface ControlEnrollmentDependencies {
  store: ControlPlaneStore;
  codec: SealedSessionCodec;
  admin: ControlAdminService;
  householdId: string;
  createId?: (prefix: string) => string;
  issueRequestSecret?: () => OpaqueToken;
}

function assertHousehold(
  document: ControlPlaneDocumentV2,
  householdId: string
): void {
  if (document.householdId !== householdId) {
    throw new ControlEnrollmentError("HOUSEHOLD_NOT_FOUND");
  }
}

function encodeRequest(request: ControlPlaneRequest): ControlRequestDto {
  return {
    id: request.id,
    requestedName: request.requestedName,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
    approvedDeviceId: request.approvedDeviceId
  };
}

function encodeDevice(
  device: ControlPlaneDocumentV2["devices"][string]
): ControlDeviceDto {
  return {
    id: device.id,
    name: device.name,
    enabled: device.enabled,
    assignedRootIds: [...device.assignedRootIds],
    mediaOrder: device.mediaOrder,
    slideshowSeconds: device.slideshowSeconds,
    createdAt: device.createdAt,
    approvedAt: device.approvedAt,
    revokedAt: device.revokedAt
  };
}

function household(
  document: ControlPlaneDocumentV2
): Extract<TvBootstrapResponse["enrollment"], { state: "ready" }>["household"] {
  return {
    allowNewDeviceRequests: document.household.allowNewDeviceRequests,
    defaultMediaOrder: document.household.defaultMediaOrder,
    defaultSlideshowSeconds: document.household.defaultSlideshowSeconds
  };
}

function validName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120) {
    throw new ControlEnrollmentError("INVALID_DEVICE_NAME");
  }
  return name;
}

function sameHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function invalidRequest(): ControlEnrollmentError {
  return new ControlEnrollmentError(
    "DEVICE_REQUEST_REQUIRED",
    clearSessionCookie("request")
  );
}

interface ClaimedEnrollment {
  document: ControlPlaneDocumentV2;
  device: ControlPlaneDocumentV2["devices"][string];
}

export function createControlEnrollmentService(
  dependencies: ControlEnrollmentDependencies
): ControlEnrollmentService {
  const createId =
    dependencies.createId ??
    ((prefix: string) => `${prefix}-${crypto.randomUUID()}`);
  const issueRequestSecret = dependencies.issueRequestSecret ?? issueOpaqueToken;

  async function mutate<T>(
    name: string,
    reducer: ControlMutationReducer<T>
  ): Promise<T> {
    return dependencies.store.mutate(name, (current) => {
      assertHousehold(current, dependencies.householdId);
      const mutation = reducer(current);
      if (!mutation.changed) return mutation;
      return {
        ...mutation,
        next: { ...mutation.next, revision: current.revision + 1 }
      };
    });
  }

  async function createRequest(
    requestedName: string,
    requestSubject: string,
    now: Date
  ): Promise<CreateControlEnrollmentResult> {
    void requestSubject;
    const name = validName(requestedName);
    const requestId = createId("device-request");
    const secret = issueRequestSecret();
    const expiresAt = new Date(now.getTime() + CONTROL_DEVICE_REQUEST_LIFETIME_MS);
    const request: ControlPlaneRequest = {
      id: requestId,
      requestedName: name,
      requestSecretHash: secret.hash,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      resolvedAt: null,
      approvedDeviceId: null
    };
    const created = await mutate<ControlPlaneRequest>(
      "create-device-request",
      (current) => {
        if (!current.household.allowNewDeviceRequests) {
          throw new ControlEnrollmentError("DEVICE_REQUESTS_DISABLED");
        }
        return createDeviceRequestMutation(current, request);
      }
    );
    const cookie = dependencies.codec.issueRequest({
      version: 2,
      householdId: dependencies.householdId,
      requestId,
      requestSecret: secret.raw,
      issuedAt: now.getTime(),
      expiresAt: expiresAt.getTime()
    });
    return {
      request: encodeRequest(created),
      cookie,
      setRequestCookie: createSessionCookie("request", cookie, expiresAt)
    };
  }

  async function status(
    requestCookie: string,
    now: Date,
    context?: ControlRequestContext
  ): Promise<ControlEnrollmentStatus> {
    let claims;
    try {
      claims = dependencies.codec.openRequest(requestCookie);
    } catch {
      throw invalidRequest();
    }
    let active: ControlRequestContext;
    if (context) {
      active = context;
    } else {
      const { document } = await dependencies.store.load();
      active = { document, revision: document.revision };
    }
    if (
      active.revision !== active.document.revision ||
      active.document.householdId !== dependencies.householdId ||
      claims.householdId !== dependencies.householdId ||
      claims.householdId !== active.document.householdId
    ) {
      throw invalidRequest();
    }
    const request = active.document.pendingDeviceRequests[claims.requestId];
    if (
      !request ||
      !sameHash(hashOpaqueToken(claims.requestSecret), request.requestSecretHash)
    ) {
      throw invalidRequest();
    }
    if (Date.parse(request.expiresAt) <= now.getTime()) {
      return {
        enrollment: { state: "expired" },
        clearRequestCookie: clearSessionCookie("request")
      };
    }
    if (request.status === "denied" || request.status === "expired") {
      return {
        enrollment: { state: request.status },
        clearRequestCookie: clearSessionCookie("request")
      };
    }
    if (request.status === "approved" && request.approvedDeviceId) {
      const device = active.document.devices[request.approvedDeviceId];
      if (!device || !device.enabled || device.revokedAt !== null) {
        return {
          enrollment: { state: "revoked" },
          clearRequestCookie: clearSessionCookie("request")
        };
      }
      const expectedSecretHash = request.requestSecretHash;
      const expectedDeviceId = request.approvedDeviceId;
      const claimed = await mutate<ClaimedEnrollment>(
        "claim-approved-device-request",
        (current) => {
          const currentRequest = current.pendingDeviceRequests[claims.requestId];
          if (
            !currentRequest ||
            currentRequest.id !== claims.requestId ||
            currentRequest.status !== "approved" ||
            currentRequest.approvedDeviceId !== expectedDeviceId ||
            Date.parse(currentRequest.expiresAt) <= now.getTime() ||
            !sameHash(currentRequest.requestSecretHash, expectedSecretHash) ||
            !sameHash(hashOpaqueToken(claims.requestSecret), currentRequest.requestSecretHash)
          ) {
            throw invalidRequest();
          }
          const currentDevice = current.devices[expectedDeviceId];
          if (
            !currentDevice ||
            !currentDevice.enabled ||
            currentDevice.revokedAt !== null
          ) {
            throw invalidRequest();
          }
          const next = structuredClone(current);
          delete next.pendingDeviceRequests[claims.requestId];
          return {
            changed: true,
            next,
            result: {
              document: next,
              device: structuredClone(currentDevice)
            }
          };
        }
      );
      const expiresAt = new Date(now.getTime() + CONTROL_SESSION_LIFETIME_MS);
      const deviceCookie = dependencies.codec.issueDevice({
        version: 2,
        householdId: dependencies.householdId,
        deviceId: claimed.device.id,
        sessionVersion: claimed.device.sessionVersion,
        issuedAt: now.getTime(),
        expiresAt: expiresAt.getTime()
      });
      return {
        enrollment: {
          state: "ready",
          device: encodeDevice(claimed.device),
          household: household(claimed.document)
        },
        deviceCookie,
        setDeviceCookie: createSessionCookie("device", deviceCookie, expiresAt),
        clearRequestCookie: clearSessionCookie("request")
      };
    }
    if (request.status !== "pending") throw invalidRequest();
    return {
      enrollment: { state: "pending", request: encodeRequest(request) }
    };
  }

  async function approve(
    requestId: string,
    input: ApproveDeviceRequestBody,
    now: Date
  ): Promise<{ device: ControlDeviceDto }> {
    const result = await dependencies.admin.approveRequest(
      dependencies.householdId,
      requestId,
      input,
      now
    );
    return {
      device: {
        id: result.device.id,
        name: result.device.name,
        enabled: result.device.enabled,
        assignedRootIds: [...result.device.assignedRootIds],
        mediaOrder: result.device.mediaOrder,
        slideshowSeconds: result.device.slideshowSeconds,
        createdAt: result.device.createdAt,
        approvedAt: result.device.approvedAt,
        revokedAt: result.device.revokedAt
      }
    };
  }

  async function deny(
    requestId: string,
    now: Date
  ): Promise<{ request: ControlRequestDto }> {
    const request = await mutate<ControlPlaneRequest>(
      "deny-device-request",
      (current) => resolveDeviceRequestMutation(current, requestId, "denied", now)
    );
    return { request: encodeRequest(request) };
  }

  return { createRequest, status, approve, deny };
}
