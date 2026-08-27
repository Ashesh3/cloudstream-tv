import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderNode,
  type ProviderRegistry
} from "@cloudframe/providers";
import {
  LiveBrowseError,
  createBrowseHandleCodec,
  createLiveBrowseService,
  type AuthenticatedControlDevice,
  type CredentialBroker
} from "@cloudframe/server";
import { describe, expect, it } from "vitest";

import {
  TEST_NOW,
  testAeadKeyring,
  testControlDevice,
  testControlDocument
} from "./helpers/control-plane";

const credentials = (accessToken: string): ProviderCredentials => ({
  accessToken,
  refreshToken: null,
  accessTokenExpiresAt: new Date(TEST_NOW.getTime() + 60 * 60_000)
});

function node(
  providerNodeId: string,
  name: string,
  parentProviderId: string | null,
  kind: ProviderNode["kind"] = "folder"
): ProviderNode {
  return {
    providerNodeId,
    parentProviderId,
    name,
    kind,
    mimeType: kind === "folder" ? null : `${kind}/synthetic`,
    size: kind === "folder" ? null : 1_024,
    width: kind === "folder" ? null : 1_920,
    height: kind === "folder" ? null : 1_080,
    capturedAt: kind === "folder" ? null : new Date("2026-08-20T10:00:00.000Z"),
    createdAt: new Date("2026-08-19T10:00:00.000Z"),
    modifiedAt: new Date("2026-08-21T10:00:00.000Z"),
    thumbnailRevision: kind === "folder" ? null : "thumb-7",
    hasPreview: kind !== "folder"
  };
}

function unexpected(operation: string): never {
  throw new Error(`Unexpected provider operation: ${operation}`);
}

class ProviderHarness {
  folderItems: ProviderNode[] = [
    node("folder-z", "Zoo", "provider-trips"),
    node("image-new", "New.jpg", "provider-trips", "image"),
    node("folder-a", "albums", "provider-trips"),
    {
      ...node("video-old", "Old.mp4", "provider-trips", "video"),
      capturedAt: new Date("2025-01-01T00:00:00.000Z")
    }
  ];
  nextCursor: string | null = "raw-provider-cursor";
  listFolderCalls = 0;
  registryCalls = 0;
  listFolderError: unknown;
  failListFolderOnce: unknown;
  registryError: unknown;
  readonly inputs: Array<{
    accessToken: string;
    folderId: string;
    cursor: string | null;
    pageSize: number;
  }> = [];

  readonly adapter: ProviderAdapter = {
    beginAuthorization: async () => unexpected("beginAuthorization"),
    completeAuthorization: async () => unexpected("completeAuthorization"),
    refreshCredentials: async () => unexpected("refreshCredentials"),
    getRoot: async () => unexpected("getRoot"),
    getNode: async () => unexpected("getNode"),
    listFolder: async (input) => {
      this.listFolderCalls += 1;
      this.inputs.push({
        accessToken: input.credentials.accessToken,
        folderId: input.folderId,
        cursor: input.cursor,
        pageSize: input.pageSize
      });
      if (this.failListFolderOnce !== undefined) {
        const error = this.failListFolderOnce;
        this.failListFolderOnce = undefined;
        throw error;
      }
      if (this.listFolderError !== undefined) throw this.listFolderError;
      return {
        items: structuredClone(this.folderItems),
        nextCursor: this.nextCursor
      };
    },
    getThumbnailUrl: async () => unexpected("getThumbnailUrl"),
    getMediaUrl: async () => unexpected("getMediaUrl")
  };
}

function createHarness(document = testControlDocument()) {
  let now = new Date(TEST_NOW);
  const activeDocument = structuredClone(document);
  const provider = new ProviderHarness();
  let credentialGets = 0;
  let credentialRefreshes = 0;
  const broker: CredentialBroker = {
    async get() {
      credentialGets += 1;
      return credentials("initial-access");
    },
    async refresh() {
      credentialRefreshes += 1;
      return credentials("refreshed-access");
    }
  };
  const providers: ProviderRegistry = {
    get(providerKind) {
      provider.registryCalls += 1;
      expect(providerKind).toBe("google");
      if (provider.registryError !== undefined) throw provider.registryError;
      return provider.adapter;
    }
  };
  const codec = createBrowseHandleCodec(
    testAeadKeyring(),
    "browse-id-secret",
    () => new Date(now)
  );
  const service = createLiveBrowseService({
    handles: codec,
    credentialBroker: broker,
    providers,
    now: () => new Date(now)
  });

  function auth(deviceId = "device-1"): AuthenticatedControlDevice {
    const device = activeDocument.devices[deviceId]!;
    return {
      householdId: activeDocument.householdId,
      deviceId,
      sessionVersion: device.sessionVersion,
      device: structuredClone(device),
      context: {
        document: activeDocument,
        revision: activeDocument.revision
      }
    };
  }

  return {
    service,
    codec,
    provider,
    document: activeDocument,
    auth,
    setNow(value: Date) {
      now = new Date(value);
    },
    get credentialGets() {
      return credentialGets;
    },
    get credentialRefreshes() {
      return credentialRefreshes;
    },
    get firestoreReads() {
      return 0;
    }
  };
}

