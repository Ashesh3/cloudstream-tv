export type SessionCookieKind = "admin" | "device" | "request";

const COOKIE_NAMES: Record<SessionCookieKind, string> = {
  admin: "admin_session",
  device: "device_session",
  request: "device_request"
};

function cookieAttributes(kind: SessionCookieKind): string[] {
  return [
    "Path=/",
    "HttpOnly",
    "Secure",
    `SameSite=${kind === "admin" ? "Lax" : "Strict"}`
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
    ...cookieAttributes(kind)
  ].join("; ");
}

export function clearSessionCookie(kind: SessionCookieKind): string {
  return [
    `${COOKIE_NAMES[kind]}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...cookieAttributes(kind)
  ].join("; ");
}
