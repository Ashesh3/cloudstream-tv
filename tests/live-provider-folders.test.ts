import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCredentials,
  type ProviderNode,
  type ProviderRegistry,
} from "@cloudframe/providers";
import type { ControlPlaneDocumentV2 } from "@cloudframe/shared";
import {
  LiveProviderFolderConfigurationError,
  LiveProviderFolderError,
  createLiveProviderFolderService,
  type ControlMutationReducer,
  type ControlPlaneStore,
  type CredentialBroker,
} from "@cloudframe/server";
import { describe, expect, it } from "vitest";

import { TEST_NOW, testControlDocument } from "./helpers/control-plane";

const credentials = (accessToken: string): ProviderCredentials => ({
  accessToken,
  refreshToken: null,
  accessTokenExpiresAt: new Date(TEST_NOW.getTime() + 60 * 60_000),
});

function node(
  providerNodeId: string,
  name: string,
  parentProviderId: string | null,
  kind: ProviderNode["kind"] = "folder",
): ProviderNode {
  return {
    providerNodeId,
    parentProviderId,
    name,
    kind,
    mimeType: kind === "folder" ? null : `${kind}/synthetic`,
    size: null,
    width: null,
    height: null,
    capturedAt: null,
    createdAt: null,
    modifiedAt: null,
    thumbnailRevision: null,
    contentRevision: null,
    hasPreview: false,
  };
}

function unexpected(operation: string): never {
  throw new Error(`Unexpected provider operation: ${operation}`);
}

class MemoryStore implements ControlPlaneStore {
  loadCount = 0;
  mutateCount = 0;
  beforeMutate: (() => void) | undefined;

  constructor(public current: ControlPlaneDocumentV2) {}

  async load() {
    this.loadCount += 1;
    return { document: structuredClone(this.current), etag: "unused" };
  }

  async mutate<T>(_name: string, reducer: ControlMutationReducer<T>): Promise<T> {
    this.mutateCount += 1;
    this.beforeMutate?.();
    const mutation = reducer(structuredClone(this.current));
    if (mutation.changed) this.current = structuredClone(mutation.next);
    return structuredClone(mutation.result);
  }
}

class ProviderHarness {
  readonly nodes = new Map<string, ProviderNode>([
    ["provider-root", node("provider-root", "My Drive", null)],
    ["photos", node("photos", "Photos", "provider-root")],
    ["movies", node("movies", "Movies", "provider-root")],
    ["trips", node("trips", "Trips", "albums")],
    ["albums", node("albums", "Albums", "provider-root")],
  ]);
  folderItems: ProviderNode[] = [
    this.nodes.get("photos")!,
    node("cover", "Cover.jpg", "provider-root", "image"),
    this.nodes.get("movies")!,
  ];
  nextCursor: string | null = "next-page";
  getRootCalls = 0;
  getNodeCalls = 0;
  listFolderCalls = 0;
  listFolderCredentials: string[] = [];
  listFolderInputs: Array<{
    folderId: string;
    cursor: string | null;
    pageSize: number;
  }> = [];
  listFolderError: unknown;
  failListFolderOnce: unknown;
  getRootError: unknown;
  onGetNode: ((providerNodeId: string, call: number) => void) | undefined;

  readonly adapter: ProviderAdapter = {
    beginAuthorization: async () => unexpected("beginAuthorization"),
    completeAuthorization: async () => unexpected("completeAuthorization"),
    refreshCredentials: async () => unexpected("refreshCredentials"),
    getRoot: async () => {
      this.getRootCalls += 1;
      if (this.getRootError !== undefined) throw this.getRootError;
      return structuredClone(this.nodes.get("provider-root")!);
    },
    getNode: async ({ providerNodeId }) => {
      this.getNodeCalls += 1;
      this.onGetNode?.(providerNodeId, this.getNodeCalls);
      const value = this.nodes.get(providerNodeId);
      if (!value) {
        throw new ProviderError("PROVIDER_NOT_FOUND", "missing", {
          retryable: false,
        });
      }
      return structuredClone(value);
    },
    listFolder: async (input) => {
      this.listFolderCalls += 1;
      this.listFolderCredentials.push(input.credentials.accessToken);
      this.listFolderInputs.push({
        folderId: input.folderId,
        cursor: input.cursor,
        pageSize: input.pageSize,
      });
      if (this.failListFolderOnce !== undefined) {
        const error = this.failListFolderOnce;
        this.failListFolderOnce = undefined;
        throw error;
      }
      if (this.listFolderError !== undefined) throw this.listFolderError;
      return {
        items: structuredClone(this.folderItems),
        nextCursor: this.nextCursor,
      };
    },
    getThumbnailUrl: async () => unexpected("getThumbnailUrl"),
    getMediaUrl: async () => unexpected("getMediaUrl"),
  };
}