async function rootHandle(harness: ReturnType<typeof createHarness>): Promise<string> {
  return (await harness.service.home(harness.auth())).roots[0]!.handle;
}

describe("live TV browsing", () => {
  it("returns only current assigned roots without provider or Firestore calls", async () => {
    const document = testControlDocument();
    document.devices["device-1"].assignedRootIds.push(
      "root-disabled",
      "root-reauth"
    );
    document.roots["root-disabled"] = {
      ...document.roots["root-1"],
      id: "root-disabled",
      displayName: "Disabled",
      enabled: false
    };
    document.sources["source-reauth"] = {
      ...document.sources["source-1"],
      id: "source-reauth",
      providerAccountId: "account-reauth",
      accountLabel: "reauth@example.test",
      status: "reauth-required"
    };
    document.roots["root-reauth"] = {
      ...document.roots["root-1"],
      id: "root-reauth",
      sourceId: "source-reauth",
      providerNodeId: "provider-reauth",
      displayName: "Reauth"
    };
    const harness = createHarness(document);

    const home = await harness.service.home(harness.auth());

    expect(home.roots).toEqual([
      {
        id: expect.stringMatching(/^item_/),
        handle: expect.any(String),
        displayName: "Trips",
        provider: "google",
        accountLabel: "family@example.test"
      }
    ]);
    expect(harness.codec.openItem(home.roots[0]!.handle)).toMatchObject({
      householdId: "h1",
      deviceId: "device-1",
      sourceId: "source-1",
      rootId: "root-1",
      providerNodeId: "provider-trips",
      parentProviderNodeId: null,
      kind: "folder",
      name: "Trips",
      credentialVersion: 1,
      issuedAt: TEST_NOW.getTime(),
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    });
    expect(harness.provider.registryCalls).toBe(0);
    expect(harness.provider.listFolderCalls).toBe(0);
    expect(harness.credentialGets).toBe(0);
    expect(harness.firestoreReads).toBe(0);
    expect(JSON.stringify(home)).not.toMatch(
      /providerNodeId|sourceId|credentialVersion|childMediaCount|readiness/
    );
  });

  it("lists one provider page, sorts it, and signs every supported child", async () => {
    const harness = createHarness();
    const handle = await rootHandle(harness);

    const page = await harness.service.folder(
      harness.auth(),
      handle,
      null,
      50
    );

    expect(harness.provider.listFolderCalls).toBe(1);
    expect(harness.provider.inputs).toEqual([
      {
        accessToken: "initial-access",
        folderId: "provider-trips",
        cursor: null,
        pageSize: 50
      }
    ]);
    expect(page.children.map((item) => item.name)).toEqual([
      "albums",
      "Zoo",
      "New.jpg",
      "Old.mp4"
    ]);
    expect(
      page.children.every(
        (item) => item.id.startsWith("item_") && item.handle.length > 20
      )
    ).toBe(true);
    expect(page.children[2]).toMatchObject({
      name: "New.jpg",
      normalizedName: "new.jpg",
      kind: "image",
      mimeType: "image/synthetic",
      size: 1_024,
      width: 1_920,
      height: 1_080,
      capturedAt: "2026-08-20T10:00:00.000Z",
      createdAtProvider: "2026-08-19T10:00:00.000Z",
      modifiedAtProvider: "2026-08-21T10:00:00.000Z",
      thumbnailRevision: "thumb-7",
      hasPreview: true
    });
    const childClaims = harness.codec.openItem(page.children[0]!.handle);
    expect(childClaims).toMatchObject({
      rootId: "root-1",
      providerNodeId: "folder-a",
      parentProviderNodeId: "provider-trips",
      credentialVersion: 1,
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    });
    expect(JSON.stringify(page)).not.toMatch(
      /providerNodeId|accessToken|raw-provider-cursor|sourceId|rootId/
    );
  });

  it("builds the parent only from the requested handle and renews it", async () => {
    const harness = createHarness();
    const handle = await rootHandle(harness);
    const page = await harness.service.folder(harness.auth(), handle, null, 50);

    expect(page.parent).toEqual({
      id: harness.codec.stableItemId("h1", "source-1", "provider-trips"),
      handle: expect.any(String),
      name: "Trips",
      normalizedName: "trips",
      kind: "folder",
      mimeType: null,
      size: null,
      width: null,
      height: null,
      capturedAt: null,
      createdAtProvider: null,
      modifiedAtProvider: null,
      thumbnailRevision: null,
      hasPreview: false
    });
    expect(harness.codec.openItem(page.parent.handle)).toEqual(
      expect.objectContaining({
        providerNodeId: "provider-trips",
        name: "Trips",
        issuedAt: TEST_NOW.getTime(),
        expiresAt: TEST_NOW.getTime() + 30 * 60_000
      })
    );
  });

  it("keeps the raw provider cursor only inside a folder-bound sealed cursor", async () => {
    const harness = createHarness();
    const handle = await rootHandle(harness);
    const first = await harness.service.folder(harness.auth(), handle, null, 25);

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain("raw-provider-cursor");
    expect(harness.codec.openCursor(first.nextCursor!)).toMatchObject({
      householdId: "h1",
      deviceId: "device-1",
      sourceId: "source-1",
      rootId: "root-1",
      folderProviderNodeId: "provider-trips",
      providerCursor: "raw-provider-cursor",
      credentialVersion: 1,
      expiresAt: TEST_NOW.getTime() + 30 * 60_000
    });

    harness.provider.nextCursor = null;
    await harness.service.folder(
      harness.auth(),
      first.parent.handle,
      first.nextCursor,
      25
    );
    expect(harness.provider.inputs[1]).toMatchObject({
      folderId: "provider-trips",
      cursor: "raw-provider-cursor",
      pageSize: 25
    });
  });

  it("filters malformed, unsupported, and unrelated provider records before signing", async () => {
    const harness = createHarness();
    harness.provider.folderItems.push(
      { ...node("", "Missing ID", "provider-trips") },
      { ...node("document", "Document", "provider-trips"), kind: "document" } as unknown as ProviderNode,
      node("outside", "Outside", "different-parent", "image")
    );

    const page = await harness.service.folder(
      harness.auth(),
      await rootHandle(harness),
      null,
      50
    );

    expect(page.children.map((item) => item.name)).not.toEqual(
      expect.arrayContaining(["Missing ID", "Document", "Outside"])
    );
  });

  it.each([0, 101, 1.5])(
    "rejects invalid page size %s before credentials or provider access",
    async (pageSize) => {
      const harness = createHarness();

      await expect(
        harness.service.folder(harness.auth(), "unused", null, pageSize)
      ).rejects.toEqual(new LiveBrowseError("INVALID_PAGE_SIZE"));
      expect(harness.credentialGets).toBe(0);
      expect(harness.provider.registryCalls).toBe(0);
    }
  );

  it("retries one non-definitive access rejection with refreshed credentials", async () => {
    const harness = createHarness();
    harness.provider.failListFolderOnce = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "provider-trips must not escape",
      { retryable: false }
    );

    await harness.service.folder(
      harness.auth(),
      await rootHandle(harness),
      null,
      50
    );

    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.provider.listFolderCalls).toBe(2);
    expect(harness.provider.inputs.map((input) => input.accessToken)).toEqual([
      "initial-access",
      "refreshed-access"
    ]);
  });

  it("does not retry a definitive invalid grant or arbitrary provider failure", async () => {
    for (const error of [
      new ProviderError(
        "PROVIDER_REAUTH_REQUIRED",
        "provider-trips must not escape",
        { retryable: false, reauthReason: "invalid_grant" }
      ),
      new ProviderError(
        "PROVIDER_UNAVAILABLE",
        "provider-trips must not escape",
        { retryable: true }
      )
    ]) {
      const harness = createHarness();
      harness.provider.listFolderError = error;

      await expect(
        harness.service.folder(
          harness.auth(),
          await rootHandle(harness),
          null,
          50
        )
      ).rejects.toMatchObject({ code: error.code });
      await expect(
        harness.service.folder(
          harness.auth(),
          await rootHandle(harness),
          null,
          50
        )
      ).rejects.not.toThrow("provider-trips");
      expect(harness.credentialRefreshes).toBe(0);
      expect(harness.provider.listFolderCalls).toBe(2);
    }
  });

  it("normalizes a missing provider folder to the secret-safe not-found boundary", async () => {
    const harness = createHarness();
    harness.provider.listFolderError = new ProviderError(
      "PROVIDER_NOT_FOUND",
      "provider-trips is missing",
      { retryable: false }
    );

    await expect(
      harness.service.folder(
        harness.auth(),
        await rootHandle(harness),
        null,
        50
      )
    ).rejects.toEqual(new LiveBrowseError("ITEM_NOT_FOUND"));
  });

  it("scrubs raw provider details from unexpected provider failures", async () => {
    const harness = createHarness();
    harness.provider.listFolderError = new Error(
      "provider-trips failed with accessToken=secret"
    );

    await expect(
      harness.service.folder(
        harness.auth(),
        await rootHandle(harness),
        null,
        50
      )
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PROVIDER_BAD_RESPONSE",
        message: "Provider request failed."
      })
    );
  });

  it("scrubs provider registry failures before they cross the TV boundary", async () => {
    const harness = createHarness();
    harness.provider.registryError = new Error("provider-trips registry secret");

    await expect(
      harness.service.folder(
        harness.auth(),
        await rootHandle(harness),
        null,
        50
      )
    ).rejects.toEqual(
      expect.objectContaining({
        code: "PROVIDER_BAD_RESPONSE",
        message: "Provider request failed."
      })
    );
  });
});

