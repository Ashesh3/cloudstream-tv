import {
  ProviderError,
  createProviderRegistry,
  type ProviderAdapter,
  type ProviderKind,
  type TemporaryUrl,
} from "@cloudframe/providers";
import {
  DirectMediaError,
  LiveBrowseError,
  createBrowseHandleCodec,
  createDirectMediaService,
  createLiveBrowseService,
  type AuthenticatedControlDevice,
  type BrowseItemClaims,
  type CredentialBroker,
} from "@cloudframe/server";
import { describe, expect, it } from "vitest";

import {
  TEST_NOW,
  testAeadKeyring,
  testControlDocument,
} from "./helpers/control-plane";

const RESPONSE_HEADERS = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
};

describe("direct provider URL vending", () => {
  it("returns a Google URL while Vercel handles no media body", async () => {
    const harness = createHarness();

    const result = await harness.media.media(
      harness.auth(),
      harness.handle("source-google", "root-google", "google-video", "video"),
    );

    expect(new URL(result.url).hostname).toBe("www.googleapis.com");
    expect(result.url).toContain("alt=media");
    expect(result.url).toContain("access_token=");
    expect(result.responseHeaders).toMatchObject(RESPONSE_HEADERS);
    expect(result).toMatchObject({
      itemId: expect.stringMatching(/^item_/),
      kind: "video",
      expiresAt: harness.expiry.toISOString(),
      revision: null,
    });
    expect(harness.vercelBodyBytes).toBe(0);
    expect(result).not.toHaveProperty("providerNodeId");
    expect(result).not.toHaveProperty("handle");
  });

  it("returns the OneDrive pre-authorized URL", async () => {
    const harness = createHarness();

    const result = await harness.media.media(
      harness.auth(),
      harness.handle(
        "source-onedrive",
        "root-onedrive",
        "onedrive-video",
        "video",
      ),
    );

    expect(new URL(result.url).hostname).toMatch(/sharepoint|onedrive|microsoft/);
    expect(result.itemId).toMatch(/^item_/);
  });

  it("does not expose raw handles or provider ids in thumbnail results", async () => {
    const harness = createHarness();
    const sealedHandle = harness.handle(
      "source-google",
      "root-google",
      "google-image",
      "image",
    );

    const result = await harness.media.thumbnails(
      harness.auth(),
      [sealedHandle],
      720,
    );

    expect(result.items[0]?.itemId).toMatch(/^item_/);
    expect(result.items[0]).toMatchObject({
      status: "ready",
      expiresAt: harness.expiry.toISOString(),
      revision: null,
    });
    expect(JSON.stringify(result)).not.toContain(sealedHandle);
    expect(result.items[0]).not.toHaveProperty("providerNodeId");
    expect(result.items[0]).not.toHaveProperty("handle");
  });

  it("authorizes the whole thumbnail batch before any provider or credential call", async () => {
    const harness = createHarness();
    const valid = harness.handle(
      "source-google",
      "root-google",
      "google-image",
      "image",
    );

    await expect(
      harness.media.thumbnails(harness.auth(), [valid, "not-a-sealed-handle"], 720),
    ).rejects.toEqual(new LiveBrowseError("NAVIGATION_EXPIRED"));
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  it("rejects invalid and duplicate batches before authorization or provider calls", async () => {
    const harness = createHarness();
    const handle = harness.handle(
      "source-google",
      "root-google",
      "google-image",
      "image",
    );

    for (const [handles, dimension] of [
      [[], 720],
      [[handle, handle], 720],
      [Array.from({ length: 101 }, (_, index) => `sealed-${index}`), 720],
      [[handle], 63],
      [[handle], 4097],
      [[handle], 720.5],
    ] as const) {
      await expect(
        harness.media.thumbnails(
          harness.auth(),
          handles as readonly string[],
          dimension,
        ),
      ).rejects.toEqual(new DirectMediaError("INVALID_THUMBNAIL_REQUEST"));
    }
    expect(harness.authorizations).toBe(0);
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  it("groups thumbnails by source, reuses credentials, and preserves input order", async () => {
    const harness = createHarness();
    const oneDriveImage = harness.handle(
      "source-onedrive",
      "root-onedrive",
      "onedrive-image",
      "image",
    );
    const googleImage = harness.handle(
      "source-google",
      "root-google",
      "google-image",
      "image",
    );
    const googleVideo = harness.handle(
      "source-google",
      "root-google",
      "google-video",
      "video",
    );

    const result = await harness.media.thumbnails(
      harness.auth(),
      [oneDriveImage, googleImage, googleVideo],
      720,
    );

    expect(result.items.map((item) => item.status)).toEqual([
      "ready",
      "ready",
      "unavailable",
    ]);
    expect(result.items.map((item) => item.itemId)).toEqual([
      harness.itemId("source-onedrive", "onedrive-image"),
      harness.itemId("source-google", "google-image"),
      harness.itemId("source-google", "google-video"),
    ]);
    expect(harness.credentialGetsBySource).toEqual([
      "source-onedrive",
      "source-google",
    ]);
    expect(harness.thumbnailInputs).toEqual([
      { provider: "onedrive", providerNodeId: "onedrive-image", maxDimension: 720 },
      { provider: "google", providerNodeId: "google-image", maxDimension: 720 },
      { provider: "google", providerNodeId: "google-video", maxDimension: 720 },
    ]);
  });

  it("returns unavailable for folders, absent thumbnails, and definitive missing items", async () => {
    const harness = createHarness();
    harness.google.thumbnailResults.set("google-missing-preview", null);
    harness.google.thumbnailErrors.set(
      "google-gone",
      new ProviderError("PROVIDER_NOT_FOUND", "private upstream detail", {
        retryable: false,
      }),
    );

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle("source-google", "root-google", "google-folder", "folder"),
        harness.handle(
          "source-google",
          "root-google",
          "google-missing-preview",
          "image",
        ),
        harness.handle("source-google", "root-google", "google-gone", "image"),
      ],
      720,
    );

    expect(result.items.map((item) => item.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(harness.thumbnailInputs.map((input) => input.providerNodeId)).toEqual([
      "google-missing-preview",
      "google-gone",
    ]);
  });

  it("returns a folder-only thumbnail batch without credential or provider access", async () => {
    const harness = createHarness();

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-google",
          "root-google",
          "google-folder",
          "folder",
        ),
      ],
      720,
    );

    expect(result.items).toEqual([
      {
        itemId: harness.itemId("source-google", "google-folder"),
        status: "unavailable",
      },
    ]);
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  it("rejects folder media as item not found before provider access", async () => {
    const harness = createHarness();

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle("source-google", "root-google", "google-folder", "folder"),
      ),
    ).rejects.toEqual(new DirectMediaError("ITEM_NOT_FOUND"));
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  it("refreshes once for a non-definitive access rejection and retries provider access", async () => {
    const harness = createHarness();
    harness.google.mediaFailures.push(
      new ProviderError("PROVIDER_REAUTH_REQUIRED", "private provider detail", {
        retryable: false,
      }),
    );

    const result = await harness.media.media(
      harness.auth(),
      harness.handle("source-google", "root-google", "google-video", "video"),
    );

    expect(result.url).toContain("refreshed-google-access");
    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.mediaTokens).toEqual([
      "initial-google-access",
      "refreshed-google-access",
    ]);
  });

  it("does not retry invalid grants or arbitrary provider failures", async () => {
    const invalidGrant = createHarness();
    invalidGrant.google.mediaFailures.push(
      new ProviderError("PROVIDER_REAUTH_REQUIRED", "private invalid grant", {
        retryable: false,
        reauthReason: "invalid_grant",
      }),
    );

    await expect(
      invalidGrant.media.media(
        invalidGrant.auth(),
        invalidGrant.handle(
          "source-google",
          "root-google",
          "google-video",
          "video",
        ),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(invalidGrant.credentialRefreshes).toBe(0);

    const throttled = createHarness();
    throttled.google.mediaFailures.push(
      new ProviderError("PROVIDER_THROTTLED", "private provider detail", {
        retryable: true,
      }),
    );
    await expect(
      throttled.media.media(
        throttled.auth(),
        throttled.handle(
          "source-google",
          "root-google",
          "google-video",
          "video",
        ),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_THROTTLED" });
    expect(throttled.credentialRefreshes).toBe(0);
  });

  it("rejects a refreshed credential version incompatible with the authorized handle", async () => {
    const harness = createHarness();
    harness.refreshVersions.set("source-google", 2);
    harness.google.mediaFailures.push(
      new ProviderError("PROVIDER_REAUTH_REQUIRED", "private provider detail", {
        retryable: false,
      }),
    );

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-google",
          "root-google",
          "google-video",
          "video",
        ),
      ),
    ).rejects.toEqual(new LiveBrowseError("NAVIGATION_EXPIRED"));
    expect(harness.mediaTokens).toEqual(["initial-google-access"]);
  });

  it("normalizes unstable provider URL objects before building a response", async () => {
    const harness = createHarness();
    harness.oneDrive.thumbnailResults.set(
      "onedrive-unstable",
      Object.defineProperties({}, {
        url: {
          enumerable: true,
          get() {
            throw new Error("private provider URL detail");
          },
        },
        expiresAt: {
          enumerable: true,
          value: harness.expiry,
        },
      }) as TemporaryUrl,
    );

    const error = await harness.media
      .thumbnails(
        harness.auth(),
        [
          harness.handle(
            "source-onedrive",
            "root-onedrive",
            "onedrive-unstable",
            "image",
          ),
        ],
        720,
      )
      .catch((value) => value);

    expect(error).toEqual(new DirectMediaError("INVALID_PROVIDER_URL"));
    expect(String(error)).not.toContain("private provider URL detail");
  });

  it("returns the URL snapshot that was validated even if provider getters change", async () => {
    const harness = createHarness();
    let reads = 0;
    const validated = "https://public.dm.files.1drv.com/y4m/preview";
    harness.oneDrive.thumbnailResults.set(
      "onedrive-changing",
      Object.defineProperties({}, {
        url: {
          enumerable: true,
          get() {
            reads += 1;
            return reads < 3 ? validated : "javascript:alert(1)";
          },
        },
        expiresAt: {
          enumerable: true,
          value: harness.expiry,
        },
      }) as TemporaryUrl,
    );

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-changing",
          "image",
        ),
      ],
      720,
    );

    expect(result.items[0]).toMatchObject({ status: "ready", url: validated });
  });

  it.each([
    ["javascript scheme", "javascript:alert(1)", harnessExpiry()],
    ["local Google host", "https://localhost/media", harnessExpiry()],
    ["credentialed URL", "https://user:pass@www.googleapis.com/media", harnessExpiry()],
    ["fragment", "https://www.googleapis.com/media#token", harnessExpiry()],
    ["non-default port", "https://www.googleapis.com:8443/media", harnessExpiry()],
    ["invalid expiry", "https://www.googleapis.com/media", new Date("invalid")],
  ])("rejects a provider URL with %s without exposing it", async (_label, url, expiresAt) => {
    const harness = createHarness();
    harness.google.mediaResult = { url, expiresAt };

    const error = await harness.media
      .media(
        harness.auth(),
        harness.handle(
          "source-google",
          "root-google",
          "google-video",
          "video",
        ),
      )
      .catch((value) => value);

    expect(error).toEqual(new DirectMediaError("INVALID_PROVIDER_URL"));
    expect(String(error)).not.toContain(url);
  });

  it("rejects provider URLs on the wrong provider host boundary", async () => {
    const harness = createHarness();
    harness.google.mediaResult = {
      url: "https://tenant.sharepoint.com/google-confusion",
      expiresAt: harness.expiry,
    };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-google",
          "root-google",
          "google-video",
          "video",
        ),
      ),
    ).rejects.toEqual(new DirectMediaError("INVALID_PROVIDER_URL"));
  });
});

