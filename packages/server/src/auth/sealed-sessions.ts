import type { ProviderKind } from "@cloudframe/shared";

import {
  SealedValueError,
  openJson,
  sealJson,
  type VersionedAeadKeyring
} from "../crypto/aead";

const ADMIN_PURPOSE = "cloudframe/admin-session/v2";
const DEVICE_PURPOSE = "cloudframe/device-session/v2";
const REQUEST_PURPOSE = "cloudframe/device-request/v2";
const OAUTH_PURPOSE = "cloudframe/oauth-state/v2";

export interface AdminSessionClaims {
  version: 2;
  householdId: string;
  sessionId: string;
  adminPassphraseVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface DeviceSessionClaims {
  version: 2;
  householdId: string;
  deviceId: string;
  sessionVersion: number;
  issuedAt: number;
  expiresAt: number;
}

export interface DeviceRequestClaims {
  version: 2;
  householdId: string;
  requestId: string;
  requestSecret: string;
  issuedAt: number;
  expiresAt: number;
}

export interface OAuthStateClaims {
  version: 2;
  householdId: string;
  adminSessionId: string;
  provider: ProviderKind;
  redirectUri: string;
  reconnectSourceId?: string;
  pkceVerifier: string;
  stateHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface SealedSessionCodec {
  issueAdmin(claims: AdminSessionClaims): string;
  openAdmin(token: string): AdminSessionClaims;
  issueDevice(claims: DeviceSessionClaims): string;
  openDevice(token: string): DeviceSessionClaims;
  issueRequest(claims: DeviceRequestClaims): string;
  openRequest(token: string): DeviceRequestClaims;
  issueOAuthState(claims: OAuthStateClaims): string;
  openOAuthState(token: string): OAuthStateClaims;
}

type UnknownRecord = Record<string, unknown>;

function fail(): never {
  throw new SealedValueError("SEALED_VALUE_INVALID");
}

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail();
  }
  return value as UnknownRecord;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail();
  }
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) {
    fail();
  }
  return value as number;
}

function positiveInteger(value: unknown): number {
  const parsed = integer(value);
  if (parsed < 1) {
    fail();
  }
  return parsed;
}

function common(value: UnknownRecord, now: Date) {
  if (value.version !== 2) {
    fail();
  }
  const issuedAt = integer(value.issuedAt);
  const expiresAt = integer(value.expiresAt);
  if (expiresAt <= now.getTime()) {
    fail();
  }
  return {
    version: 2 as const,
    householdId: string(value.householdId),
    issuedAt,
    expiresAt
  };
}

function parseAdmin(value: unknown, now: Date): AdminSessionClaims {
  const input = record(value);
  return {
    ...common(input, now),
    sessionId: string(input.sessionId),
    adminPassphraseVersion: positiveInteger(input.adminPassphraseVersion)
  };
}

function parseDevice(value: unknown, now: Date): DeviceSessionClaims {
  const input = record(value);
  return {
    ...common(input, now),
    deviceId: string(input.deviceId),
    sessionVersion: positiveInteger(input.sessionVersion)
  };
}

function parseRequest(value: unknown, now: Date): DeviceRequestClaims {
  const input = record(value);
  return {
    ...common(input, now),
    requestId: string(input.requestId),
    requestSecret: string(input.requestSecret)
  };
}

function parseOAuth(value: unknown, now: Date): OAuthStateClaims {
  const input = record(value);
  const provider = input.provider;
  if (provider !== "google" && provider !== "onedrive") {
    fail();
  }

  const reconnectSourceId = input.reconnectSourceId;
  if (reconnectSourceId !== undefined && (typeof reconnectSourceId !== "string" || reconnectSourceId.length === 0)) {
    fail();
  }

  return {
    ...common(input, now),
    adminSessionId: string(input.adminSessionId),
    provider,
    redirectUri: string(input.redirectUri),
    ...(reconnectSourceId === undefined ? {} : { reconnectSourceId }),
    pkceVerifier: string(input.pkceVerifier),
    stateHash: string(input.stateHash)
  };
}

export function createSealedSessionCodec(
  keyring: VersionedAeadKeyring,
  now: () => Date = () => new Date()
): SealedSessionCodec {
  const issue = <T>(purpose: string, claims: T, parse: (value: unknown, date: Date) => T) =>
    sealJson(purpose, parse(claims, now()), keyring);
  const open = <T>(purpose: string, token: string, parse: (value: unknown, date: Date) => T) =>
    openJson(purpose, token, keyring.keys, (value) => parse(value, now()));

  return {
    issueAdmin: (claims) => issue(ADMIN_PURPOSE, claims, parseAdmin),
    openAdmin: (token) => open(ADMIN_PURPOSE, token, parseAdmin),
    issueDevice: (claims) => issue(DEVICE_PURPOSE, claims, parseDevice),
    openDevice: (token) => open(DEVICE_PURPOSE, token, parseDevice),
    issueRequest: (claims) => issue(REQUEST_PURPOSE, claims, parseRequest),
    openRequest: (token) => open(REQUEST_PURPOSE, token, parseRequest),
    issueOAuthState: (claims) => issue(OAUTH_PURPOSE, claims, parseOAuth),
    openOAuthState: (token) => open(OAUTH_PURPOSE, token, parseOAuth)
  };
}
