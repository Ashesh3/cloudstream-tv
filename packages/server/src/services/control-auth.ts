import type {
  ControlPlaneDevice,
  ControlPlaneDocumentV2,
  ControlPlaneRoot
} from "@cloudframe/shared";

import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import { verifyPassphrase } from "../auth/passphrase";
import type {
  AdminSessionClaims,
  DeviceSessionClaims,
  SealedSessionCodec
} from "../auth/sealed-sessions";
import type { ControlPlaneStore } from "../control-plane/store";
import { parseCookies } from "../http/request";
import { csrfToken } from "./admin-auth";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const CONTROL_SESSION_LIFETIME_MS = 365 * DAY_MS;

export interface ControlRequestContext {
  document: ControlPlaneDocumentV2;
  revision: number;
}

export type ControlAuthErrorCode =
  | "ADMIN_UNAUTHORIZED"
  | "DEVICE_UNAUTHORIZED"
  | "INVALID_CREDENTIALS";

export class ControlAuthError extends Error {
  constructor(
    readonly code: ControlAuthErrorCode,
    readonly clearCookie?: string
  ) {
    super(code);
    this.name = "ControlAuthError";
  }
}

export interface AuthenticatedControlAdmin {
  householdId: string;
  sessionId: string;
  adminPassphraseVersion: number;
  csrfToken: string;
}

export interface AuthenticatedControlDevice {
  householdId: string;
  deviceId: string;
  sessionVersion: number;
  device: ControlPlaneDevice;
  root?: ControlPlaneRoot;
  context: ControlRequestContext;
}

export interface ControlAdminLoginResult {
  authenticated: true;
  cookie: string;
  setCookie: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface ControlAdminLogoutResult {
  authenticated: false;
  clearCookie: string;
}

export interface ControlAuth {
  admin(
    request: Request,
    context: ControlRequestContext,
    now: Date
  ): Promise<AuthenticatedControlAdmin>;
  device(
    request: Request,
    context: ControlRequestContext,
    now: Date,
    rootId?: string
  ): Promise<AuthenticatedControlDevice>;
  login(passphrase: string, now: Date): Promise<ControlAdminLoginResult>;
  logout(): ControlAdminLogoutResult;
}

export interface ControlAuthDependencies {
  store: ControlPlaneStore;
  codec: SealedSessionCodec;
  householdId: string;
  passphrasePepper: string;
  csrfSecret: string;
  failedLoginDelayMs: number;
  createId?: (prefix: string) => string;
  monotonicNow?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function unauthorizedAdmin(): ControlAuthError {
  return new ControlAuthError(
    "ADMIN_UNAUTHORIZED",
    clearSessionCookie("admin")
  );
}

function unauthorizedDevice(): ControlAuthError {
  return new ControlAuthError(
    "DEVICE_UNAUTHORIZED",
    clearSessionCookie("device")
  );
}

function openAdmin(
  request: Request,
  codec: SealedSessionCodec
): AdminSessionClaims {
  const token = parseCookies(request).admin_session;
  if (!token) throw unauthorizedAdmin();
  try {
    return codec.openAdmin(token);
  } catch {
    throw unauthorizedAdmin();
  }
}

function openDevice(
  request: Request,
  codec: SealedSessionCodec
): DeviceSessionClaims {
  const token = parseCookies(request).device_session;
  if (!token) throw unauthorizedDevice();
  try {
    return codec.openDevice(token);
  } catch {
    throw unauthorizedDevice();
  }
}

export function authenticateControlAdmin(
  request: Request,
  context: ControlRequestContext,
  dependencies: Pick<ControlAuthDependencies, "codec" | "householdId" | "csrfSecret">,
  now: Date
): AuthenticatedControlAdmin {
  const claims = openAdmin(request, dependencies.codec);
  if (
    context.document.householdId !== dependencies.householdId ||
    context.revision !== context.document.revision ||
    claims.householdId !== dependencies.householdId ||
    claims.householdId !== context.document.householdId ||
    claims.expiresAt <= now.getTime() ||
    claims.adminPassphraseVersion !==
      context.document.household.adminPassphraseVersion
  ) {
    throw unauthorizedAdmin();
  }
  return {
    householdId: claims.householdId,
    sessionId: claims.sessionId,
    adminPassphraseVersion: claims.adminPassphraseVersion,
    csrfToken: csrfToken(claims.sessionId, dependencies.csrfSecret)
  };
}

export function authenticateControlDevice(
  request: Request,
  context: ControlRequestContext,
  dependencies: Pick<ControlAuthDependencies, "codec" | "householdId">,
  now: Date,
  rootId?: string
): AuthenticatedControlDevice {
  const claims = openDevice(request, dependencies.codec);
  const device = context.document.devices[claims.deviceId];
  if (
    context.document.householdId !== dependencies.householdId ||
    context.revision !== context.document.revision ||
    claims.householdId !== dependencies.householdId ||
    claims.householdId !== context.document.householdId ||
    claims.expiresAt <= now.getTime() ||
    !device ||
    !device.enabled ||
    device.revokedAt !== null ||
    claims.sessionVersion !== device.sessionVersion
  ) {
    throw unauthorizedDevice();
  }
  const root = rootId === undefined ? undefined : context.document.roots[rootId];
  if (
    rootId !== undefined &&
    (!root || !root.enabled || !device.assignedRootIds.includes(rootId))
  ) {
    throw unauthorizedDevice();
  }
  return {
    householdId: claims.householdId,
    deviceId: claims.deviceId,
    sessionVersion: claims.sessionVersion,
    device: structuredClone(device),
    ...(root === undefined ? {} : { root: structuredClone(root) }),
    context
  };
}

export function createControlAuth(
  dependencies: ControlAuthDependencies
): ControlAuth {
  const createId =
    dependencies.createId ??
    ((prefix: string) => `${prefix}-${crypto.randomUUID()}`);
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const wait =
    dependencies.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  async function login(
    passphrase: string,
    now: Date
  ): Promise<ControlAdminLoginResult> {
    const startedAt = monotonicNow();
    const { document } = await dependencies.store.load();
    if (document.householdId !== dependencies.householdId) {
      throw new ControlAuthError("INVALID_CREDENTIALS");
    }
    const valid = await verifyPassphrase(
      document.household.adminPassphraseHash,
      passphrase,
      dependencies.passphrasePepper
    );
    if (!valid) {
      const elapsed = Math.max(0, monotonicNow() - startedAt);
      const remaining = Math.max(0, dependencies.failedLoginDelayMs - elapsed);
      if (remaining > 0) await wait(remaining);
      throw new ControlAuthError("INVALID_CREDENTIALS");
    }
    const expiresAt = new Date(now.getTime() + CONTROL_SESSION_LIFETIME_MS);
    const sessionId = createId("admin-session");
    const cookie = dependencies.codec.issueAdmin({
      version: 2,
      householdId: dependencies.householdId,
      sessionId,
      adminPassphraseVersion: document.household.adminPassphraseVersion,
      issuedAt: now.getTime(),
      expiresAt: expiresAt.getTime()
    });
    return {
      authenticated: true,
      cookie,
      setCookie: createSessionCookie("admin", cookie, expiresAt),
      csrfToken: csrfToken(sessionId, dependencies.csrfSecret),
      expiresAt
    };
  }

  return {
    admin: async (request, context, now) =>
      authenticateControlAdmin(request, context, dependencies, now),
    device: async (request, context, now, rootId) =>
      authenticateControlDevice(request, context, dependencies, now, rootId),
    login,
    logout: () => ({
      authenticated: false,
      clearCookie: clearSessionCookie("admin")
    })
  };
}