function harnessExpiry() {
  return new Date(TEST_NOW.getTime() + 45 * 60_000);
}

function createHarness() {
  const document = testControlDocument();
  document.devices["device-1"]!.assignedRootIds = [
    "root-google",
    "root-onedrive",
  ];
  document.sources = {
    "source-google": {
      ...document.sources["source-1"]!,
      id: "source-google",
      provider: "google",
      providerAccountId: "google-account",
      accountLabel: "google@example.test",
    },
    "source-onedrive": {
      ...document.sources["source-1"]!,
      id: "source-onedrive",
      provider: "onedrive",
      providerAccountId: "onedrive-account",
      accountLabel: "onedrive@example.test",
    },
  };
  document.roots = {
    "root-google": {
      ...document.roots["root-1"]!,
      id: "root-google",
      sourceId: "source-google",
      providerNodeId: "google-root",
      displayName: "Google",
    },
    "root-onedrive": {
      ...document.roots["root-1"]!,
      id: "root-onedrive",
      sourceId: "source-onedrive",
      providerNodeId: "onedrive-root",
      displayName: "OneDrive",
    },
  };

  const expiry = harnessExpiry();
  const codec = createBrowseHandleCodec(
    testAeadKeyring(),
    "browse-id-secret",
    () => new Date(TEST_NOW),
  );
  const google = new MediaProviderHarness(
    "google",
    "https://www.googleapis.com/drive/v3/files/google-video?alt=media&access_token=initial-google-access&supportsAllDrives=true",
    "https://www.googleapis.com/drive/v3/files/google-image?alt=media&access_token=initial-google-access&supportsAllDrives=true",
    expiry,
  );
  google.thumbnailResults.set("google-video", null);
  const oneDrive = new MediaProviderHarness(
    "onedrive",
    "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?token=media",
    "https://public.dm.files.1drv.com/y4m/thumbnail?token=preview",
    expiry,
  );
  const providers = createProviderRegistry({
    google: google.adapter,
    onedrive: oneDrive.adapter,
  });
  const credentialGetsBySource: string[] = [];
  let credentialGets = 0;
  let credentialRefreshes = 0;
  const refreshVersions = new Map<string, number>();
  const broker: CredentialBroker = {
    async get(sourceId) {
      credentialGets += 1;
      credentialGetsBySource.push(sourceId);
      return credentials(
        `initial-${sourceId === "source-google" ? "google" : "onedrive"}-access`,
        1,
        expiry,
      );
    },
    async refresh(sourceId) {
      credentialRefreshes += 1;
      return credentials(
        `refreshed-${sourceId === "source-google" ? "google" : "onedrive"}-access`,
        refreshVersions.get(sourceId) ?? 1,
        expiry,
      );
    },
  };
  const liveBrowse = createLiveBrowseService({
    handles: codec,
    credentialBroker: broker,
    providers,
    now: () => new Date(TEST_NOW),
  });
  let authorizations = 0;
  const media = createDirectMediaService({
    browse: {
      authorizeHandle(auth, sealedHandle) {
        authorizations += 1;
        return liveBrowse.authorizeHandle(auth, sealedHandle);
      },
    },
    credentialBroker: broker,
    providers,
    now: () => new Date(TEST_NOW),
  });

  function auth(): AuthenticatedControlDevice {
    const device = document.devices["device-1"]!;
    return {
      householdId: document.householdId,
      deviceId: device.id,
      sessionVersion: device.sessionVersion,
      device: structuredClone(device),
      context: { document, revision: document.revision },
    };
  }

  function handle(
    sourceId: "source-google" | "source-onedrive",
    rootId: "root-google" | "root-onedrive",
    providerNodeId: string,
    kind: BrowseItemClaims["kind"],
  ): string {
    const root = document.roots[rootId]!;
    return codec.sealItem({
      version: 2,
      householdId: document.householdId,
      deviceId: "device-1",
      sourceId,
      rootId,
      rootProviderNodeId: root.providerNodeId,
      providerNodeId,
      parentProviderNodeId:
        providerNodeId === root.providerNodeId ? null : root.providerNodeId,
      kind,
      name: providerNodeId,
      mimeType:
        kind === "folder" ? null : kind === "video" ? "video/mp4" : "image/jpeg",
      credentialVersion: 1,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000,
    });
  }

  return {
    media,
    google,
    oneDrive,
    expiry,
    auth,
    handle,
    itemId: (sourceId: string, providerNodeId: string) =>
      codec.stableItemId(document.householdId, sourceId, providerNodeId),
    credentialGetsBySource,
    refreshVersions,
    get credentialGets() {
      return credentialGets;
    },
    get credentialRefreshes() {
      return credentialRefreshes;
    },
    get authorizations() {
      return authorizations;
    },
    get providerCalls() {
      return google.calls + oneDrive.calls;
    },
    get thumbnailInputs() {
      return [...oneDrive.thumbnailInputs, ...google.thumbnailInputs];
    },
    get mediaTokens() {
      return google.mediaTokens;
    },
    get vercelBodyBytes() {
      return 0;
    },
  };
}

