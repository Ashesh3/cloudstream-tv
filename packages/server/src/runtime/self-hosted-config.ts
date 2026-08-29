import type { ProviderKind } from "@cloudframe/shared";

const BYTE_VALUE = /^(\d+)(KiB|MiB|GiB)$/;
const LOG_LEVELS = new Set<SelfHostedConfig["logLevel"]>([
  "debug",
  "info",
  "warn",
  "error",
]);

export interface SelfHostedConfig {
  appOrigin: string;
  port: number;
  dataDir: string;
  providers: {
    google?: { clientId: string; clientSecret: string };
    onedrive?: { clientId: string; clientSecret: string; tenant: string };
  };
  transcode: {
    cacheMaxBytes: number;
    cacheMinFreeBytes: number;
    firstSegmentTimeoutMs: number;
    threads: number | "auto";
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

export function parseSelfHostedConfig(
  environment: NodeJS.ProcessEnv,
): SelfHostedConfig {
  const appOrigin = exactHttpsOrigin(environment.APP_ORIGIN);
  const port = positiveInteger(environment.PORT ?? "8080", "PORT_INVALID");
  if (port > 65_535) throw new Error("PORT_INVALID");

  const dataDir = exactNonEmpty(environment.DATA_DIR ?? "/data", "DATA_DIR_INVALID");
  const cacheMaxBytes = byteCount(
    environment.TRANSCODE_CACHE_MAX_BYTES ?? "50GiB",
    "TRANSCODE_CACHE_MAX_BYTES_INVALID",
  );
  const cacheMinFreeBytes = byteCount(
    environment.TRANSCODE_CACHE_MIN_FREE_BYTES ?? "5GiB",
    "TRANSCODE_CACHE_MIN_FREE_BYTES_INVALID",
  );
  if (cacheMaxBytes <= cacheMinFreeBytes) {
    throw new Error("TRANSCODE_CACHE_LIMIT_INVALID");
  }

  const firstSegmentTimeoutSeconds = positiveInteger(
    environment.TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS ?? "30",
    "TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS_INVALID",
  );
  const firstSegmentTimeoutMs = firstSegmentTimeoutSeconds * 1_000;
  if (!Number.isSafeInteger(firstSegmentTimeoutMs)) {
    throw new Error("TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS_INVALID");
  }

  const threads = parseThreads(environment.TRANSCODE_THREADS ?? "auto");
  const logLevel = environment.LOG_LEVEL ?? "info";
  if (!LOG_LEVELS.has(logLevel as SelfHostedConfig["logLevel"])) {
    throw new Error("LOG_LEVEL_INVALID");
  }

  return {
    appOrigin,
    port,
    dataDir,
    providers: parseProviders(environment),
    transcode: {
      cacheMaxBytes,
      cacheMinFreeBytes,
      firstSegmentTimeoutMs,
      threads,
    },
    logLevel: logLevel as SelfHostedConfig["logLevel"],
  };
}

function parseProviders(
  environment: NodeJS.ProcessEnv,
): SelfHostedConfig["providers"] {
  const providers: SelfHostedConfig["providers"] = {};
  const google = providerPair(environment, "google");
  if (google) providers.google = google;

  const onedrive = providerPair(environment, "onedrive");
  const tenant = optionalExact(environment.ONEDRIVE_TENANT);
  if (!onedrive && tenant !== undefined) {
    throw new Error("ONEDRIVE_OAUTH_CONFIG_INVALID");
  }
  if (onedrive) {
    providers.onedrive = {
      ...onedrive,
      tenant: tenant ?? "common",
    };
  }

  return providers;
}

function providerPair(
  environment: NodeJS.ProcessEnv,
  provider: ProviderKind,
): { clientId: string; clientSecret: string } | undefined {
  const prefix = provider === "google" ? "GOOGLE" : "ONEDRIVE";
  const code = `${prefix}_OAUTH_CONFIG_INVALID`;
  const clientId = optionalExact(environment[`${prefix}_CLIENT_ID`], code);
  const clientSecret = optionalExact(environment[`${prefix}_CLIENT_SECRET`], code);
  if ((clientId === undefined) !== (clientSecret === undefined)) {
    throw new Error(code);
  }
  return clientId === undefined || clientSecret === undefined
    ? undefined
    : { clientId, clientSecret };
}

function exactHttpsOrigin(value: string | undefined): string {
  try {
    if (!value || value !== value.trim()) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) throw new Error();
    return url.origin;
  } catch {
    throw new Error("APP_ORIGIN_INVALID");
  }
}

function byteCount(value: string, code: string): number {
  const match = BYTE_VALUE.exec(value);
  if (!match) throw new Error(code);
  const amount = Number(match[1]);
  const multiplier = match[2] === "KiB"
    ? 1024
    : match[2] === "MiB"
      ? 1024 ** 2
      : 1024 ** 3;
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(code);
  return bytes;
}

function positiveInteger(value: string, code: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(code);
  return parsed;
}

function parseThreads(value: string): number | "auto" {
  return value === "auto"
    ? value
    : positiveInteger(value, "TRANSCODE_THREADS_INVALID");
}

function exactNonEmpty(value: string, code: string): string {
  if (!value || value !== value.trim()) throw new Error(code);
  return value;
}

function optionalExact(value: string | undefined, code = "ONEDRIVE_OAUTH_CONFIG_INVALID"):
  string | undefined {
  if (value === undefined || value === "") return undefined;
  return exactNonEmpty(value, code);
}
