import { describe, expect, it } from "vitest";
import {
  ProviderError,
  type AuthenticatedMediaRequest,
  type ProviderAdapter,
  type ProviderKind,
  type ProviderRegistry,
  type TemporaryUrl,
} from "@cloudframe/providers";
import {
  LiveBrowseError,
  ProviderMediaSourceError,
  createProviderMediaSourceService,
  type AuthorizedBrowseItem,
  type BrokeredProviderCredentials,
  type CredentialBroker,
} from "@cloudframe/server";
import { TEST_NOW, testControlDocument } from "./helpers/control-plane";

const expiresAt = new Date(TEST_NOW.getTime() + 45 * 60_000);

function item(provider: ProviderKind): AuthorizedBrowseItem {
  const document = testControlDocument();
  const source = {
    ...document.sources["source-1"]!,
    id: `source-${provider}`,
    provider,
  };
  const root = {
    ...document.roots["root-1"]!,
    id: `root-${provider}`,
    sourceId: source.id,
    providerNodeId: `${provider}-root`,
  };
  return {
    id: `item-${provider}`,
    source,
    root,
    claims: {
      version: 2,
      householdId: document.householdId,
      deviceId: "device-1",
      sourceId: source.id,
      rootId: root.id,
      rootProviderNodeId: root.providerNodeId,
      providerNodeId: `${provider}-video`,
      parentProviderNodeId: root.providerNodeId,
      kind: "video",
      name: "Clip.mpg",
      mimeType: "video/mpeg",
      size: 12_345,
      contentRevision: "provider-revision-7",
      preview: null,
      credentialVersion: 1,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000,
    },
  };
}

function credential(token: string, version = 1): BrokeredProviderCredentials {
  return {
    accessToken: token,
    refreshToken: null,
    accessTokenExpiresAt: expiresAt,
    credentialVersion: version,
  };
}

function service(
  provider: ProviderKind,
  results: Array<TemporaryUrl | AuthenticatedMediaRequest | Error>,
  refreshVersion = 1,
) {
  const calls: string[] = [];
  const refreshes: string[] = [];
  const adapter: ProviderAdapter = {
    beginAuthorization: async () => unexpected(),
    completeAuthorization: async () => unexpected(),
    refreshCredentials: async () => unexpected(),
    getRoot: async () => unexpected(),
    getNode: async () => unexpected(),
    listFolder: async () => unexpected(),
    getThumbnailUrl: async () => unexpected(),
    async getMediaUrl(input) {
      calls.push(input.credentials.accessToken);
      const result = results.shift();
      if (result instanceof Error) throw result;
      if (!result) throw new Error("missing result");
      return result;
    },
  };
  const providers: ProviderRegistry = { get: () => adapter };
  const broker: CredentialBroker = {
    async get(sourceId) {
      calls.push(`get:${sourceId}`);
      return credential("access-token");
    },
    async refresh(sourceId) {
      refreshes.push(sourceId);
      return credential("refreshed-access", refreshVersion);
    },
  };
  return {
    calls,
    refreshes,
    resolver: createProviderMediaSourceService({
      credentialBroker: broker,
      providers,
      now: () => TEST_NOW,
    }),
  };
}

describe("validated provider media sources", () => {
  it("returns the exact Google media request, bearer header, and credential version", async () => {
    const current = item("google");
    const harness = service("google", [{
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      headers: { authorization: "Bearer access-token" },
      expiresAt,
    }, {
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      headers: { authorization: "Bearer refreshed-access" },
      expiresAt,
    }]);

    const result = await harness.resolver.resolve(current);
    expect(result).toMatchObject({
      item: current,
      provider: "google",
      credentialVersion: 1,
      request: {
        url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
        expiresAt,
      },
    });
    expect([...result.request.headers]).toEqual([["authorization", "Bearer access-token"]]);
    result.request.headers.set("authorization", "mutated");
    expect((await harness.resolver.resolve(current, { refresh: true })).request.headers.get("authorization"))
      .not.toBe("mutated");
  });

  it.each([
    "https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=capability",
    "https://public.dm.files.1drv.com/y4m/file?authkey=capability",
    "https://storage.live.com/items/file?authkey=capability",
    "https://res.cdn.microsoftusercontent.com/download/file?token=capability",
  ])("accepts an allowlisted OneDrive URL %s with no forwarded headers", async (url) => {
    const harness = service("onedrive", [{ url, expiresAt }]);
    const result = await harness.resolver.resolve(item("onedrive"));
    expect(result.request.url).toBe(url);
    expect([...result.request.headers]).toEqual([]);
  });

  it.each([
    "javascript:alert(1)",
    "https://user:pass@storage.live.com/items/file?authkey=capability",
    "https://storage.live.com:8443/items/file?authkey=capability",
    "https://storage.live.com/items/file?authkey=capability#fragment",
    "https://attacker.example/file?token=capability",
    "https://storage.live.com/",
    "https://tenant.sharepoint.com/personal/%2e%2e/user/_layouts/15/download.aspx?token=capability",
  ])("rejects attacker-shaped provider URL %s", async (url) => {
    const harness = service("onedrive", [{ url, expiresAt }]);
    await expect(harness.resolver.resolve(item("onedrive")))
      .rejects.toEqual(new ProviderMediaSourceError("INVALID_PROVIDER_URL"));
  });

  it("rejects extra Google headers and query credentials", async () => {
    const harness = service("google", [{
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true&access_token=secret",
      headers: { authorization: "Bearer access-token", "x-extra": "value" },
      expiresAt,
    }]);
    await expect(harness.resolver.resolve(item("google")))
      .rejects.toEqual(new ProviderMediaSourceError("INVALID_PROVIDER_URL"));
  });

  it("refreshes once for a non-invalid-grant rejection and never twice", async () => {
    const reauth = new ProviderError("PROVIDER_REAUTH_REQUIRED", "private", { retryable: false });
    const harness = service("google", [reauth, {
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      headers: { authorization: "Bearer refreshed-access" },
      expiresAt,
    }]);
    await expect(harness.resolver.resolve(item("google"))).resolves.toMatchObject({ credentialVersion: 1 });
    expect(harness.refreshes).toHaveLength(1);

    const twice = service("google", [reauth, reauth]);
    await expect(twice.resolver.resolve(item("google"))).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(twice.refreshes).toHaveLength(1);
  });

  it("forces one refresh and rejects a new credential generation as expired navigation", async () => {
    const harness = service("google", [{
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      headers: { authorization: "Bearer refreshed-access" },
      expiresAt,
    }], 2);

    await expect(harness.resolver.resolve(item("google"), { refresh: true }))
      .rejects.toEqual(new LiveBrowseError("NAVIGATION_EXPIRED"));
    expect(harness.refreshes).toHaveLength(1);
  });
});

function unexpected(): never {
  throw new Error("unexpected provider operation");
}