function credentials(
  accessToken: string,
  credentialVersion: number,
  accessTokenExpiresAt: Date,
) {
  return {
    accessToken,
    refreshToken: null,
    accessTokenExpiresAt,
    credentialVersion,
  };
}

class MediaProviderHarness {
  calls = 0;
  readonly thumbnailInputs: Array<{
    provider: ProviderKind;
    providerNodeId: string;
    maxDimension: number;
  }> = [];
  readonly mediaTokens: string[] = [];
  readonly thumbnailResults = new Map<string, TemporaryUrl | null>();
  readonly thumbnailErrors = new Map<string, unknown>();
  readonly mediaFailures: unknown[] = [];
  mediaResult: TemporaryUrl;

  readonly adapter: ProviderAdapter;

  constructor(
    readonly provider: ProviderKind,
    mediaUrl: string,
    thumbnailUrl: string,
    expiry: Date,
  ) {
    this.mediaResult = { url: mediaUrl, expiresAt: expiry };
    this.thumbnailResults.set("google-image", {
      url: thumbnailUrl,
      expiresAt: expiry,
    });
    this.thumbnailResults.set("onedrive-image", {
      url: thumbnailUrl,
      expiresAt: expiry,
    });
    this.adapter = {
      beginAuthorization: async () => unexpected("beginAuthorization"),
      completeAuthorization: async () => unexpected("completeAuthorization"),
      refreshCredentials: async () => unexpected("refreshCredentials"),
      getRoot: async () => unexpected("getRoot"),
      getNode: async () => unexpected("getNode"),
      listFolder: async () => unexpected("listFolder"),
      getThumbnailUrl: async (input) => {
        this.calls += 1;
        this.thumbnailInputs.push({
          provider: this.provider,
          providerNodeId: input.providerNodeId,
          maxDimension: input.maxDimension,
        });
        const error = this.thumbnailErrors.get(input.providerNodeId);
        if (error !== undefined) throw error;
        return this.thumbnailResults.get(input.providerNodeId) ?? null;
      },
      getMediaUrl: async (input) => {
        this.calls += 1;
        this.mediaTokens.push(input.credentials.accessToken);
        const failure = this.mediaFailures.shift();
        if (failure !== undefined) throw failure;
        if (this.provider === "google") {
          return {
            ...this.mediaResult,
            url: this.mediaResult.url.replace(
              /access_token=[^&]+/,
              `access_token=${input.credentials.accessToken}`,
            ),
          };
        }
        return this.mediaResult;
      },
    };
  }
}

function unexpected(operation: string): never {
  throw new Error(`Unexpected provider operation: ${operation}`);
}
