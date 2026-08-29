import { readFileSync } from "node:fs";

import {
  ProviderError,
  createGoogleDriveAdapter,
  createOneDriveAdapter,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderKind
} from "@cloudframe/providers";
import { describe, expect, it, vi } from "vitest";

const now = new Date("2026-08-26T00:00:00.000Z");
const accessExpiresAt = new Date("2026-08-26T00:45:00.000Z");
const credentials: ProviderCredentials = {
  accessToken: "synthetic-access-token",
  refreshToken: "synthetic-refresh-token",
  accessTokenExpiresAt: accessExpiresAt
};

function fixture(provider: ProviderKind, name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/${provider === "google" ? "google" : "onedrive"}/${name}.json`, import.meta.url),
      "utf8"
    )
  );
}

function inputUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
}

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

interface ContractHarness {
  provider: ProviderKind;
  adapter: ProviderAdapter;
  requests: Array<{ url: URL; init: RequestInit | undefined }>;
}

function createHarness(provider: ProviderKind): ContractHarness {
  const requests: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = inputUrl(input);
    requests.push({ url, init });

    if (provider === "google") {
      if (url.pathname.endsWith("/files/root")) return jsonResponse({
        id: "g-root-actual",
        name: "My Drive",
        mimeType: "application/vnd.google-apps.folder"
      });
      if (url.pathname.endsWith("/files/g-folder-a")) return jsonResponse({
        id: "g-folder-a",
        name: "Albums",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["g-root-actual"]
      });
      if (url.pathname.endsWith("/files")) return jsonResponse(fixture(provider, "folder-page"));
      if (url.pathname.endsWith("/g-image-a")) {
        return jsonResponse({
          id: "g-image-a",
          mimeType: "image/jpeg",
          thumbnailLink: "https://lh3.googleusercontent.com/synthetic-google-thumb=s220",
          version: "12"
        });
      }
      if (url.pathname.endsWith("/g-video-a")) {
        return jsonResponse({
          id: "g-video-a",
          mimeType: "video/mp4",
          thumbnailLink:
            "https://lh3.googleusercontent.com/u/0/d/synthetic-video-thumb=s220",
          version: "13"
        });
      }
      if (url.pathname.endsWith("/g-image-bad-thumbnail")) {
        return jsonResponse({
          id: "g-image-bad-thumbnail",
          mimeType: "image/jpeg",
          thumbnailLink: "https://lh3.googleusercontent.com/synthetic-google-thumb",
          version: "14"
        });
      }
    } else {
      if (url.pathname.endsWith("/drive/root")) return jsonResponse({
        id: "o-root-actual",
        name: "OneDrive",
        folder: { childCount: 4 }
      });
      if (url.pathname.endsWith("/items/o-folder-a")) return jsonResponse({
        id: "o-folder-a",
        name: "Albums",
        parentReference: { id: "o-root-actual" },
        folder: { childCount: 0 }
      });
      if (url.pathname.endsWith("/children")) return jsonResponse(fixture(provider, "folder-page"));
      if (url.pathname.endsWith("/thumbnails/0/c720x720")) {
        return jsonResponse({
          url: "https://public.dm.files.1drv.com/y4m/thumbnail?authkey=synthetic-capability"
        });
      }
      if (url.pathname.endsWith("/o-image-a")) {
        return jsonResponse({
          id: "o-image-a",
          "@microsoft.graph.downloadUrl":
            "https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=synthetic-capability"
        });
      }
    }

    return jsonResponse({ error: "unexpected synthetic request" }, 500);
  };

  return {
    provider,
    requests,
    adapter:
      provider === "google"
        ? createGoogleDriveAdapter({
            clientId: "synthetic-google-client",
            clientSecret: "synthetic-google-secret",
            fetch,
            now: () => now
          })
        : createOneDriveAdapter({
            clientId: "synthetic-microsoft-client",
            clientSecret: "synthetic-microsoft-secret",
            tenant: "common",
            fetch,
            now: () => now
          })
  };
}

describe.each(["google", "onedrive"] as const)("%s provider adapter contract", provider => {
  it("exposes only the live browse and direct URL operations", () => {
    const { adapter } = createHarness(provider);

    expect(Object.keys(adapter).sort()).toEqual([
      "beginAuthorization",
      "completeAuthorization",
      "getMediaUrl",
      "getNode",
      "getRoot",
      "getThumbnailUrl",
      "listFolder",
      "refreshCredentials"
    ]);
  });

  it("uses read-only authorization scopes and PKCE without embedding credentials", async () => {
    const { adapter } = createHarness(provider);
    const start = await adapter.beginAuthorization({
      state: "synthetic-state",
      redirectUri: "https://app.synthetic.invalid/api/admin/oauth/callback",
      codeChallenge: "synthetic-code-challenge"
    });
    const url = new URL(start.authorizationUrl);

    expect(url.searchParams.get("state")).toBe("synthetic-state");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.synthetic.invalid/api/admin/oauth/callback"
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("synthetic-code-challenge");
    expect(url.searchParams.get("scope")).toContain(
      provider === "google" ? "drive.readonly" : "Files.Read"
    );
    if (provider === "onedrive") {
      expect(url.searchParams.get("scope")).toContain("User.Read");
    }
    expect(start.authorizationUrl).not.toContain("synthetic-google-secret");
    expect(start.authorizationUrl).not.toContain("synthetic-microsoft-secret");
    if (provider === "google") {
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("consent");
      expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    }
  });

  it("normalizes only folders, images, and videos with pagination", async () => {
    const { adapter } = createHarness(provider);
    const page = await adapter.listFolder({
      credentials,
      folderId: provider === "google" ? "g-root" : "o-root",
      cursor: null,
      pageSize: 50
    });

    expect(page.items).toHaveLength(3);
    expect(page.items.map(item => item.kind)).toEqual(["folder", "image", "video"]);
    expect(page.items[0]).toMatchObject({
      name: "Albums",
      parentProviderId: provider === "google" ? "g-root" : "o-root",
      kind: "folder",
      hasPreview: provider === "onedrive",
      preview: provider === "onedrive"
        ? {
            url: "https://public.dm.files.1drv.com/y4m/folder?authkey=folder-capability",
            expiresAt: new Date("2026-08-26T00:50:00.000Z")
          }
        : null
    });
    expect(page.items[1]).toMatchObject({
      name: "Beach.jpg",
      mimeType: "image/jpeg",
      size: 1234,
      width: 1920,
      height: 1080,
      capturedAt: new Date("2024-03-01T02:03:04.000Z"),
      hasPreview: true,
      preview: provider === "google"
        ? {
            url: "https://lh3.googleusercontent.com/google-thumb=s720",
            expiresAt: accessExpiresAt
          }
        : {
            url: "https://public.dm.files.1drv.com/y4m/image?authkey=image-capability",
            expiresAt: new Date("2026-08-26T00:50:00.000Z")
          }
    });
    expect(page.items[2]).toMatchObject({
      name: "Clip.mp4",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      createdAt: null,
      hasPreview: true,
      preview: provider === "google"
        ? {
            url: "https://lh4.googleusercontent.com/google-video-thumb=s720",
            expiresAt: accessExpiresAt
          }
        : {
            url: "https://public.storage.live.com/items/video?authkey=video-capability",
            expiresAt: new Date("2026-08-26T00:50:00.000Z")
          }
    });
    expect(page.nextCursor).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain(credentials.accessToken);
  });

  it("resolves the provider's actual root folder identity", async () => {
    const { adapter, requests } = createHarness(provider);
    const root = await adapter.getRoot(credentials);

    expect(root).toMatchObject({
      providerNodeId: provider === "google" ? "g-root-actual" : "o-root-actual",
      parentProviderId: null,
      kind: "folder",
      name: provider === "google" ? "My Drive" : "OneDrive"
    });
    expect(requests.at(-1)?.url.pathname).toBe(
      provider === "google"
        ? "/drive/v3/files/root"
        : "/v1.0/me/drive/root"
    );
  });

  it("resolves one exact provider folder for trusted ancestry checks", async () => {
    const { adapter, requests } = createHarness(provider);
    const node = await adapter.getNode({
      credentials,
      providerNodeId: provider === "google" ? "g-folder-a" : "o-folder-a"
    });

    expect(node).toMatchObject({
      providerNodeId: provider === "google" ? "g-folder-a" : "o-folder-a",
      parentProviderId: provider === "google" ? "g-root-actual" : "o-root-actual",
      name: "Albums",
      kind: "folder"
    });
    expect(requests.at(-1)?.url.pathname).toContain(
      provider === "google" ? "/drive/v3/files/g-folder-a" : "/v1.0/me/drive/items/o-folder-a"
    );
  });

  it("returns direct temporary thumbnail and media URLs without proxying bytes", async () => {
    const { adapter, requests } = createHarness(provider);
    const providerNodeId = provider === "google" ? "g-image-a" : "o-image-a";
    const thumbnail = await adapter.getThumbnailUrl({
      credentials,
      providerNodeId,
      maxDimension: 720
    });
    const media = await adapter.getMediaUrl({ credentials, providerNodeId });

    expect(thumbnail?.url).toContain(
      provider === "google" ? "googleusercontent.com" : "files.1drv.com"
    );
    expect(thumbnail?.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(media.url.includes("sharepoint.com") || media.url.includes("googleapis.com")).toBe(true);
    expect(media.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    if (provider === "google") {
      expect(thumbnail?.url).toBe(
        "https://lh3.googleusercontent.com/synthetic-google-thumb=s720"
      );
      expect(thumbnail?.expiresAt).toEqual(accessExpiresAt);
      expect(media.url).toBe(
        "https://www.googleapis.com/drive/v3/files/g-image-a?alt=media&supportsAllDrives=true"
      );
      expect(new Headers("headers" in media ? media.headers : undefined).get("authorization"))
        .toBe("Bearer synthetic-access-token");
      expect(media.expiresAt).toEqual(accessExpiresAt);
    } else {
      expect(thumbnail?.url).toBe(
        "https://public.dm.files.1drv.com/y4m/thumbnail?authkey=synthetic-capability"
      );
      expect(media.url).toBe(
        "https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=synthetic-capability"
      );
    }
    expect(requests.every(request => !request.url.pathname.includes("/api/"))).toBe(true);
    expect(requests.every(request => !request.url.searchParams.has("access_token"))).toBe(true);
    expect(requests.every(request => new Headers(request.init?.headers).get("range") === null)).toBe(true);
  });

  if (provider === "google") {
    it("uses the bounded live-list query and Shared Drive flags", async () => {
      const { adapter, requests } = createHarness(provider);
      await adapter.listFolder({
        credentials,
        folderId: "g-root",
        cursor: null,
        pageSize: 50
      });
      await adapter.getThumbnailUrl({
        credentials,
        providerNodeId: "g-image-a",
        maxDimension: 720
      });
      const media = await adapter.getMediaUrl({
        credentials,
        providerNodeId: "g-image-a"
      });

      const list = requests.find(request => request.url.pathname.endsWith("/files"))!.url;
      const thumbnail = requests.find(request => request.url.pathname.endsWith("/g-image-a"))!.url;
      expect(list.searchParams.get("q")).toBe("'g-root' in parents and trashed=false");
      expect(list.searchParams.get("pageSize")).toBe("50");
      expect(list.searchParams.get("supportsAllDrives")).toBe("true");
      expect(list.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(list.searchParams.get("fields")).toContain("nextPageToken,files(");
      expect(thumbnail.searchParams.get("supportsAllDrives")).toBe("true");
      expect(new URL(media.url).searchParams.get("supportsAllDrives")).toBe("true");
      expect(new URL(media.url).searchParams.has("access_token")).toBe(false);
      expect(requests.some(request => request.url.searchParams.get("alt") === "media")).toBe(false);
    });

    it("returns a resized Google CDN thumbnail URL for video metadata", async () => {
      const { adapter, requests } = createHarness(provider);

      await expect(adapter.getThumbnailUrl({
        credentials,
        providerNodeId: "g-video-a",
        maxDimension: 720
      })).resolves.toMatchObject({
        url: "https://lh3.googleusercontent.com/u/0/d/synthetic-video-thumb=s720",
        expiresAt: accessExpiresAt
      });

      expect(requests).toHaveLength(1);
      expect(requests[0].url.searchParams.get("fields")).toBe("mimeType,thumbnailLink");
      expect(requests[0].url.searchParams.get("alt")).toBeNull();
      expect(new Headers(requests[0].init?.headers).get("range")).toBeNull();
    });

    it("rejects a Google thumbnail link without a terminal size directive", async () => {
      const { adapter } = createHarness(provider);

      await expect(adapter.getThumbnailUrl({
        credentials,
        providerNodeId: "g-image-bad-thumbnail",
        maxDimension: 720
      })).rejects.toMatchObject({ code: "PROVIDER_BAD_RESPONSE" });
    });
  } else {
    it("uses only live metadata fields and a thumbnail expansion for folder pages", async () => {
      const { adapter, requests } = createHarness(provider);

      await adapter.listFolder({
        credentials,
        folderId: "o-root",
        cursor: null,
        pageSize: 50
      });

      const list = requests.at(-1)!.url;
      expect(list.searchParams.get("$top")).toBe("50");
      expect(list.searchParams.get("$expand")).toBe("thumbnails($select=large)");
      expect(list.searchParams.get("$select")).toBe(
        "id,name,parentReference,folder,file,image,video,size,createdDateTime,lastModifiedDateTime,photo,eTag"
      );
      expect(list.searchParams.get("$select")).not.toContain("downloadUrl");
    });

    it("requests only the preauthorized media URL metadata", async () => {
      const { adapter, requests } = createHarness(provider);

      await adapter.getMediaUrl({ credentials, providerNodeId: "o-image-a" });

      const mediaMetadata = requests.at(-1)!;
      expect(mediaMetadata.url.searchParams.get("$select")).toBe("@microsoft.graph.downloadUrl");
      expect(new Headers(mediaMetadata.init?.headers).get("range")).toBeNull();
    });
  }
});

describe("provider failure normalization", () => {
  it("normalizes HTTP 404 as a secret-safe provider-not-found error", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      jsonResponse({ error: { message: "synthetic private upstream payload" } }, 404);
    const adapter = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch,
      now: () => now
    });

    const error = await adapter
      .getNode({ credentials, providerNodeId: "missing-folder" })
      .catch(value => value);

    expect(error).toMatchObject({ code: "PROVIDER_NOT_FOUND", retryable: false });
    expect(String(error)).not.toContain("private upstream payload");
  });

  it.each([429, 503])("normalizes HTTP %s with retry metadata and no payload leak", async status => {
    const fetch: typeof globalThis.fetch = async () =>
      jsonResponse({ error: { message: "synthetic private upstream payload" } }, status, {
        "retry-after": "17"
      });
    const adapter = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch,
      now: () => now
    });

    const error = await adapter
      .listFolder({ credentials, folderId: "g-root", cursor: null, pageSize: 10 })
      .catch(value => value);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: status === 429 ? "PROVIDER_THROTTLED" : "PROVIDER_UNAVAILABLE",
      retryable: true,
      retryAfterSeconds: 17
    });
    expect(String(error)).not.toContain("private upstream payload");
  });

  it("uses the injected clock for HTTP-date retry metadata", async () => {
    const retryAt = new Date(now.getTime() + 17 * 1000).toUTCString();
    const fetch: typeof globalThis.fetch = async () =>
      jsonResponse({}, 503, { "retry-after": retryAt });
    const adapter = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch,
      now: () => now
    });

    await expect(
      adapter.listFolder({ credentials, folderId: "g-root", cursor: null, pageSize: 10 })
    ).rejects.toMatchObject({ retryAfterSeconds: 17 });
  });

  it("normalizes invalid grants to reauthentication required", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      jsonResponse({ error: "invalid_grant", error_description: "synthetic private reason" }, 400);
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });

    await expect(
      adapter.refreshCredentials({ id: "source-a", provider: "onedrive", credentials })
    ).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      retryable: false,
      reauthReason: "invalid_grant"
    });
  });

  it("normalizes generic HTTP 401 without marking a definitive invalid grant", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        { error: { message: "synthetic private upstream payload" } },
        401
      );
    const adapter = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch,
      now: () => now
    });

    const error = await adapter
      .listFolder({ credentials, folderId: "g-root", cursor: null, pageSize: 10 })
      .catch(value => value);

    expect(error).toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      retryable: false,
      reauthReason: null
    });
    expect(String(error)).not.toContain("private upstream payload");
  });

  it("does not mark a locally missing refresh token as definitive invalid grant", async () => {
    const adapter = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch: async () => jsonResponse({}, 500),
      now: () => now
    });

    await expect(
      adapter.refreshCredentials({
        id: "source-a",
        provider: "google",
        credentials: { ...credentials, refreshToken: null }
      })
    ).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      retryable: false,
      reauthReason: null
    });
  });

  it("normalizes aborted requests as stable retryable timeouts", async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new DOMException("synthetic internal detail", "AbortError");
    };
    const adapter = createGoogleDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      fetch,
      now: () => now
    });

    await expect(
      adapter.listFolder({ credentials, folderId: "g-root", cursor: null, pageSize: 10 })
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", retryable: true });
  });

  it("rejects an untrusted OneDrive continuation URL before fetching", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });

    await expect(
      adapter.listFolder({
        credentials,
        folderId: "o-root",
        cursor: "https://evil.synthetic.invalid/steal",
        pageSize: 10
      })
    ).rejects.toMatchObject({ code: "PROVIDER_BAD_RESPONSE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "another folder",
      "https://graph.microsoft.com/v1.0/me/drive/items/o-other/children?$skiptoken=private"
    ],
    [
      "another Graph resource",
      "https://graph.microsoft.com/v1.0/me/drive/root/delta?$skiptoken=private"
    ]
  ])("rejects a OneDrive continuation URL for %s before fetching", async (_label, cursor) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });

    await expect(adapter.listFolder({
      credentials,
      folderId: "o-root",
      cursor,
      pageSize: 10
    })).rejects.toMatchObject({ code: "PROVIDER_BAD_RESPONSE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts only the encoded OneDrive folder path for a continuation URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ value: [] }));
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });

    await adapter.listFolder({
      credentials,
      folderId: "folder/with space",
      cursor: "https://graph.microsoft.com/v1.0/me/drive/items/folder%2Fwith%20space/children?$skiptoken=private",
      pageSize: 10
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact OneDrive continuation projection when Graph repeats it", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ value: [] }));
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });
    const select = "id,name,parentReference,folder,file,image,video,size,createdDateTime,lastModifiedDateTime,photo,eTag";

    await adapter.listFolder({
      credentials,
      folderId: "o-root",
      cursor: `https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private&$top=10&$select=${encodeURIComponent(select)}&$expand=${encodeURIComponent("thumbnails($select=large)")}`,
      pageSize: 10
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["credentials", "https://user:pass@graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private"],
    ["fragment", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private#secret"],
    ["missing skip token", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$top=10"],
    ["empty skip token", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken="],
    ["blank skip token", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=%20"],
    ["duplicate skip token", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=a&$skiptoken=b"],
    ["unknown query key", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private&$filter=deleted%20eq%20null"],
    ["duplicate projection key", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private&$top=10&$top=10"],
    ["broader top", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private&$top=200"],
    ["broader select", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private&$select=id,@microsoft.graph.downloadUrl"],
    ["broader expansion", "https://graph.microsoft.com/v1.0/me/drive/items/o-root/children?$skiptoken=private&$expand=children"]
  ])("rejects a OneDrive continuation URL with %s", async (_label, cursor) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });

    await expect(adapter.listFolder({
      credentials,
      folderId: "o-root",
      cursor,
      pageSize: 10
    })).rejects.toMatchObject({ code: "PROVIDER_BAD_RESPONSE" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when OneDrive reports that no thumbnail exists", async () => {
    const fetch: typeof globalThis.fetch = async () => jsonResponse({}, 404);
    const adapter = createOneDriveAdapter({
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      tenant: "common",
      fetch,
      now: () => now
    });

    await expect(
      adapter.getThumbnailUrl({
        credentials,
        providerNodeId: "o-without-thumbnail",
        maxDimension: 720
      })
    ).resolves.toBeNull();
  });
});

describe("temporary provider URL expiry", () => {
  it("bounds preauthorized URLs by provider lifetime rather than access-token lifetime", async () => {
    const shortCredentials = {
      ...credentials,
      accessTokenExpiresAt: new Date(now.getTime() + 5 * 60 * 1000)
    };
    const google = createHarness("google").adapter;
    const onedrive = createHarness("onedrive").adapter;

    const googleThumbnail = await google.getThumbnailUrl({
      credentials: shortCredentials,
      providerNodeId: "g-image-a",
      maxDimension: 720
    });
    const onedriveThumbnail = await onedrive.getThumbnailUrl({
      credentials: shortCredentials,
      providerNodeId: "o-image-a",
      maxDimension: 720
    });
    const onedriveMedia = await onedrive.getMediaUrl({
      credentials: shortCredentials,
      providerNodeId: "o-image-a"
    });

    const providerExpiry = new Date(now.getTime() + 50 * 60 * 1000);
    expect(googleThumbnail?.expiresAt).toEqual(shortCredentials.accessTokenExpiresAt);
    expect(onedriveThumbnail?.expiresAt).toEqual(providerExpiry);
    expect(onedriveMedia.expiresAt).toEqual(providerExpiry);
  });

  it("expires a constructed Google media URL with its access token", async () => {
    const shortCredentials = {
      ...credentials,
      accessTokenExpiresAt: new Date(now.getTime() + 5 * 60 * 1000)
    };
    const google = createHarness("google").adapter;

    const media = await google.getMediaUrl({
      credentials: shortCredentials,
      providerNodeId: "g-video-a"
    });

    expect(media.expiresAt).toEqual(shortCredentials.accessTokenExpiresAt);
  });
});
