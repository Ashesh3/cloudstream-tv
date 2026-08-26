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
  requests: URL[];
}

function createHarness(provider: ProviderKind): ContractHarness {
  const requests: URL[] = [];
  const fetch: typeof globalThis.fetch = async input => {
    const url = inputUrl(input);
    requests.push(url);

    if (provider === "google") {
      if (url.pathname.endsWith("/files/root")) return jsonResponse({
        id: "g-root-actual",
        name: "My Drive",
        mimeType: "application/vnd.google-apps.folder"
      });
      if (url.pathname.endsWith("/files")) return jsonResponse(fixture(provider, "folder-page"));
      if (url.pathname.endsWith("/changes")) return jsonResponse(fixture(provider, "changes-page"));
      if (url.pathname.endsWith("/g-image-a")) {
        return jsonResponse({
          id: "g-image-a",
          thumbnailLink: "https://synthetic.invalid/google-thumb=s220",
          version: "12"
        });
      }
    } else {
      if (url.pathname.endsWith("/drive/root")) return jsonResponse({
        id: "o-root-actual",
        name: "OneDrive",
        folder: { childCount: 4 }
      });
      if (url.pathname.endsWith("/children")) return jsonResponse(fixture(provider, "folder-page"));
      if (url.pathname.endsWith("/delta")) return jsonResponse(fixture(provider, "changes-page"));
      if (url.pathname.endsWith("/thumbnails/0/c720x720")) {
        return jsonResponse({ url: "https://synthetic.invalid/onedrive-thumb-720" });
      }
      if (url.pathname.endsWith("/o-image-a")) {
        return jsonResponse({
          id: "o-image-a",
          "@microsoft.graph.downloadUrl": "https://synthetic.invalid/onedrive-media"
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
      kind: "folder"
    });
    expect(page.items[1]).toMatchObject({
      name: "Beach.jpg",
      mimeType: "image/jpeg",
      size: 1234,
      width: 1920,
      height: 1080,
      capturedAt: new Date("2024-03-01T02:03:04.000Z"),
      hasPreview: true
    });
    expect(page.items[2]).toMatchObject({
      name: "Clip.mp4",
      mimeType: "video/mp4",
      width: 1280,
      height: 720,
      createdAt: null,
      hasPreview: true
    });
    expect(page.nextCursor).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain("synthetic.invalid");
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
    expect(requests.at(-1)?.pathname).toBe(
      provider === "google"
        ? "/drive/v3/files/root"
        : "/v1.0/me/drive/root"
    );
  });

  it("normalizes deletes and moves from change pages", async () => {
    const { adapter } = createHarness(provider);
    const page = await adapter.getChanges({
      credentials,
      cursor: provider === "google" ? "google-delta-previous" : null,
      pageSize: 50
    });

    expect(page.changes).toHaveLength(2);
    expect(page.changes[0]).toEqual({
      providerNodeId: provider === "google" ? "g-deleted-a" : "o-deleted-a",
      removed: true,
      node: null
    });
    expect(page.changes[1]).toMatchObject({
      removed: false,
      node: {
        name: "Moved.jpg",
        kind: "image",
        parentProviderId: provider === "google" ? "g-folder-b" : "o-folder-b"
      }
    });
    expect(page.nextCursor).toBeNull();
    expect(page.deltaCursor).toBeTruthy();
    expect(JSON.stringify(page)).not.toContain("synthetic.invalid");
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

    expect(thumbnail?.url).toContain("synthetic.invalid");
    expect(thumbnail?.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(
      media.url.includes("synthetic.invalid") || media.url.includes("googleapis.com")
    ).toBe(true);
    expect(media.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    if (provider === "google") {
      expect(thumbnail?.url.endsWith("=s720")).toBe(true);
      expect(media.url).toBe(
        "https://www.googleapis.com/drive/v3/files/g-image-a?alt=media&access_token=synthetic-access-token&supportsAllDrives=true"
      );
      expect(media.expiresAt).toEqual(accessExpiresAt);
    } else {
      expect(thumbnail?.url).toBe("https://synthetic.invalid/onedrive-thumb-720");
      expect(media.url).toBe("https://synthetic.invalid/onedrive-media");
    }
    expect(requests.every(url => !url.pathname.includes("/api/"))).toBe(true);
  });

  if (provider === "google") {
    it("adds Shared Drive flags to list, changes, thumbnail, and media requests", async () => {
      const { adapter, requests } = createHarness(provider);
      await adapter.listFolder({
        credentials,
        folderId: "g-root",
        cursor: null,
        pageSize: 50
      });
      await adapter.getChanges({
        credentials,
        cursor: "google-delta-previous",
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

      const list = requests.find(url => url.pathname.endsWith("/files"))!;
      const changes = requests.find(url => url.pathname.endsWith("/changes"))!;
      const thumbnail = requests.find(url => url.pathname.endsWith("/g-image-a"))!;
      expect(list.searchParams.get("supportsAllDrives")).toBe("true");
      expect(list.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(changes.searchParams.get("supportsAllDrives")).toBe("true");
      expect(changes.searchParams.get("includeItemsFromAllDrives")).toBe("true");
      expect(thumbnail.searchParams.get("supportsAllDrives")).toBe("true");
      expect(new URL(media.url).searchParams.get("supportsAllDrives")).toBe("true");
    });
  }
});

describe("provider failure normalization", () => {
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
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED", retryable: false });
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
