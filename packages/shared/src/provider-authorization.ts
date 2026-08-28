import type { ProviderKind } from "./contracts";

const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_PATH = "/o/oauth2/v2/auth";
const MICROSOFT_AUTHORIZATION_ORIGIN = "https://login.microsoftonline.com";
const SAFE_TENANT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

export function isProviderAuthorizationUrl(provider: ProviderKind, value: string): boolean {
  if (!value.startsWith("https://")) return false;
  const remainder = value.slice("https://".length);
  const pathStart = remainder.indexOf("/");
  if (pathStart < 0) return false;
  const authority = remainder.slice(0, pathStart);
  const rawPathAndQuery = remainder.slice(pathStart);
  const queryStart = rawPathAndQuery.search(/[?#]/);
  const rawPath = queryStart < 0 ? rawPathAndQuery : rawPathAndQuery.slice(0, queryStart);
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username !== "" || url.password !== "" || url.hash !== "" || url.port !== "") return false;
  if (provider === "google") return authority === "accounts.google.com" && rawPath === GOOGLE_AUTHORIZATION_PATH && url.origin === GOOGLE_AUTHORIZATION_ORIGIN && url.pathname === GOOGLE_AUTHORIZATION_PATH;
  if (authority !== "login.microsoftonline.com") return false;
  if (url.origin !== MICROSOFT_AUTHORIZATION_ORIGIN) return false;
  const match = /^\/([^/]+)\/oauth2\/v2\.0\/authorize$/.exec(rawPath);
  if (!match || !SAFE_TENANT.test(match[1]!)) return false;
  return match[1] !== "." && match[1] !== ".." && url.pathname === rawPath;
}

export function assertProviderAuthorizationUrl(provider: ProviderKind, value: string): string {
  if (!isProviderAuthorizationUrl(provider, value)) throw new Error("INVALID_PROVIDER_AUTHORIZATION_URL");
  return value;
}