describe("live browse authorization", () => {
  it.each([
    ["wrong device", "ITEM_NOT_FOUND"],
    ["unassigned root", "ITEM_NOT_FOUND"],
    ["disabled root", "ITEM_NOT_FOUND"],
    ["disabled source", "ITEM_NOT_FOUND"],
    ["mismatched root source", "ITEM_NOT_FOUND"],
    ["moved root node", "ITEM_NOT_FOUND"],
    ["stale credential", "NAVIGATION_EXPIRED"],
    ["expired handle", "NAVIGATION_EXPIRED"],
    ["revoked device", "DEVICE_UNAUTHORIZED"],
    ["stale device session", "DEVICE_UNAUTHORIZED"]
  ])("fails closed for %s", async (scenario, code) => {
    const harness = createHarness();
    const handle = await rootHandle(harness);
    let auth = harness.auth();

    if (scenario === "wrong device") {
      harness.document.devices["device-2"] = {
        ...testControlDevice("device-2"),
        assignedRootIds: ["root-1"]
      };
      auth = harness.auth("device-2");
    }
    if (scenario === "unassigned root") {
      harness.document.devices["device-1"].assignedRootIds = [];
    }
    if (scenario === "disabled root") {
      harness.document.roots["root-1"].enabled = false;
    }
    if (scenario === "disabled source") {
      harness.document.sources["source-1"].status = "disabled";
    }
    if (scenario === "mismatched root source") {
      harness.document.sources["source-2"] = {
        ...harness.document.sources["source-1"],
        id: "source-2",
        providerAccountId: "account-2"
      };
      harness.document.roots["root-1"].sourceId = "source-2";
    }
    if (scenario === "moved root node") {
      harness.document.roots["root-1"].providerNodeId = "replacement-root";
    }
    if (scenario === "stale credential") {
      harness.document.sources["source-1"].credentialVersion += 1;
    }
    if (scenario === "expired handle") {
      harness.setNow(new Date(TEST_NOW.getTime() + 30 * 60_000));
    }
    if (scenario === "revoked device") {
      harness.document.devices["device-1"].revokedAt = TEST_NOW.toISOString();
    }
    if (scenario === "stale device session") {
      harness.document.devices["device-1"].sessionVersion += 1;
    }

    await expect(
      harness.service.folder(auth, handle, null, 50)
    ).rejects.toEqual(new LiveBrowseError(code as never));
    expect(harness.credentialGets).toBe(0);
    expect(harness.provider.listFolderCalls).toBe(0);
  });

  it("rejects a cursor bound to another folder without calling the provider", async () => {
    const harness = createHarness();
    const first = await harness.service.folder(
      harness.auth(),
      await rootHandle(harness),
      null,
      50
    );
    const childFolder = first.children.find((item) => item.kind === "folder")!;

    await expect(
      harness.service.folder(
        harness.auth(),
        childFolder.handle,
        first.nextCursor,
        50
      )
    ).rejects.toEqual(new LiveBrowseError("ITEM_NOT_FOUND"));
    expect(harness.provider.listFolderCalls).toBe(1);
  });

  it("maps an invalid or expired sealed cursor to navigation expiry", async () => {
    const harness = createHarness();
    const handle = await rootHandle(harness);

    await expect(
      harness.service.folder(harness.auth(), handle, "not-a-cursor", 50)
    ).rejects.toEqual(new LiveBrowseError("NAVIGATION_EXPIRED"));
    expect(harness.credentialGets).toBe(0);
  });

  it("checks the supplied request context instead of loading current state again", async () => {
    const harness = createHarness();
    const auth = harness.auth();
    const handle = await rootHandle(harness);
    auth.context.revision += 1;

    await expect(
      harness.service.folder(auth, handle, null, 50)
    ).rejects.toEqual(new LiveBrowseError("DEVICE_UNAUTHORIZED"));
    expect(harness.firestoreReads).toBe(0);
  });
});
