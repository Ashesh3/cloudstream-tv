export type SessionCookieKind = "admin" | "device" | "request";

const COOKIE_NAMES: Record<SessionCookieKind, string> = {
  admin: "admin_session",
  device: "device_session",
  request: "device_request"
};

function cookieAttributes(): string[] {
  return [
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ];
}

export function createSessionCookie(
  kind: SessionCookieKind,
  rawToken: string,
  expiresAt: Date
): string {
  return [
    `${COOKIE_NAMES[kind]}=${encodeURIComponent(rawToken)}`,
    `Expires=${expiresAt.toUTCString()}`,
    ...cookieAttributes()
  ].join("; ");
}

export function clearSessionCookie(kind: SessionCookieKind): string {
  return [
    `${COOKIE_NAMES[kind]}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...cookieAttributes()
  ].join("; ");
}
