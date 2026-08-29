import {
  type AuthenticatedMediaRequest,
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

describe("direct provider URL vending", () => {
  it("returns the validated raw Google URL and short-lived bearer credential", async () => {
    const harness = createHarness();
    const result = await harness.media.media(
      harness.auth(),
      harness.handle("source-google", "root-google", "google-video", "video"),
    );

    expect(result).toMatchObject({
      itemId: harness.itemId("source-google", "google-video"),
      kind: "video",
      transport: "google-bearer",
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      authorization: { scheme: "Bearer", token: "access-token" },
      expiresAt: harness.expiry.toISOString(),
      revision: null,
    });
    expect(result.url).not.toContain("access_token");
  });

  it("returns unavailable for one failed Google thumbnail without rejecting the batch", async () => {
    const harness = createHarness();
    harness.google.thumbnailErrors.set(
      "google-bad",
      new ProviderError("PROVIDER_BAD_RESPONSE", "private upstream detail", {
        retryable: false,
      }),
    );

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle("source-google", "root-google", "google-image", "image"),
        harness.handle("source-google", "root-google", "google-bad", "image"),
      ],
      720,
    );

    expect(result.items.map((item) => item.status)).toEqual(["ready", "unavailable"]);
  });

  it("refreshes once when Google thumbnail authorization expires early", async () => {
    const harness = createHarness();
    harness.google.thumbnailErrors.set(
      "google-image",
      new ProviderError("PROVIDER_REAUTH_REQUIRED", "private upstream detail", {
        retryable: false,
      }),
    );
    harness.google.clearThumbnailErrorAfterThrow = true;

    const result = await harness.media.thumbnails(
      harness.auth(),
      [harness.handle("source-google", "root-google", "google-image", "image")],
      720,
    );

    expect(result.items.map((item) => item.status)).toEqual(["ready"]);
    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.google.thumbnailTokens).toEqual([
      "access-token",
      "refreshed-google-access",
    ]);
  });

  it("refreshes Google thumbnail credentials at most once per source group", async () => {
    const harness = createHarness();
    const reauth = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "private upstream detail",
      { retryable: false },
    );
    harness.google.thumbnailErrors.set("google-image", reauth);
    harness.google.thumbnailErrors.set("google-bad", reauth);
    harness.google.clearThumbnailErrorsAfterThrows = 1;

    await expect(
      harness.media.thumbnails(
        harness.auth(),
        [
          harness.handle("source-google", "root-google", "google-image", "image"),
          harness.handle("source-google", "root-google", "google-bad", "image"),
        ],
        720,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(harness.credentialRefreshes).toBe(1);
  });

  it.each([
    "PROVIDER_REAUTH_REQUIRED",
    "PROVIDER_THROTTLED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_UNAVAILABLE",
  ] as const)("does not hide a %s thumbnail failure", async (code) => {
    const harness = createHarness();
    harness.google.thumbnailErrors.set(
      "google-image",
      new ProviderError(code, "private upstream detail", {
        retryable: code !== "PROVIDER_REAUTH_REQUIRED",
      }),
    );

    await expect(
      harness.media.thumbnails(
        harness.auth(),
        [harness.handle("source-google", "root-google", "google-image", "image")],
        720,
      ),
    ).rejects.toMatchObject({ code });
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

    expect(result).toMatchObject({
      transport: "direct",
      url: "https://public.dm.files.1drv.com/download?capability=1",
    });
    expect(result).not.toHaveProperty("authorization");
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

  it("returns a sealed listing preview without another credential or provider request", async () => {
    const harness = createHarness();
    const previewUrl = "https://lh3.googleusercontent.com/listing-image=s720";

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-google",
          "root-google",
          "google-listing-image",
          "image",
          {
            url: previewUrl,
            expiresAt: TEST_NOW.getTime() + 20 * 60_000,
          },
        ),
      ],
      720,
    );

    expect(result.items).toEqual([
      {
        itemId: harness.itemId("source-google", "google-listing-image"),
        status: "ready",
        url: previewUrl,
        expiresAt: new Date(TEST_NOW.getTime() + 20 * 60_000).toISOString(),
        revision: null,
      },
    ]);
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  it("falls back to provider thumbnail vending after a sealed preview expires", async () => {
    const harness = createHarness();
    harness.google.thumbnailResults.set("google-expired-preview", {
      url: "https://lh3.googleusercontent.com/fresh-image=s720",
      expiresAt: harness.expiry,
    });

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-google",
          "root-google",
          "google-expired-preview",
          "image",
          {
            url: "https://lh3.googleusercontent.com/expired-image=s720",
            expiresAt: TEST_NOW.getTime() - 1,
          },
        ),
      ],
      720,
    );

    expect(result.items[0]).toMatchObject({
      status: "ready",
      url: "https://lh3.googleusercontent.com/fresh-image=s720",
    });
    expect(harness.thumbnailInputs).toEqual([
      {
        provider: "google",
        providerNodeId: "google-expired-preview",
        kind: "image",
        maxDimension: 720,
      },
    ]);
  });

  it("bypasses a valid sealed preview when the browser requests one fresh thumbnail", async () => {
    const harness = createHarness();
    harness.google.thumbnailResults.set("google-decode-failed", {
      url: "https://lh3.googleusercontent.com/fresh-after-decode=s720",
      expiresAt: harness.expiry,
    });

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-google",
          "root-google",
          "google-decode-failed",
          "image",
          {
            url: "https://lh3.googleusercontent.com/listing-preview=s720",
            expiresAt: TEST_NOW.getTime() + 20 * 60_000,
          },
        ),
      ],
      720,
      true,
    );

    expect(result.items[0]).toMatchObject({
      status: "ready",
      url: "https://lh3.googleusercontent.com/fresh-after-decode=s720",
    });
    expect(harness.thumbnailInputs).toEqual([
      { provider: "google", providerNodeId: "google-decode-failed", kind: "image", maxDimension: 720 },
    ]);
  });

  it("returns representative folder previews and accepts OneDrive storage subdomains", async () => {
    const harness = createHarness();
    const previewUrl =
      "https://public.storage.live.com/items/folder?authkey=folder-capability";

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-folder",
          "folder",
          {
            url: previewUrl,
            expiresAt: TEST_NOW.getTime() + 20 * 60_000,
          },
        ),
      ],
      720,
    );

    expect(result.items[0]).toMatchObject({ status: "ready", url: previewUrl });
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
  });

  it("isolates a malformed sealed Google preview without rejecting the thumbnail batch", async () => {
    const harness = createHarness();
    const validUrl = "https://lh3.googleusercontent.com/valid-listing=s720";

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-google",
          "root-google",
          "google-invalid-listing",
          "image",
          {
            url: "https://tenant.sharepoint.com/_layouts/15/download.aspx?token=wrong-provider",
            expiresAt: TEST_NOW.getTime() + 20 * 60_000,
          },
        ),
        harness.handle(
          "source-google",
          "root-google",
          "google-valid-listing",
          "image",
          {
            url: validUrl,
            expiresAt: TEST_NOW.getTime() + 20 * 60_000,
          },
        ),
      ],
      720,
    );

    expect(result.items).toEqual([
      {
        itemId: harness.itemId("source-google", "google-invalid-listing"),
        status: "unavailable",
      },
      expect.objectContaining({ status: "ready", url: validUrl }),
    ]);
    expect(harness.credentialGets).toBe(0);
    expect(harness.providerCalls).toBe(0);
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

  it("authorizes a media handle before credential or provider access", async () => {
    const harness = createHarness();

    await expect(
      harness.media.media(harness.auth(), "not-a-sealed-handle"),
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
      "ready",
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
      { provider: "onedrive", providerNodeId: "onedrive-image", kind: "image", maxDimension: 720 },
      { provider: "google", providerNodeId: "google-image", kind: "image", maxDimension: 720 },
      { provider: "google", providerNodeId: "google-video", kind: "video", maxDimension: 720 },
    ]);
  });

  it("returns unavailable for folders without previews, absent thumbnails, and definitive missing items", async () => {
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
      "google-folder",
      "google-missing-preview",
      "google-gone",
    ]);
  });

  it("asks the provider for a representative folder thumbnail when none was listed", async () => {
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
    expect(harness.credentialGets).toBe(1);
    expect(harness.thumbnailInputs).toEqual([
      { provider: "google", providerNodeId: "google-folder", kind: "folder", maxDimension: 720 },
    ]);
  });

  it("bounds representative folder thumbnail lookups while allowing parallel progress", async () => {
    const harness = createHarness();
    const release = harness.google.blockThumbnailCalls();
    const folderIds = Array.from({ length: 6 }, (_, index) => `google-folder-${index}`);
    folderIds.forEach((providerNodeId, index) => {
      harness.google.thumbnailResults.set(providerNodeId, {
        url: `https://lh3.googleusercontent.com/folder-${index}=s720`,
        expiresAt: harness.expiry,
      });
    });

    const pending = harness.media.thumbnails(
      harness.auth(),
      folderIds.map((providerNodeId) =>
        harness.handle("source-google", "root-google", providerNodeId, "folder")
      ),
      720,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const startedBeforeRelease = harness.google.thumbnailInputs.length;
    const maximumConcurrent = harness.google.maximumConcurrentThumbnailCalls;
    release();
    const result = await pending;

    expect(startedBeforeRelease).toBe(4);
    expect(maximumConcurrent).toBe(4);
    expect(result.items.map((item) => item.itemId)).toEqual(
      folderIds.map((providerNodeId) => harness.itemId("source-google", providerNodeId)),
    );
    expect(result.items.map((item) => item.status)).toEqual(Array(6).fill("ready"));
  });

  it("shares one credential refresh across concurrent thumbnail reauthorization", async () => {
    const harness = createHarness();
    const providerNodeIds = Array.from({ length: 4 }, (_, index) => `google-reauth-${index}`);
    providerNodeIds.forEach((providerNodeId, index) => {
      harness.google.thumbnailErrors.set(
        providerNodeId,
        new ProviderError("PROVIDER_REAUTH_REQUIRED", "private upstream detail", {
          retryable: false,
        }),
      );
      harness.google.thumbnailResults.set(providerNodeId, {
        url: `https://lh3.googleusercontent.com/reauth-${index}=s720`,
        expiresAt: harness.expiry,
      });
    });
    harness.google.clearThumbnailErrorAfterThrow = true;

    const result = await harness.media.thumbnails(
      harness.auth(),
      providerNodeIds.map((providerNodeId) =>
        harness.handle("source-google", "root-google", providerNodeId, "folder")
      ),
      720,
    );

    expect(result.items.map((item) => item.status)).toEqual(Array(4).fill("ready"));
    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.google.thumbnailTokens.filter((token) => token === "access-token")).toHaveLength(4);
    expect(harness.google.thumbnailTokens.filter((token) => token === "refreshed-google-access")).toHaveLength(4);
  });

  it("settles in-flight thumbnail lookups before reporting a fatal batch error", async () => {
    const harness = createHarness();
    const blockedIds = ["google-blocked-1", "google-blocked-2", "google-blocked-3"];
    const releaseBlocked = blockedIds.map((providerNodeId) =>
      harness.google.blockThumbnailCall(providerNodeId)
    );
    harness.google.thumbnailErrors.set(
      "google-fatal",
      new ProviderError("PROVIDER_THROTTLED", "private upstream detail", {
        retryable: true,
      }),
    );
    const providerNodeIds = [
      "google-fatal",
      ...blockedIds,
      "google-not-started-1",
      "google-not-started-2",
    ];

    const pending = harness.media.thumbnails(
      harness.auth(),
      providerNodeIds.map((providerNodeId) =>
        harness.handle("source-google", "root-google", providerNodeId, "folder")
      ),
      720,
    );
    const outcome = pending.then(() => "resolved", () => "rejected");

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await Promise.race([
      outcome,
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 10)),
    ])).toBe("waiting");
    expect(harness.google.thumbnailInputs.map((input) => input.providerNodeId)).toEqual([
      "google-fatal",
      ...blockedIds,
    ]);

    releaseBlocked.forEach((release) => release());
    await expect(pending).rejects.toMatchObject({ code: "PROVIDER_THROTTLED" });
    expect(harness.google.activeThumbnailCalls).toBe(0);
    expect(harness.google.thumbnailInputs.map((input) => input.providerNodeId)).not.toEqual(
      expect.arrayContaining(["google-not-started-1", "google-not-started-2"]),
    );
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

    expect(result).toMatchObject({
      transport: "google-bearer",
      authorization: { scheme: "Bearer", token: "refreshed-google-access" },
    });
    expect(result.url).not.toContain("refreshed-google-access");
    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.mediaTokens).toEqual([
      "access-token",
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
    expect(harness.mediaTokens).toEqual(["access-token"]);
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

    const result = await harness.media.thumbnails(
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
    );

    expect(result.items[0]).toMatchObject({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("private provider URL detail");
  });

  it("returns the URL snapshot that was validated even if provider getters change", async () => {
    const harness = createHarness();
    let reads = 0;
    const validated =
      "https://public.dm.files.1drv.com/y4m/preview?authkey=capability";
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

  it("returns the validated Google descriptor snapshot when provider getters change", async () => {
    const harness = createHarness();
    let reads = 0;
    const validated =
      "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true";
    harness.google.rewriteGoogleMediaToken = false;
    harness.google.mediaResult = Object.defineProperties({}, {
      url: {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? validated : "https://attacker.example/media";
        },
      },
      headers: {
        enumerable: true,
        value: { authorization: "Bearer access-token" },
      },
      expiresAt: {
        enumerable: true,
        value: harness.expiry,
      },
    }) as AuthenticatedMediaRequest;

    const result = await harness.media.media(
      harness.auth(),
      harness.handle("source-google", "root-google", "google-video", "video"),
    );

    expect(result).toMatchObject({
      transport: "google-bearer",
      url: validated,
      authorization: { scheme: "Bearer", token: "access-token" },
    });
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

  it.each([
    [
      "wrong item",
      "https://www.googleapis.com/drive/v3/files/another-item?alt=media&access_token=access-token&supportsAllDrives=true",
    ],
    [
      "wrong token",
      "https://www.googleapis.com/drive/v3/files/google-video?alt=media&access_token=attacker-token&supportsAllDrives=true",
    ],
    [
      "missing alt",
      "https://www.googleapis.com/drive/v3/files/google-video?access_token=access-token&supportsAllDrives=true",
    ],
    [
      "duplicate token",
      "https://www.googleapis.com/drive/v3/files/google-video?alt=media&access_token=access-token&access_token=attacker-token&supportsAllDrives=true",
    ],
    [
      "extra query",
      "https://www.googleapis.com/drive/v3/files/google-video?alt=media&access_token=access-token&supportsAllDrives=true&fields=id",
    ],
    [
      "wrong purpose",
      "https://www.googleapis.com/drive/v3/files/google-video?alt=metadata&access_token=access-token&supportsAllDrives=true",
    ],
  ])("rejects a Google media URL with %s", async (_label, url) => {
    const harness = createHarness();
    harness.google.rewriteGoogleMediaToken = false;
    harness.google.mediaResult = { url, expiresAt: harness.expiry };

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

  it.each([
    "https://microsoft.com/download?token=capability",
    "https://storage.live.com/?token=capability",
    "https://login.microsoftonline.com/path?token=capability",
    "https://graph.microsoft.com/v1.0/content?token=capability",
    "https://tenant.sharepoint.com/sites/photos?token=capability",
    "https://tenant.sharepoint.com/_layouts/15/download.aspx",
    "https://files.1drv.com/path?token=capability",
  ])("rejects attacker-shaped OneDrive media URL %s", async (url) => {
    const harness = createHarness();
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).rejects.toEqual(new DirectMediaError("INVALID_PROVIDER_URL"));
  });

  it.each([
    "https://tenant.sharepoint.com/_layouts/15/download.aspx?UniqueId=capability",
    "https://tenant.sharepoint.com/sites/photos/_layouts/15/download.aspx?share=capability",
    "https://public.dm.files.1drv.com/y4m/file?authkey=capability",
    "https://storage.live.com/items/file?authkey=capability",
    "https://res.cdn.microsoftusercontent.com/download/file?token=capability",
  ])("accepts realistic OneDrive preauthorized media URL %s", async (url) => {
    const harness = createHarness();
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).resolves.toMatchObject({ url });
  });

  it.each([
    "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx.evil?token=capability",
    "https://tenant.sharepoint.com/personal/user/_layouts/15/notdownload.aspx?token=capability",
    "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx/extra?token=capability",
    "https://tenant.sharepoint.com/personal/user/_layouts/15/download%2Easpx%2Eevil?token=capability",
    "https://tenant.sharepoint.com/personal/user/_layouts%2F15%2Fdownload.aspx?token=capability",
    "https://tenant.sharepoint.com/personal/user/_layouts//15/download.aspx?token=capability",
  ])("rejects an inexact SharePoint download handler %s", async (url) => {
    const harness = createHarness();
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).rejects.toEqual(new DirectMediaError("INVALID_PROVIDER_URL"));
  });

  it.each([
    "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?token=capability",
    "https://tenant.sharepoint.com/sites/team/_LAYOUTS/15/DOWNLOAD.ASPX?token=capability",
  ])("accepts an exact case-insensitive SharePoint handler %s", async (url) => {
    const harness = createHarness();
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).resolves.toMatchObject({ url });
  });

  it.each([
    "https://tenant.sharepoint.com/personal/%2e/user/_layouts/15/download.aspx?token=capability",
    "https://tenant.sharepoint.com/personal/%2e%2e/user/_layouts/15/download.aspx?token=capability",
    "https://tenant.sharepoint.com/personal/%2E%2e/user/_layouts/15/download.aspx?token=capability",
    "https://tenant.sharepoint.com/personal/../user/_layouts/15/download.aspx?token=capability",
    "https://tenant.sharepoint.com/personal/%252e%252e/user/_layouts/15/download.aspx?token=capability",
    String.raw`https://tenant.sharepoint.com/personal\..\user\_layouts\15\download.aspx?token=capability`,
    String.raw`https://tenant.sharepoint.com\personal\user\_layouts\15\download.aspx?token=capability`,
    String.raw`https://tenant.sharepoint.com/personal\user/_layouts\15/download.aspx?token=capability`,
  ])("rejects raw SharePoint traversal before URL normalization %s", async (url) => {
    const harness = createHarness();
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).rejects.toEqual(new DirectMediaError("INVALID_PROVIDER_URL"));
  });

  it("does not scan encoded traversal bytes inside the query capability", async () => {
    const harness = createHarness();
    const url =
      "https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?token=%252e%252e%252fopaque";
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).resolves.toMatchObject({ url });
  });

  it("does not scan literal backslash-like sequences inside the query capability", async () => {
    const harness = createHarness();
    const url = String.raw`https://tenant.sharepoint.com/personal/user/_layouts/15/download.aspx?token=opaque\..\capability`;
    harness.oneDrive.mediaResult = { url, expiresAt: harness.expiry };

    await expect(
      harness.media.media(
        harness.auth(),
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-video",
          "video",
        ),
      ),
    ).resolves.toMatchObject({ url });
  });

  it("returns unavailable for an authenticated Graph thumbnail URL", async () => {
    const harness = createHarness();
    harness.oneDrive.thumbnailResults.set("onedrive-image", {
      url: "https://graph.microsoft.com/v1.0/me/drive/items/item/content?token=capability",
      expiresAt: harness.expiry,
    });

    const result = await harness.media.thumbnails(
      harness.auth(),
      [
        harness.handle(
          "source-onedrive",
          "root-onedrive",
          "onedrive-image",
          "image",
        ),
      ],
      720,
    );

    expect(result.items).toEqual([
      {
        itemId: harness.itemId("source-onedrive", "onedrive-image"),
        status: "unavailable",
      },
    ]);
  });

  it("uses intrinsic Date state instead of an overridden getTime method", async () => {
    const harness = createHarness();
    class TrickyDate extends Date {
      override getTime(): number {
        return Number.NaN;
      }
    }
    const expiresAt = new TrickyDate(harness.expiry);
    harness.google.mediaResult = {
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      headers: { authorization: "Bearer access-token" },
      expiresAt,
    } as AuthenticatedMediaRequest;

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
    ).resolves.toMatchObject({
      expiresAt: harness.expiry.toISOString(),
    });
  });

  it("rejects an object inheriting from Date without valid internal Date state", async () => {
    const harness = createHarness();
    const fakeDate = Object.create(Date.prototype) as Date;
    harness.google.mediaResult = {
      url: "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
      headers: { authorization: "Bearer access-token" },
      expiresAt: fakeDate,
    } as AuthenticatedMediaRequest;

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

function createHarness(currentNow: () => Date = () => new Date(TEST_NOW)) {
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
    currentNow,
  );
  const google = new MediaProviderHarness(
    "google",
    "https://www.googleapis.com/drive/v3/files/google-video?alt=media&supportsAllDrives=true",
    "https://lh3.googleusercontent.com/google-image=s720",
    expiry,
  );
  google.thumbnailResults.set("google-video", {
    url: "https://lh3.googleusercontent.com/google-video=s720",
    expiresAt: expiry,
  });
  const oneDrive = new MediaProviderHarness(
    "onedrive",
    "https://public.dm.files.1drv.com/download?capability=1",
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
        sourceId === "source-google" ? "access-token" : "initial-onedrive-access",
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
    now: currentNow,
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
    now: currentNow,
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
    preview: BrowseItemClaims["preview"] = null,
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
      preview,
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
  activeThumbnailCalls = 0;
  maximumConcurrentThumbnailCalls = 0;
  readonly thumbnailInputs: Array<{
    provider: ProviderKind;
    providerNodeId: string;
    kind: "folder" | "image" | "video";
    maxDimension: number;
  }> = [];
  readonly thumbnailTokens: string[] = [];
  readonly mediaTokens: string[] = [];
  readonly thumbnailResults = new Map<string, TemporaryUrl | null>();
  readonly thumbnailErrors = new Map<string, unknown>();
  readonly mediaFailures: unknown[] = [];
  mediaResult: TemporaryUrl | AuthenticatedMediaRequest;
  rewriteGoogleMediaToken = true;
  clearThumbnailErrorAfterThrow = false;
  clearThumbnailErrorsAfterThrows = Number.POSITIVE_INFINITY;
  private thumbnailBlocker: Promise<void> | null = null;
  private releaseThumbnailBlocker: (() => void) | null = null;
  private readonly thumbnailCallBlockers = new Map<string, Promise<void>>();
  private readonly releaseThumbnailCallBlockers = new Map<string, () => void>();

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
        this.activeThumbnailCalls += 1;
        this.maximumConcurrentThumbnailCalls = Math.max(
          this.maximumConcurrentThumbnailCalls,
          this.activeThumbnailCalls,
        );
        this.thumbnailTokens.push(input.credentials.accessToken);
        this.thumbnailInputs.push({
          provider: this.provider,
          providerNodeId: input.providerNodeId,
          kind: input.kind,
          maxDimension: input.maxDimension,
        });
        try {
          if (this.thumbnailBlocker) await this.thumbnailBlocker;
          const callBlocker = this.thumbnailCallBlockers.get(input.providerNodeId);
          if (callBlocker) await callBlocker;
          const error = this.thumbnailErrors.get(input.providerNodeId);
          if (error !== undefined) {
            if (this.clearThumbnailErrorAfterThrow) {
              this.thumbnailErrors.delete(input.providerNodeId);
            } else if (this.clearThumbnailErrorsAfterThrows <= 0) {
              this.thumbnailErrors.delete(input.providerNodeId);
            } else {
              this.clearThumbnailErrorsAfterThrows -= 1;
            }
            throw error;
          }
          return this.thumbnailResults.get(input.providerNodeId) ?? null;
        } finally {
          this.activeThumbnailCalls -= 1;
        }
      },
      getMediaUrl: async (input) => {
        this.calls += 1;
        this.mediaTokens.push(input.credentials.accessToken);
        const failure = this.mediaFailures.shift();
        if (failure !== undefined) throw failure;
        if (this.provider === "google" && this.rewriteGoogleMediaToken) {
          return {
            ...this.mediaResult,
            headers: { authorization: `Bearer ${input.credentials.accessToken}` },
          };
        }
        return this.mediaResult;
      },
    };
  }

  blockThumbnailCalls(): () => void {
    if (this.thumbnailBlocker) throw new Error("Thumbnail calls are already blocked.");
    this.thumbnailBlocker = new Promise<void>((resolve) => {
      this.releaseThumbnailBlocker = resolve;
    });
    return () => {
      this.releaseThumbnailBlocker?.();
      this.releaseThumbnailBlocker = null;
      this.thumbnailBlocker = null;
    };
  }

  blockThumbnailCall(providerNodeId: string): () => void {
    if (this.thumbnailCallBlockers.has(providerNodeId)) {
      throw new Error(`Thumbnail call is already blocked: ${providerNodeId}`);
    }
    const blocker = new Promise<void>((resolve) => {
      this.releaseThumbnailCallBlockers.set(providerNodeId, resolve);
    });
    this.thumbnailCallBlockers.set(providerNodeId, blocker);
    return () => {
      this.releaseThumbnailCallBlockers.get(providerNodeId)?.();
      this.releaseThumbnailCallBlockers.delete(providerNodeId);
      this.thumbnailCallBlockers.delete(providerNodeId);
    };
  }
}

function unexpected(operation: string): never {
  throw new Error(`Unexpected provider operation: ${operation}`);
}