const validRootIdSecret = "r".repeat(32);

function createHarness(
  document = testControlDocument(),
  rootIdSecret = validRootIdSecret,
) {
  const store = new MemoryStore(structuredClone(document));
  const provider = new ProviderHarness();
  const providerRegistry: ProviderRegistry = {
    get(providerKind) {
      expect(providerKind).toBe("google");
      return provider.adapter;
    },
  };
  const activeDocument = structuredClone(document);
  let controlStateCalls = 0;
  let credentialGets = 0;
  let credentialRefreshes = 0;
  const firestoreReads = 0;
  const broker: CredentialBroker = {
    async get() {
      credentialGets += 1;
      return { ...credentials("initial-access"), credentialVersion: 1 };
    },
    async refresh() {
      credentialRefreshes += 1;
      return { ...credentials("refreshed-access"), credentialVersion: 1 };
    },
  };
  const service = createLiveProviderFolderService({
    controlStore: store,
    controlState: () => {
      controlStateCalls += 1;
      return {
        document: activeDocument,
        revision: activeDocument.revision,
      };
    },
    credentialBroker: broker,
    providers: providerRegistry,
    rootIdSecret,
    now: () => new Date(TEST_NOW),
  });

  return {
    service,
    store,
    provider,
    get controlStateCalls() {
      return controlStateCalls;
    },
    get credentialGets() {
      return credentialGets;
    },
    get credentialRefreshes() {
      return credentialRefreshes;
    },
    get firestoreReads() {
      return firestoreReads;
    },
  };
}

