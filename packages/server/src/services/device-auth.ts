import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import { hashOpaqueToken } from "../auth/tokens";
import type { ApiAppDependencies } from "../http/app";
import { HttpError } from "../http/errors";
import { parseCookies } from "../http/request";
import { SESSION_LIFETIME_MS } from "./admin-auth";

const RENEWAL_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export async function authenticateDevice(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
) {
  const raw = parseCookies(request).device_session;
  if (!raw) throw unauthorizedDevice();
  const result = await dependencies.repository.authenticateDeviceSession({
    tokenHash: hashOpaqueToken(raw),
    householdId: dependencies.config.householdId,
    now,
    renewBefore: new Date(now.getTime() + RENEWAL_THRESHOLD_MS),
    renewalExpiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS)
  });
  if (!result) throw unauthorizedDevice();
  const headers = new Headers();
  if (result.renewed) {
    headers.append(
      "set-cookie",
      createSessionCookie("device", raw, result.session.expiresAt)
    );
  }
  return { ...result, raw, responseHeaders: headers };
}

export function unauthorizedDevice(): HttpError {
  return new HttpError(
    401,
    "DEVICE_UNAUTHORIZED",
    "Device authentication is required.",
    undefined,
    { "set-cookie": clearSessionCookie("device") }
  );
}
