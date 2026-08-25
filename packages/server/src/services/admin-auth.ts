import { createHmac, timingSafeEqual } from "node:crypto";
import type { AdminSession } from "@cloudframe/shared";
import { clearSessionCookie, createSessionCookie } from "../auth/cookies";
import { hashOpaqueToken } from "../auth/tokens";
import type { ApiAppDependencies } from "../http/app";
import { HttpError } from "../http/errors";
import { parseCookies } from "../http/request";
import { ensureHousehold } from "./bootstrap";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SESSION_LIFETIME_MS = 365 * DAY_MS;
const RENEWAL_THRESHOLD_MS = 30 * DAY_MS;

export interface AuthenticatedAdmin {
  session: AdminSession;
  csrfToken: string;
  responseHeaders: Headers;
}

export async function authenticateAdmin(
  request: Request,
  dependencies: ApiAppDependencies,
  now: Date
): Promise<AuthenticatedAdmin> {
  const raw = parseCookies(request).admin_session;
  if (!raw) throw unauthorizedAdmin();
  const result = await dependencies.repository.authenticateAdminSession({
    tokenHash: hashOpaqueToken(raw),
    householdId: dependencies.config.householdId,
    now,
    renewBefore: new Date(now.getTime() + RENEWAL_THRESHOLD_MS),
    renewalExpiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS)
  });
  if (!result) throw unauthorizedAdmin();
  const headers = new Headers();
  if (result.renewed) {
    headers.append(
      "set-cookie",
      createSessionCookie("admin", raw, result.session.expiresAt)
    );
  }
  return {
    session: result.session,
    csrfToken: csrfToken(result.session.id, dependencies.config.csrfSecret),
    responseHeaders: headers
  };
}

export async function createAdminSession(
  dependencies: ApiAppDependencies,
  now: Date
): Promise<{ raw: string; session: AdminSession; csrfToken: string }> {
  const household = await ensureHousehold(dependencies, now);
  const token = (dependencies.issueToken ?? (() => {
    throw new Error("Token issuer missing");
  }))();
  const id = (dependencies.createId ?? (() => {
    throw new Error("ID issuer missing");
  }))("admin-session");
  const session: AdminSession = {
    id,
    householdId: household.id,
    tokenHash: token.hash,
    passphraseVersion: household.adminPassphraseVersion,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
    revokedAt: null
  };
  await dependencies.repository.putAdminSession(session);
  return {
    raw: token.raw,
    session,
    csrfToken: csrfToken(id, dependencies.config.csrfSecret)
  };
}

export function verifyAdminMutation(
  request: Request,
  authenticated: AuthenticatedAdmin,
  allowedOrigin: string
): void {
  if (
    request.headers.get("origin") !== allowedOrigin ||
    !constantTimeEqual(
      request.headers.get("x-csrf-token") ?? "",
      authenticated.csrfToken
    )
  ) {
    throw new HttpError(
      403,
      "ADMIN_MUTATION_FORBIDDEN",
      "The admin mutation could not be verified."
    );
  }
}

export function csrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`admin-csrf\u0000${sessionId}`)
    .digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function unauthorizedAdmin(): HttpError {
  return new HttpError(
    401,
    "ADMIN_UNAUTHORIZED",
    "Admin authentication is required.",
    undefined,
    { "set-cookie": clearSessionCookie("admin") }
  );
}