describe("live provider folders", () => {
  it.each([
    ["empty", ""],
    ["whitespace", " ".repeat(32)],
    ["31-byte", "x".repeat(31)],
  ])("rejects a %s root ID secret before returning a service", (_case, secret) => {
    expect(() => createHarness(testControlDocument(), secret)).toThrowError(
      new LiveProviderFolderConfigurationError("ROOT_ID_SECRET_INVALID"),
    );
  });

  it("accepts a 32-byte root ID secret", () => {
    expect(() =>
      createHarness(testControlDocument(), "x".repeat(32)),
    ).not.toThrow();
  });

  it("lists provider folders from the API without reading indexed nodes", async () => {
    const document = testControlDocument();
    document.roots["root-1"] = {
      ...document.roots["root-1"],
      providerNodeId: "photos",
      displayName: "Photos",
    };
    const harness = createHarness(document);

    const page = await harness.service.browse({
      householdId: "h1",
      sourceId: "source-1",
      providerFolderId: undefined,
      cursor: null,
      pageSize: 50,
    });

    expect(page.folders.map((folder) => folder.name)).toEqual([
      "Photos",
      "Movies",
    ]);
    expect(page.folders[0]).toMatchObject({ assignedRootId: "root-1" });
    expect(page).toMatchObject({
      source: {
        id: "source-1",
        provider: "google",
        accountLabel: "family@example.test",
        status: "healthy",
      },
      current: { providerNodeId: "provider-root", name: "My Drive" },
      nextCursor: "next-page",
    });
    expect(harness.provider.listFolderCalls).toBe(1);
    expect(harness.provider.getRootCalls).toBe(1);
    expect(harness.provider.getNodeCalls).toBe(0);
    expect(harness.store.loadCount).toBe(0);
    expect(harness.firestoreReads).toBe(0);
    expect(harness.controlStateCalls).toBe(1);
    expect(JSON.stringify(page)).not.toMatch(
      /encrypted|accessToken|refreshToken|providerRootId|credentialVersion/,
    );
  });

  it("saves a selected root immediately without starting a workflow", async () => {
    const document = testControlDocument();
    document.roots = {};
    document.devices["device-1"].assignedRootIds = [];
    const harness = createHarness(document);

    const result = await harness.service.createRoot({
      householdId: "h1",
      sourceId: "source-1",
      providerNodeId: "trips",
    });

    const expectedId =
      "root_B2Yc95KQaJkI3aWPCREB7fETiVsGBh5xefov07urJA0";
    expect(result.root).toEqual({
      id: expectedId,
      sourceId: "source-1",
      displayName: "Trips",
      enabled: true,
      createdAt: TEST_NOW.toISOString(),
    });
    expect(harness.store.current.roots[result.root.id]).toMatchObject({
      providerNodeId: "trips",
      ancestryProviderIds: ["provider-root", "albums"],
      enabled: true,
    });
    expect(harness.store.current.devices["device-1"].assignedRootIds).toEqual([]);
    expect(harness.store.current.revision).toBe(2);
    expect(harness.store.mutateCount).toBe(1);
    expect(harness.store.loadCount).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(
      /runId|started|index|workflow|providerNodeId|ancestryProviderIds/,
    );
  });

  it("falls back to the live folder name when the optional root name is blank", async () => {
    const document = testControlDocument();
    document.roots = {};
    document.devices["device-1"].assignedRootIds = [];
    const harness = createHarness(document);

    const result = await harness.service.createRoot({
      householdId: "h1",
      sourceId: "source-1",
      providerNodeId: "trips",
      displayName: "   ",
    });

    expect(result.root.displayName).toBe("Trips");
  });

  it.each([
    ["wrong household", "other", "source-1", "healthy"],
    ["missing source", "h1", "missing", "healthy"],
    ["disabled source", "h1", "source-1", "disabled"],
  ] as const)(
    "rejects a %s before obtaining credentials or calling the provider",
    async (_case, householdId, sourceId, status) => {
      const document = testControlDocument();
      document.sources["source-1"].status = status;
      const harness = createHarness(document);

      await expect(
        harness.service.browse({
          householdId,
          sourceId,
          cursor: null,
          pageSize: 50,
        }),
      ).rejects.toEqual(new LiveProviderFolderError("SOURCE_NOT_FOUND"));

      expect(harness.credentialGets).toBe(0);
      expect(harness.provider.getRootCalls).toBe(0);
      expect(harness.provider.listFolderCalls).toBe(0);
    },
  );

  it("rejects a source requiring reauthorization before provider browsing", async () => {
    const document = testControlDocument();
    document.sources["source-1"].status = "reauth-required";
    const harness = createHarness(document);

    await expect(
      harness.service.browse({
        householdId: "h1",
        sourceId: "source-1",
        cursor: null,
        pageSize: 50,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(harness.credentialGets).toBe(0);
    expect(harness.provider.getRootCalls).toBe(0);
  });

  it("returns root-first ancestry and rejects cycles, non-folders, and foreign roots", async () => {
    const valid = createHarness();
    await expect(
      valid.service.resolveAncestry({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "trips",
      }),
    ).resolves.toMatchObject({
      current: { providerNodeId: "trips", name: "Trips" },
      breadcrumbs: [
        { providerNodeId: "provider-root" },
        { providerNodeId: "albums" },
        { providerNodeId: "trips" },
      ],
      ancestryProviderIds: ["provider-root", "albums"],
    });

    const cycle = createHarness();
    cycle.provider.nodes.set("a", node("a", "A", "b"));
    cycle.provider.nodes.set("b", node("b", "B", "a"));
    await expect(
      cycle.service.resolveAncestry({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "a",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ANCESTRY_CYCLE" });

    const file = createHarness();
    file.provider.nodes.set("file", node("file", "File", "provider-root", "image"));
    await expect(
      file.service.resolveAncestry({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "file",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FOLDER_REQUIRED" });

    const outside = createHarness();
    outside.provider.nodes.set("outside", node("outside", "Outside", "foreign"));
    outside.provider.nodes.set("foreign", node("foreign", "Foreign", null));
    await expect(
      outside.service.resolveAncestry({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "outside",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FOLDER_OUTSIDE_SOURCE" });
  });

  it("uses the current ancestry proof when browsing a nested folder", async () => {
    const harness = createHarness();

    const page = await harness.service.browse({
      householdId: "h1",
      sourceId: "source-1",
      providerFolderId: "albums",
      cursor: "cursor-1",
      pageSize: 25,
    });

    expect(page.current).toMatchObject({
      providerNodeId: "albums",
      name: "Albums",
    });
    expect(page.breadcrumbs.map((item) => item.providerNodeId)).toEqual([
      "provider-root",
      "albums",
    ]);
    expect(harness.provider.getRootCalls).toBe(1);
    expect(harness.provider.getNodeCalls).toBe(1);
    expect(harness.provider.listFolderCalls).toBe(1);
    expect(harness.provider.listFolderInputs).toEqual([
      { folderId: "albums", cursor: "cursor-1", pageSize: 25 },
    ]);
  });

  it("keeps deterministic root IDs stable and separates ambiguous tuples", async () => {
    const firstDocument = testControlDocument();
    firstDocument.roots = {};
    firstDocument.devices["device-1"].assignedRootIds = [];
    firstDocument.sources.a = {
      ...firstDocument.sources["source-1"],
      id: "a",
    };
    delete firstDocument.sources["source-1"];
    const first = createHarness(firstDocument);
    first.provider.nodes.set("bc", node("bc", "BC", "provider-root"));

    const secondDocument = testControlDocument();
    secondDocument.roots = {};
    secondDocument.devices["device-1"].assignedRootIds = [];
    secondDocument.sources.ab = {
      ...secondDocument.sources["source-1"],
      id: "ab",
    };
    delete secondDocument.sources["source-1"];
    const second = createHarness(secondDocument);
    second.provider.nodes.set("c", node("c", "C", "provider-root"));

    const firstResult = await first.service.createRoot({
      householdId: "h1",
      sourceId: "a",
      providerNodeId: "bc",
    });
    const repeated = await first.service.createRoot({
      householdId: "h1",
      sourceId: "a",
      providerNodeId: "bc",
    });
    const secondResult = await second.service.createRoot({
      householdId: "h1",
      sourceId: "ab",
      providerNodeId: "c",
    });

    expect("h1" + "a" + "bc").toBe("h1" + "ab" + "c");
    expect(repeated.root.id).toBe(firstResult.root.id);
    expect(secondResult.root.id).not.toBe(firstResult.root.id);
  });

  it("rejects ancestry when the provider account root no longer matches the source", async () => {
    const harness = createHarness();
    harness.provider.nodes.set(
      "provider-root",
      node("replacement-root", "Replacement", null),
    );

    await expect(
      harness.service.resolveAncestry({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "trips",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FOLDER_OUTSIDE_SOURCE" });
    expect(harness.provider.getNodeCalls).toBe(0);
  });

  it("stops ancestry resolution after 64 ancestors", async () => {
    const harness = createHarness();
    for (let index = 0; index <= 64; index += 1) {
      harness.provider.nodes.set(
        `deep-${index}`,
        node(`deep-${index}`, `Deep ${index}`, `deep-${index + 1}`),
      );
    }

    await expect(
      harness.service.resolveAncestry({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "deep-0",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_FOLDER_OUTSIDE_SOURCE" });
    expect(harness.provider.getNodeCalls).toBe(64);
  });

  it("accepts exactly 64 stored ancestors including the connected provider root", async () => {
    const document = testControlDocument();
    document.roots = {};
    document.devices["device-1"].assignedRootIds = [];
    const harness = createHarness(document);
    for (let index = 0; index < 64; index += 1) {
      harness.provider.nodes.set(
        `allowed-${index}`,
        node(
          `allowed-${index}`,
          `Allowed ${index}`,
          index === 63 ? "provider-root" : `allowed-${index + 1}`,
        ),
      );
    }

    const result = await harness.service.createRoot({
      householdId: "h1",
      sourceId: "source-1",
      providerNodeId: "allowed-0",
    });

    expect(
      harness.store.current.roots[result.root.id].ancestryProviderIds,
    ).toHaveLength(64);
    expect(
      harness.store.current.roots[result.root.id].ancestryProviderIds[0],
    ).toBe("provider-root");
  });

  it("refreshes credentials once when the provider rejects the current access credential", async () => {
    const harness = createHarness();
    harness.provider.failListFolderOnce = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "expired access credential",
      { retryable: false },
    );

    await harness.service.browse({
      householdId: "h1",
      sourceId: "source-1",
      cursor: null,
      pageSize: 50,
    });

    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.provider.listFolderCredentials).toEqual([
      "initial-access",
      "refreshed-access",
    ]);
  });

  it("uses at most one credential refresh across the complete browse operation", async () => {
    const harness = createHarness();
    harness.provider.getRootError = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "expired access credential",
      { retryable: false },
    );

    await expect(
      harness.service.browse({
        householdId: "h1",
        sourceId: "source-1",
        cursor: null,
        pageSize: 50,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_REAUTH_REQUIRED" });
    expect(harness.credentialRefreshes).toBe(1);
    expect(harness.provider.getRootCalls).toBe(2);
    expect(harness.provider.listFolderCalls).toBe(0);
  });

  it("does not refresh or retry arbitrary provider failures", async () => {
    const harness = createHarness();
    harness.provider.listFolderError = new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "temporarily unavailable",
      { retryable: true },
    );

    await expect(
      harness.service.browse({
        householdId: "h1",
        sourceId: "source-1",
        cursor: null,
        pageSize: 50,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(harness.credentialRefreshes).toBe(0);
    expect(harness.provider.listFolderCalls).toBe(1);
  });

  it("does not retry a definitive provider invalid grant", async () => {
    const harness = createHarness();
    harness.provider.listFolderError = new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "refresh grant is invalid",
      { retryable: false, reauthReason: "invalid_grant" },
    );

    await expect(
      harness.service.browse({
        householdId: "h1",
        sourceId: "source-1",
        cursor: null,
        pageSize: 50,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_REAUTH_REQUIRED",
      reauthReason: "invalid_grant",
    });
    expect(harness.credentialRefreshes).toBe(0);
    expect(harness.provider.listFolderCalls).toBe(1);
  });

  it("normalizes a missing connected provider root as a missing folder", async () => {
    const harness = createHarness();
    harness.provider.getRootError = new ProviderError(
      "PROVIDER_NOT_FOUND",
      "missing",
      { retryable: false },
    );

    await expect(
      harness.service.browse({
        householdId: "h1",
        sourceId: "source-1",
        cursor: null,
        pageSize: 50,
      }),
    ).rejects.toEqual(
      new LiveProviderFolderError("PROVIDER_FOLDER_NOT_FOUND"),
    );
  });

  it("revalidates the source identity in the authoritative root mutation", async () => {
    const document = testControlDocument();
    document.roots = {};
    document.devices["device-1"].assignedRootIds = [];
    const harness = createHarness(document);
    harness.store.beforeMutate = () => {
      harness.store.current.sources["source-1"].providerRootId = "replacement-root";
    };

    await expect(
      harness.service.createRoot({
        householdId: "h1",
        sourceId: "source-1",
        providerNodeId: "trips",
      }),
    ).rejects.toEqual(new LiveProviderFolderError("SOURCE_CHANGED"));
    expect(harness.store.current.roots).toEqual({});
    expect(harness.provider.getNodeCalls).toBe(4);
  });

  it("revalidates a moved folder and saves only the latest ancestry proof", async () => {
    const document = testControlDocument();
    document.roots = {};
    document.devices["device-1"].assignedRootIds = [];
    const harness = createHarness(document);
    harness.provider.onGetNode = (providerNodeId) => {
      if (providerNodeId === "albums") {
        harness.provider.nodes.set("trips", node("trips", "Trips", "photos"));
      }
    };

    const result = await harness.service.createRoot({
      householdId: "h1",
      sourceId: "source-1",
      providerNodeId: "trips",
    });

    expect(
      harness.store.current.roots[result.root.id].ancestryProviderIds,
    ).toEqual(["provider-root", "photos"]);
    expect(harness.provider.getRootCalls).toBe(2);
    expect(harness.provider.getNodeCalls).toBe(4);
  });

  it.each([0, 201, 1.5])(
    "rejects invalid page size %s before reading live state",
    async (pageSize) => {
      const harness = createHarness();

      await expect(
        harness.service.browse({
          householdId: "h1",
          sourceId: "source-1",
          cursor: null,
          pageSize,
        }),
      ).rejects.toEqual(new LiveProviderFolderError("INVALID_PAGE_SIZE"));
      expect(harness.controlStateCalls).toBe(0);
    },
  );
});
