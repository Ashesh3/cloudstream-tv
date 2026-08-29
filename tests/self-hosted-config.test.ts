import { describe, expect, it } from "vitest";
import { parseSelfHostedConfig } from "../packages/server/src/runtime/self-hosted-config";

describe("self-hosted configuration", () => {
  it("accepts one exact HTTPS origin and optional provider pairs", () => {
    expect(parseSelfHostedConfig({
      APP_ORIGIN: "https://tv.example.com",
      PORT: "8080",
      DATA_DIR: "/data",
      GOOGLE_CLIENT_ID: "google-id",
      GOOGLE_CLIENT_SECRET: "google-secret",
      TRANSCODE_CACHE_MAX_BYTES: "50GiB",
      TRANSCODE_CACHE_MIN_FREE_BYTES: "5GiB",
      TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS: "30",
    })).toMatchObject({
      appOrigin: "https://tv.example.com",
      port: 8080,
      dataDir: "/data",
      providers: {
        google: { clientId: "google-id", clientSecret: "google-secret" },
      },
      transcode: {
        cacheMaxBytes: 50 * 1024 ** 3,
        cacheMinFreeBytes: 5 * 1024 ** 3,
        firstSegmentTimeoutMs: 30_000,
      },
    });
  });

  it("applies portable defaults and accepts a complete OneDrive pair", () => {
    expect(parseSelfHostedConfig({
      APP_ORIGIN: "https://tv.example.com",
      ONEDRIVE_CLIENT_ID: "onedrive-id",
      ONEDRIVE_CLIENT_SECRET: "onedrive-secret",
    })).toEqual({
      appOrigin: "https://tv.example.com",
      port: 8080,
      dataDir: "/data",
      providers: {
        onedrive: {
          clientId: "onedrive-id",
          clientSecret: "onedrive-secret",
          tenant: "common",
        },
      },
      transcode: {
        cacheMaxBytes: 50 * 1024 ** 3,
        cacheMinFreeBytes: 5 * 1024 ** 3,
        firstSegmentTimeoutMs: 30_000,
        threads: "auto",
      },
      logLevel: "info",
    });
  });

  it.each([
    [{ APP_ORIGIN: "http://tv.example.com" }, "APP_ORIGIN_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com/path" }, "APP_ORIGIN_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com", GOOGLE_CLIENT_ID: "id" }, "GOOGLE_OAUTH_CONFIG_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com", ONEDRIVE_CLIENT_SECRET: "secret" }, "ONEDRIVE_OAUTH_CONFIG_INVALID"],
    [{ APP_ORIGIN: "https://tv.example.com", TRANSCODE_CACHE_MAX_BYTES: "4GiB", TRANSCODE_CACHE_MIN_FREE_BYTES: "5GiB" }, "TRANSCODE_CACHE_LIMIT_INVALID"],
  ])("rejects invalid deployment input %#", (environment, code) => {
    expect(() => parseSelfHostedConfig(environment)).toThrow(code);
  });

  it.each([
    ["PORT", "0", "PORT_INVALID"],
    ["PORT", "8080.5", "PORT_INVALID"],
    ["TRANSCODE_CACHE_MAX_BYTES", "50GB", "TRANSCODE_CACHE_MAX_BYTES_INVALID"],
    ["TRANSCODE_CACHE_MIN_FREE_BYTES", "0GiB", "TRANSCODE_CACHE_MIN_FREE_BYTES_INVALID"],
    ["TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS", "0", "TRANSCODE_FIRST_SEGMENT_TIMEOUT_SECONDS_INVALID"],
    ["TRANSCODE_THREADS", "0", "TRANSCODE_THREADS_INVALID"],
    ["LOG_LEVEL", "verbose", "LOG_LEVEL_INVALID"],
  ])("rejects invalid %s values", (name, value, code) => {
    expect(() => parseSelfHostedConfig({
      APP_ORIGIN: "https://tv.example.com",
      [name]: value,
    })).toThrow(code);
  });
});
