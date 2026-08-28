import type { ProviderKind } from "./contracts";

const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_PATH = "/o/oauth2/v2/auth";
const MICROSOFT_AUTHORIZATION_ORIGIN = "https://login.microsoftonline.com";
const MICROSOFT_TENANT_ALIASES = new Set(["common", "organizations", "consumers"]);
const CANONICAL_GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

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
  if (!match || !validMicrosoftTenant(match[1]!)) return false;
  return url.pathname === rawPath;
}

function validMicrosoftTenant(value: string): boolean {
  if (MICROSOFT_TENANT_ALIASES.has(value) || CANONICAL_GUID.test(value)) return true;
  if (value.length > 253 || !value.includes(".")) return false;
  const labels = value.split(".");
  return labels.every(label => label.length <= 63 && DNS_LABEL.test(label));
}

export function assertProviderAuthorizationUrl(provider: ProviderKind, value: string): string {
  if (!isProviderAuthorizationUrl(provider, value)) throw new Error("INVALID_PROVIDER_AUTHORIZATION_URL");
  return value;
}
