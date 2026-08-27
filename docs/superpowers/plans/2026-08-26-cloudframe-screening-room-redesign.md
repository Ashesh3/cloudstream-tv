# Cloudframe Screening Room Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Cloudframe's admin and TV interfaces with the Screening Room Ledger system while changing folder selection to live provider browsing and indexing only selected roots with truthful quota/index states.

**Architecture:** Add a provider-folder identity and live folder-browse contract at the shared/provider/server boundary. Source connection stores the provider root but does not create an enabled TV root or launch whole-drive indexing; selecting a live provider folder records trusted provider ancestry, enables the root, and launches an initial root-scoped workflow that materializes the root node and descendants. The admin app becomes a route-level source workbench with a live provider stage and household-program rail, while the TV app inherits the same ledger tokens under Chromium 68 constraints.

**Tech Stack:** TypeScript, React 19, Preact 10, shadcn/radix-nova source components, Tailwind CSS 4 for admin, hand-authored legacy-safe CSS for TV, Hono-style Web API, Google Drive API v3, Microsoft Graph, Firestore, Vercel Workflow SDK 4.8.5, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-26-cloudframe-screening-room-redesign-design.md`

## Global Constraints

- Preserve secure rolling-cookie auth, CSRF enforcement, encrypted provider tokens, server-only Firestore, ancestry authorization, no-store provider URLs, and existing safe logging.
- Google Drive and OneDrive live browse requests are bounded to `1..200` folders per provider page and folders only.
- A connected source with no selected roots must perform zero durable crawl work.
- Only enabled roots and their descendants remain available after initial reconciliation; delta updates outside enabled roots are ignored.
- `provider-empty`, `unselected`, `queued`, `indexing`, `reconciling`, `healthy`, `quota-exhausted`, `reauth-required`, and `provider-error` remain distinct user-visible states.
- The admin app remains keyboard/screen-reader accessible and mobile-first.
- The TV app remains LG webOS 5+/Chromium 68 compatible and within existing `180 KiB` compressed legacy JS and `45 KiB` compressed CSS budgets.
- `WORKFLOW_QUEUE_NAMESPACE` remains absent; Workflow SDK pins remain `workflow@4.8.5` and `@workflow/builders@4.1.10`.
- No new service-account key, browser persistence, media proxy, fabricated folder/media counts, testimonial, or product claim.
- Existing enabled provider-root assignments are never silently deleted; they render as legacy whole-drive selections with a quota warning until the administrator explicitly migrates devices and removes them.

---

## File Structure

### Shared contracts and domain

- Modify `packages/shared/src/contracts.ts` — persist `providerRootId` on `Source` and retain backward-compatible decoding.
- Modify `packages/shared/src/api.ts` — define live provider-folder DTOs, normalized index-state DTO, and create-root-by-provider-ID request.
- Modify `packages/providers/src/types.ts` — add `GetNodeInput` and the exact-node lookup needed to validate an arbitrary selected folder.
- Modify `packages/providers/src/google-drive.ts` and `packages/providers/src/onedrive.ts` — implement bounded `getNode` requests for breadcrumb and ancestry resolution.

### Provider and indexing services

- Modify `packages/server/src/services/sources.ts` — expose provider-root lookup and normalized source index state.
- Modify `packages/server/src/services/oauth.ts` — connect source without an enabled root or automatic full-drive initial sync.
- Create `packages/server/src/services/provider-folders.ts` — live folder browsing, provider ancestry resolution, and selected-root creation.
- Create `packages/server/src/firestore/decode.ts` — apply the `Source.providerRootId ?? null` compatibility default at every Firestore read boundary.
- Modify `packages/indexer/src/orchestrator.ts` — initial crawl strictly from enabled roots and no-op completion with none.
- Modify `packages/indexer/src/batch.ts` — optional enabled-root scope filter for delta changes.
- Modify `packages/server/src/services/indexing.ts` — choose initial versus delta from persisted source/index state and expose a root-selected launch path.
- Modify `packages/server/src/firestore/repository.ts` and `packages/server/src/firestore/memory-repository.ts` — atomic source/root state changes and reset-to-initial transition.

### API and client

- Modify `packages/server/src/http/app.ts` — add `/api/admin/sources/:id/provider-folders`, update root creation, normalize quota errors, and return index state.
- Modify `packages/server/src/http/errors.ts` — add bounded source/index error mappings.
- Modify `apps/admin/src/api/client.ts` — replace `sourceTree` with cursor-based live provider browse and update root payload.

### Admin experience

- Create `apps/admin/src/design/ledger.ts` — status labels, source/index presentation, and nonvisual state helpers.
- Create `apps/admin/src/components/source-workbench.tsx` — full source workbench composition.
- Create `apps/admin/src/components/provider-folder-stage.tsx` — live folder stage, breadcrumbs, paging, loading, and provider-empty state.
- Create `apps/admin/src/components/household-program.tsx` — selected roots, indexing state, TV impact, and removal.
- Create `apps/admin/src/components/index-status.tsx` — reusable state strip/callout.
- Modify `apps/admin/src/components/sources.tsx`, `folder-picker.tsx`, `approval-sheet.tsx`, `requests.tsx`, `devices.tsx`, `settings.tsx`, `login.tsx`, `shell.tsx`, and `app.tsx` — replace the old admin composition and retire the cramped modal.
- Modify `apps/admin/src/styles/app.css` and `apps/admin/components.json` — Screening Room Ledger tokens, type, browser surfaces, and Radix composition.

### TV experience

- Create `apps/tv/src/components/program-status.tsx` — TV-safe indexing/access state.
- Modify `apps/tv/src/app.tsx`, `folder-card.tsx`, `media-card.tsx`, `source-drawer.tsx`, `tv-header.tsx`, `viewer.tsx`, `viewer-overlay.tsx`, `device-request.tsx`, and `waiting-screen.tsx` — replace visual world while preserving focus contracts.
- Modify `apps/tv/src/styles/tokens.css` and `apps/tv/src/styles/app.css` — legacy-safe ledger tokens and remote states.

### Verification and docs

- Modify `tests/provider-contract.test.ts`, `tests/oauth.test.ts`, `tests/indexer.test.ts`, `tests/admin-management-api.test.ts`, `tests/api-contracts.test.ts`, `tests/structured-logging.test.ts`.
- Modify `apps/admin/src/**/*.test.tsx`, `apps/tv/src/**/*.test.tsx`, `e2e/fixtures.ts`, and `e2e/enrollment.spec.ts`; create `e2e/source-workbench.spec.ts`.
- Modify `docs/operations/firebase-vercel-setup.md`, `README.md`, and later generate `DESIGN.md` through Impeccable's documenter after the final review.

---

### Task 1: Add Provider-Root and Live Folder Contracts

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/http.ts`
- Modify: `packages/providers/src/google-drive.ts`
- Modify: `packages/providers/src/onedrive.ts`
- Test: `tests/api-contracts.test.ts`
- Test: `tests/provider-contract.test.ts`

**Interfaces:**
- Produces: `Source.providerRootId: string | null`.
- Produces: `ProviderFolderDto`, `AdminProviderFolderPageResponse`, `SourceIndexStateDto`, and `CreateAssignedRootBody { providerNodeId: string; displayName?: string }`.
- Produces: `ProviderAdapter.listFolder(...)` remains the live browse primitive and returns `Page<ProviderNode>`.
- Produces: `ProviderAdapter.getNode(input: GetNodeInput): Promise<ProviderNode>` for exact server-side folder validation and parent walking.

- [x] **Step 1: Write failing shared-contract tests**

Add to `tests/api-contracts.test.ts`:

```ts
it("encodes provider root identity and normalized source index state", () => {
  const dto = encodeSourceDto({
    ...makeSource(),
    providerRootId: "google-root",
    status: "error",
    lastSyncErrorCode: "RESOURCE_EXHAUSTED"
  }, 1);
  expect(dto).toMatchObject({
    providerRootId: "google-root",
    indexState: { kind: "quota-exhausted", recoverable: true }
  });
});

it("defines live provider folders without indexed media counters", () => {
  const page: AdminProviderFolderPageResponse = {
    source: encodeSourceDto({ ...makeSource(), providerRootId: "root" }, 0),
    current: { providerNodeId: "root", name: "My Drive", parentProviderId: null, assignedRootId: null },
    breadcrumbs: [{ providerNodeId: "root", name: "My Drive", parentProviderId: null, assignedRootId: null }],
    folders: [{ providerNodeId: "photos", name: "Photos", parentProviderId: "root", assignedRootId: null }],
    nextCursor: null
  };
  expect(page.folders[0]).not.toHaveProperty("childMediaCount");
});
```

Add to `tests/provider-contract.test.ts` inside the existing provider matrix:

```ts
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
  expect(requests.at(-1)?.pathname).toContain(
    provider === "google" ? "/drive/v3/files/g-folder-a" : "/v1.0/me/drive/items/o-folder-a"
  );
});
```

- [x] **Step 2: Run the contract tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/api-contracts.test.ts tests/provider-contract.test.ts
```

Expected: FAIL because `providerRootId`, `indexState`, and live provider-folder DTOs do not exist.

- [x] **Step 3: Implement the contracts**

In `packages/shared/src/contracts.ts` add:

```ts
export interface Source extends StoredEntity {
  householdId: EntityId;
  provider: ProviderKind;
  providerAccountId: string | null;
  providerRootId: string | null;
  accountLabel: string;
  encryptedRefreshToken: EncryptedSecret;
  encryptedAccessToken: EncryptedSecret | null;
  accessTokenExpiresAt: Date | null;
  status: SourceStatus;
  deltaCursor: string | null;
  crawlCheckpoint: IndexCheckpoint | null;
  activeWorkflowRunId: string | null;
  syncGeneration: string | null;
  nextSyncAt: Date | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastSyncErrorCode: string | null;
  createdAt: Date;
}
```

In `packages/shared/src/api.ts` add:

```ts
export type SourceIndexStateKind =
  | "unselected"
  | "queued"
  | "indexing"
  | "reconciling"
  | "healthy"
  | "quota-exhausted"
  | "reauth-required"
  | "provider-error";

export interface SourceIndexStateDto {
  kind: SourceIndexStateKind;
  processedNodeCount: number;
  pendingFolderCount: number;
  recoverable: boolean;
  errorCode: string | null;
}

export interface ProviderFolderDto {
  providerNodeId: string;
  parentProviderId: string | null;
  name: string;
  assignedRootId: string | null;
}

export interface AdminProviderFolderPageResponse {
  source: SourceDto;
  current: ProviderFolderDto;
  breadcrumbs: ProviderFolderDto[];
  folders: ProviderFolderDto[];
  nextCursor: string | null;
}

export interface CreateAssignedRootBody {
  providerNodeId: string;
  displayName?: string;
}
```

Change the encoder signature to:

```ts
export function encodeSourceDto(value: Source, enabledRootCount: number): SourceDto {
  return {
    id: value.id,
    provider: value.provider,
    accountLabel: value.accountLabel,
    status: value.status,
    accessTokenExpiresAt: nullableIso(value.accessTokenExpiresAt),
    nextSyncAt: nullableIso(value.nextSyncAt),
    lastSyncStartedAt: nullableIso(value.lastSyncStartedAt),
    lastSyncCompletedAt: nullableIso(value.lastSyncCompletedAt),
    lastSyncErrorCode: value.lastSyncErrorCode,
    indexProgress: value.crawlCheckpoint ? {
      mode: value.crawlCheckpoint.mode,
      processedNodeCount: value.crawlCheckpoint.processedNodeCount,
      pendingFolderCount: value.crawlCheckpoint.pendingProviderFolderIds?.length ?? 0,
      reconciliationActive: value.crawlCheckpoint.mode === "reconcile"
    } : null,
    createdAt: iso(value.createdAt),
    providerRootId: value.providerRootId,
    indexState: encodeSourceIndexState(value, enabledRootCount)
  };
}
```

Change `AdminOverviewDomainResponse` to carry roots before encoding, and map counts deterministically:

```ts
const enabledRootCountBySource = new Map<string, number>();
for (const root of value.roots) {
  if (!root.enabled) continue;
  enabledRootCountBySource.set(root.sourceId, (enabledRootCountBySource.get(root.sourceId) ?? 0) + 1);
}
const sources = value.sources.map(source =>
  encodeSourceDto(source, enabledRootCountBySource.get(source.id) ?? 0)
);
```

Update direct server call sites to pass the enabled-root count from the roots they already load. Do not infer `unselected` from indexed-node counts.

In `packages/providers/src/types.ts` add:

```ts
export interface GetNodeInput {
  credentials: ProviderCredentials;
  providerNodeId: string;
}

export interface ProviderAdapter {
  beginAuthorization(input: AuthorizationInput): Promise<AuthorizationStart>;
  completeAuthorization(input: AuthorizationCallback): Promise<ProviderAccount>;
  refreshCredentials(source: Source): Promise<RefreshedCredentials>;
  getRoot(credentials: ProviderCredentials): Promise<ProviderNode>;
  getNode(input: GetNodeInput): Promise<ProviderNode>;
  listFolder(input: ListFolderInput): Promise<Page<ProviderNode>>;
  getChanges(input: ChangesInput): Promise<ChangesPage>;
  getThumbnailUrl(input: ThumbnailUrlInput): Promise<TemporaryUrl | null>;
  getMediaUrl(input: MediaUrlInput): Promise<TemporaryUrl>;
}
```

Extend `ProviderErrorCode` with `"PROVIDER_NOT_FOUND"`; the shared HTTP helper must map provider `404` responses to this code without including response bodies or tokens.

Google implementation:

```ts
async getNode(input: GetNodeInput) {
  const file = await googleJson<GoogleFile>(
    fetch,
    `${DRIVE_ENDPOINT}/files/${encodeURIComponent(input.providerNodeId)}?fields=${encodeURIComponent(GOOGLE_FILE_FIELDS)}&supportsAllDrives=true`,
    input.credentials.accessToken,
    now
  );
  const node = normalizeGoogleFile(file);
  if (!node) throw new ProviderError("PROVIDER_NOT_FOUND", "Provider item was not found.", { retryable: false });
  return node;
}
```

OneDrive implementation:

```ts
async getNode(input: GetNodeInput) {
  const item = await graphJson<OneDriveItem>(
    fetch,
    `${GRAPH_ENDPOINT}/me/drive/items/${encodeURIComponent(input.providerNodeId)}?$select=${encodeURIComponent(ONEDRIVE_SELECT)}`,
    input.credentials.accessToken,
    now
  );
  const node = normalizeOneDriveItem(item);
  if (!node) throw new ProviderError("PROVIDER_NOT_FOUND", "Provider item was not found.", { retryable: false });
  return node;
}
```

Do not change the generic Firestore decoder in this task; Task 2 introduces a source-specific compatibility decoder. Centralize the `SourceIndexStateDto` mapping in a new exported `encodeSourceIndexState(source, enabledRootCount)` helper.

- [x] **Step 4: Run focused tests and typecheck**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/api-contracts.test.ts tests/provider-contract.test.ts
npm run typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add packages/shared/src/contracts.ts packages/shared/src/api.ts packages/providers/src/types.ts packages/providers/src/http.ts packages/providers/src/google-drive.ts packages/providers/src/onedrive.ts tests/api-contracts.test.ts tests/provider-contract.test.ts
git commit -m "define live provider folder contracts"
```

---

### Task 2: Connect Sources Without Whole-Drive Indexing

**Files:**
- Modify: `packages/shared/src/contracts.ts`
- Create: `packages/server/src/firestore/decode.ts`
- Modify: `packages/server/src/services/sources.ts`
- Modify: `packages/server/src/services/oauth.ts`
- Modify: `packages/server/src/firestore/repository.ts`
- Modify: `packages/server/src/firestore/memory-repository.ts`
- Modify: `deploy/api-entry.ts`
- Test: `tests/oauth.test.ts`
- Test: `tests/repository.test.ts`

**Interfaces:**
- Consumes: `Source.providerRootId` from Task 1.
- Replaces: `ConnectSourceInput { source; root }` and `connectSourceWithRoot(...)` with `connectSource(source: Source): Promise<void>` with no root side effect.
- Produces: `decodeSourceDocument(id, data): Source`, the only decoder used for persisted `Source` documents.
- Removes: `OAuthServiceDependencies.startInitialSync`; indexing is no longer an OAuth concern.
- Produces: newly connected source state `{ status: "healthy", providerRootId, crawlCheckpoint: null, deltaCursor: null }` until roots are chosen.

- [ ] **Step 1: Write failing OAuth behavior tests**

Replace the new-source expectation in `tests/oauth.test.ts` with:

```ts
it("stores provider root identity without assigning or indexing the whole drive", async () => {
  const startInitialSync = vi.fn();
  const service = createOAuthService({ ...dependencies(), startInitialSync });
  const result = await completeNewGoogleConnection(service);
  const source = await repository.getSource(result.sourceId);

  expect(source).toMatchObject({
    providerRootId: "provider-root",
    status: "healthy",
    crawlCheckpoint: null,
    deltaCursor: null
  });
  expect(await repository.listRootsForSource(result.sourceId)).toEqual([]);
  expect(startInitialSync).not.toHaveBeenCalled();
});
```

Add a reconnect test that preserves `providerRootId` and does not restart initial indexing unless enabled roots exist.

Add to `tests/repository.test.ts`:

```ts
it("decodes a pre-redesign source with a null provider root identity", () => {
  const legacy = { ...makeSource() } as Record<string, unknown>;
  delete legacy.providerRootId;
  expect(decodeSourceDocument("source-1", legacy).providerRootId).toBeNull();
});

it("connects a source atomically without creating a root", async () => {
  const source = makeSource();
  await repository.connectSource(source);
  expect(await repository.getSource(source.id)).toEqual(source);
  expect(await repository.listRootsForSource(source.id)).toEqual([]);
});
```

- [ ] **Step 2: Run OAuth/repository tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/oauth.test.ts tests/repository.test.ts
```

Expected: FAIL because OAuth currently creates/enables the provider root, calls `startInitialSync`, and the repository exposes only `connectSourceWithRoot`.

- [ ] **Step 3: Implement source-only connection**

In `packages/server/src/services/sources.ts`, extend `encryptSource` to accept `providerRootId` and initialize new sources as:

```ts
status: "healthy",
providerRootId: input.providerRootId,
deltaCursor: null,
crawlCheckpoint: null,
nextSyncAt: null
```

Replace the shared input contract with:

```ts
export interface ConnectSourceInput {
  source: Source;
}
```

Create `packages/server/src/firestore/decode.ts`:

```ts
import type { Source } from "@cloudframe/shared";
import { decodeFirestoreValue } from "./repository";

export function decodeSourceDocument(
  id: string,
  data: Record<string, unknown> | undefined
): Source {
  const decoded = decodeFirestoreValue({ ...data, id }) as Omit<Source, "providerRootId"> & {
    providerRootId?: string | null;
  };
  return { ...decoded, providerRootId: decoded.providerRootId ?? null };
}
```

Export `decodeFirestoreValue`, use `decodeSourceDocument` in every repository path that reads a `Source` (`getSource`, `listSources`, credential mutation, lease, batch, completion, failure), and mirror the same `providerRootId ?? null` default in `MemoryRepository` copies seeded by tests.

Replace `connectSourceWithRoot` with an atomic source-only create in both repositories:

```ts
async connectSource(source: Source): Promise<void> {
  const reference = this.firestore.collection(COLLECTIONS.sources).doc(source.id);
  await this.firestore.runTransaction(async transaction => {
    if ((await transaction.get(reference)).exists) {
      throw new RepositoryError("ROOT_CONFLICT", "Source already exists");
    }
    transaction.create(reference, source);
  });
}
```

In `packages/server/src/services/oauth.ts`:

```ts
const providerRoot = await providers.get(consumed.provider).getRoot(account.credentials);
source = sourceService.encryptSource({
  ...input,
  providerRootId: providerRoot.providerNodeId
});
await repository.connectSource(source);
// Do not create an AssignedRoot and do not call startInitialSync.
```

Delete the `AssignedRoot`/`assignedRootDocumentId` imports, remove `startInitialSync` from `OAuthServiceDependencies` and destructuring, and remove the corresponding callback from `deploy/api-entry.ts` and OAuth test harnesses.

Fetch and validate `providerRoot` for both new connections and reconnects. On reconnect, set `providerRootId` when the stored legacy value is `null`, otherwise require the live root identity to remain the same; preserve existing enabled roots and call neither `startInitialSync` nor any automatic crawl. Set source status back to `healthy` only when no enabled root is mid-sync; otherwise preserve the current indexing status/checkpoint.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/oauth.test.ts tests/repository.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```powershell
git add packages/shared/src/contracts.ts packages/server/src/firestore/decode.ts packages/server/src/services/sources.ts packages/server/src/services/oauth.ts packages/server/src/firestore/repository.ts packages/server/src/firestore/memory-repository.ts deploy/api-entry.ts tests/oauth.test.ts tests/repository.test.ts
git commit -m "connect sources without whole drive crawl"
```

---

### Task 3: Add Live Provider Folder Browsing

**Files:**
- Create: `packages/server/src/services/provider-folders.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/http/app.ts`
- Modify: `packages/server/src/http/errors.ts`
- Modify: `deploy/api-entry.ts`
- Modify: `apps/admin/src/api/client.ts`
- Test: `tests/admin-management-api.test.ts`
- Test: `tests/structured-logging.test.ts`

**Interfaces:**
- Consumes: `Source.providerRootId`, `ProviderAdapter.getRoot`, `ProviderAdapter.getNode`, `ProviderAdapter.listFolder`, and `SourceService.getUsableCredentials`.
- Produces:

```ts
interface ProviderFolderService {
  browse(input: {
    householdId: string;
    sourceId: string;
    providerFolderId?: string;
    cursor: string | null;
    pageSize: number;
  }): Promise<AdminProviderFolderPageResponse>;
  resolveAncestry(input: {
    householdId: string;
    sourceId: string;
    providerNodeId: string;
  }): Promise<{
    current: ProviderFolderDto;
    breadcrumbs: ProviderFolderDto[];
    ancestryProviderIds: string[];
  }>;
}
```

Define the service-local inputs and error contract in `provider-folders.ts`:

```ts
interface BrowseProviderFoldersInput {
  householdId: string;
  sourceId: string;
  providerFolderId?: string;
  cursor: string | null;
  pageSize: number;
}

interface ResolveProviderAncestryInput {
  householdId: string;
  sourceId: string;
  providerNodeId: string;
}

type ProviderFolderErrorCode =
  | "PROVIDER_ROOT_MISSING"
  | "PROVIDER_FOLDER_REQUIRED"
  | "PROVIDER_ANCESTRY_CYCLE"
  | "PROVIDER_FOLDER_OUTSIDE_SOURCE";

class ProviderFolderError extends Error {
  constructor(readonly code: ProviderFolderErrorCode, message: string) {
    super(message);
    this.name = "ProviderFolderError";
  }
}
```

- Produces API: `GET /api/admin/sources/:sourceId/provider-folders?providerFolderId=&cursor=&limit=100`.
- Produces `ApiAppDependencies.providerFolders: ProviderFolderService` and wires it from the production entry point with the same repository/provider/source-service instances.

- [ ] **Step 1: Write failing API tests for unindexed live folders**

Add to `tests/admin-management-api.test.ts`:

```ts
it("browses live provider folders before any metadata is indexed", async () => {
  const source = makeSource(harness.householdId, harness.now, {
    providerRootId: "root",
    status: "healthy"
  });
  await harness.repository.putSource(source);
  const listFolder = vi.fn().mockResolvedValue({
    items: [folder("photos", "Photos", "root")],
    nextCursor: null
  });
  const app = createApiApp({ ...deps, providerFolders: makeProviderFolderService({ listFolder }) });

  const response = await app(jsonRequest(
    `/api/admin/sources/${source.id}/provider-folders?limit=100`,
    "GET",
    undefined,
    admin.headers
  ));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    data: {
      current: { providerNodeId: "root", name: "My Drive" },
      folders: [{ providerNodeId: "photos", name: "Photos", assignedRootId: null }]
    }
  });
  expect(await harness.repository.listNodesForSource(source.id)).toEqual([]);
});
```

Add cases for paging, provider-empty, reauth-required, throttling with `retryAfterSeconds`, and secret-safe logs.

Add an ancestry-integrity case:

```ts
it("rejects a folder that cannot be proven to descend from the connected provider root", async () => {
  getNode.mockResolvedValue(folder("outside", "Outside", "foreign-root"));
  await expect(providerFolders.resolveAncestry({
    householdId: harness.householdId,
    sourceId: source.id,
    providerNodeId: "outside"
  })).rejects.toMatchObject({ code: "PROVIDER_FOLDER_OUTSIDE_SOURCE" });
});
```

- [ ] **Step 2: Run API/logging tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/admin-management-api.test.ts tests/structured-logging.test.ts
```

Expected: FAIL because the endpoint and service do not exist.

- [ ] **Step 3: Implement `createProviderFolderService`**

In `provider-folders.ts`:

```ts
export function createProviderFolderService(dependencies: {
  repository: AppRepository;
  providers: ProviderRegistry;
  sourceService: SourceService;
}) {
  async function browse(input: BrowseProviderFoldersInput) {
    const source = await requireSource(input.householdId, input.sourceId);
    const credentials = await dependencies.sourceService.getUsableCredentials(source.id, source.householdId);
    const currentId = input.providerFolderId ?? source.providerRootId;
    if (!currentId) throw new ProviderFolderError("PROVIDER_ROOT_MISSING", "Reconnect this source.");
    const current = currentId === source.providerRootId
      ? await dependencies.providers.get(source.provider).getRoot(credentials)
      : (await resolveAncestry({
          householdId: input.householdId,
          sourceId: input.sourceId,
          providerNodeId: currentId
        })).current;
    const resolved = await resolveAncestry({
      householdId: input.householdId,
      sourceId: input.sourceId,
      providerNodeId: current.providerNodeId
    });
    const page = await dependencies.providers.get(source.provider).listFolder({
      credentials,
      folderId: current.providerNodeId,
      cursor: input.cursor,
      pageSize: input.pageSize
    });
    const roots = await dependencies.repository.listRootsForSource(source.id);
    const rootByProviderId = new Map(roots.filter(root => root.enabled).map(root => [root.providerNodeId, root.id]));
    return {
      source: encodeSourceDto(source, roots.filter(root => root.enabled).length),
      current: folderDto(current, rootByProviderId),
      breadcrumbs: resolved.breadcrumbs.map(folder => ({
        ...folder,
        assignedRootId: rootByProviderId.get(folder.providerNodeId) ?? null
      })),
      folders: page.items.filter(item => item.kind === "folder").map(item => folderDto(item, rootByProviderId)),
      nextCursor: page.nextCursor
    };
  }

  async function resolveAncestry(input: ResolveProviderAncestryInput) {
    const source = await requireSource(input.householdId, input.sourceId);
    const credentials = await dependencies.sourceService.getUsableCredentials(source.id, source.householdId);
    if (!source.providerRootId) throw new ProviderFolderError("PROVIDER_ROOT_MISSING", "Reconnect this source.");
    const adapter = dependencies.providers.get(source.provider);
    const visited = new Set<string>();
    const reversed: ProviderNode[] = [];
    let current = await adapter.getNode({ credentials, providerNodeId: input.providerNodeId });
    for (let depth = 0; depth < 256; depth += 1) {
      if (current.kind !== "folder") throw new ProviderFolderError("PROVIDER_FOLDER_REQUIRED", "Choose a folder.");
      if (visited.has(current.providerNodeId)) throw new ProviderFolderError("PROVIDER_ANCESTRY_CYCLE", "Provider folder ancestry is invalid.");
      visited.add(current.providerNodeId);
      reversed.push(current);
      if (current.providerNodeId === source.providerRootId) {
        const chain = reversed.reverse();
        return {
          current: folderDto(chain.at(-1)!, new Map()),
          breadcrumbs: chain.map(node => folderDto(node, new Map())),
          ancestryProviderIds: chain.slice(0, -1).map(node => node.providerNodeId)
        };
      }
      if (!current.parentProviderId) break;
      current = await adapter.getNode({ credentials, providerNodeId: current.parentProviderId });
    }
    throw new ProviderFolderError("PROVIDER_FOLDER_OUTSIDE_SOURCE", "This folder is not inside the connected account.");
  }
  return { browse, resolveAncestry };
}
```

`browse` uses the resolver's returned breadcrumbs rather than trusting any browser-supplied trail. Do not persist live-browse pages to Firestore. Cache no provider node beyond the lifetime of the request.

- [ ] **Step 4: Add HTTP route and admin client method**

Extend `ApiAppDependencies`:

```ts
providerFolders?: Pick<ProviderFolderService, "browse" | "resolveAncestry">;
```

In `deploy/api-entry.ts`:

```ts
const providerFolders = createProviderFolderService({ repository, providers, sourceService });
return createApiApp({
  repository,
  browse,
  mediaUrls,
  indexing,
  oauth,
  providerFolders,
  config
});
```

Add to `AdminApi`:

```ts
providerFolders(
  sourceId: string,
  input: { providerFolderId?: string; cursor?: string | null; limit?: number }
): Promise<AdminProviderFolderPageResponse>;
```

Build query parameters with `URLSearchParams`. Map `ProviderError` to safe `409/429/503` responses and include bounded retry seconds where present.

Use this exact status mapping in `normalizeHttpError`:

```ts
const providerStatus = error.code === "PROVIDER_REAUTH_REQUIRED" ? 409
  : error.code === "PROVIDER_NOT_FOUND" ? 404
  : error.code === "PROVIDER_THROTTLED" ? 429
  : error.code === "PROVIDER_TIMEOUT" || error.code === "PROVIDER_UNAVAILABLE" ? 503
  : 502;
```

`ProviderFolderError` maps missing/outside/folder-required conditions to `409` or `400` with generic, token-free messages.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/admin-management-api.test.ts tests/structured-logging.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/server/src/services/provider-folders.ts packages/server/src/index.ts packages/server/src/http/app.ts packages/server/src/http/errors.ts deploy/api-entry.ts apps/admin/src/api/client.ts tests/admin-management-api.test.ts tests/structured-logging.test.ts
git commit -m "add live provider folder browsing"
```

---

### Task 4: Materialize Selected Roots and Launch Root-Scoped Initial Sync

**Files:**
- Modify: `packages/server/src/services/provider-folders.ts`
- Modify: `packages/server/src/services/indexing.ts`
- Modify: `packages/server/src/firestore/repository.ts`
- Modify: `packages/server/src/firestore/memory-repository.ts`
- Modify: `packages/server/src/http/app.ts`
- Modify: `deploy/api-entry.ts`
- Test: `tests/admin-management-api.test.ts`
- Test: `tests/repository.test.ts`
- Test: `tests/indexer.test.ts`

**Interfaces:**
- Consumes: `ProviderFolderService.resolveAncestry` from Task 3.
- Produces:

```ts
createRootFromProvider(input: {
  householdId: string;
  sourceId: string;
  providerNodeId: string;
  displayName?: string;
}): Promise<{ root: AssignedRoot; started: boolean; runId?: string }>;
```

`ApiAppDependencies.providerFolders` now consumes the full `ProviderFolderService`, including `createRootFromProvider`; production wiring remains in `deploy/api-entry.ts`.

- Produces repository method:

```ts
enableRootAndResetInitial(input: {
  root: AssignedRoot;
  sourceId: string;
  resetAt: Date;
}): Promise<AssignedRoot>;
```

- [ ] **Step 1: Write failing selected-root tests**

Add to `tests/admin-management-api.test.ts`:

```ts
it("creates a root from a live provider folder and launches initial indexing", async () => {
  const response = await app(jsonRequest(
    `/api/admin/sources/${source.id}/roots`,
    "POST",
    { providerNodeId: "photos", displayName: "Family photos" },
    mutationHeaders(harness.origin, admin)
  ));
  expect(response.status).toBe(201);
  expect(resolveAncestry).toHaveBeenCalledWith(expect.objectContaining({ providerNodeId: "photos" }));
  expect(indexing.startSource).toHaveBeenCalledWith(source.id, "initial");
  expect(await repository.getRoot(assignedRootDocumentId(household.id, source.id, "photos")))
    .toMatchObject({ enabled: true, ancestryProviderIds: ["root"] });
});

it("preserves a legacy whole-drive root until the administrator removes it", async () => {
  await repository.putRoot(makeRoot({ providerNodeId: source.providerRootId!, enabled: true }));
  const roots = await repository.listRootsForSource(source.id);
  expect(roots).toContainEqual(expect.objectContaining({
    providerNodeId: source.providerRootId,
    enabled: true
  }));
});
```

Add concurrency/re-enable and launch-failure rollback tests in `tests/repository.test.ts`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/admin-management-api.test.ts tests/repository.test.ts tests/indexer.test.ts
```

Expected: FAIL because root creation requires an indexed node and does not launch initial sync.

- [ ] **Step 3: Implement atomic root enable/reset**

`enableRootAndResetInitial` must:

1. create or re-enable the deterministic root;
2. reset source to `status: "syncing"`, `deltaCursor: null`, `crawlCheckpoint: null`, `lastSyncErrorCode: null`, `nextSyncAt: null`;
3. preserve encrypted credentials and source identity; and
4. remain idempotent under duplicate requests.

If the selected folder is nested, do not pre-write `MediaNode` documents for its provider ancestors. Persist only the `AssignedRoot.ancestryProviderIds`; the initial orchestrator's synthetic root node uses `parentProviderId: null`, so TV authorization begins at the selected root and no unselected provider folder becomes browseable.

- [ ] **Step 4: Change root API to provider identity**

In `createRoot`, validate `providerNodeId`, call `resolveAncestry`, create the deterministic root, invoke `enableRootAndResetInitial`, then call `indexing.startSource(sourceId, "initial")`. Return:

```ts
{ root: encodeAssignedRootDto(saved), indexing: { started, runId: runId ?? null } }
```

If workflow launch fails after persistence, leave the root enabled and source state `queued`/recoverable; return a safe 503 with a retry action rather than deleting the selection.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/admin-management-api.test.ts tests/repository.test.ts tests/indexer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/server/src/services/provider-folders.ts packages/server/src/services/indexing.ts packages/server/src/firestore/repository.ts packages/server/src/firestore/memory-repository.ts packages/server/src/http/app.ts deploy/api-entry.ts tests/admin-management-api.test.ts tests/repository.test.ts tests/indexer.test.ts
git commit -m "index only selected provider roots"
```

---

### Task 5: Scope Initial, Delta, and Reconciliation Work to Enabled Roots

**Files:**
- Create: `packages/shared/src/index-state.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/indexer/src/orchestrator.ts`
- Modify: `packages/indexer/src/batch.ts`
- Modify: `packages/indexer/src/reconcile.ts`
- Modify: `packages/server/src/services/indexing.ts`
- Test: `tests/indexer.test.ts`
- Create test: `tests/workflow-runtime.test.ts`

**Interfaces:**
- Consumes: enabled roots from repository.
- Produces: shared `sourceIndexStateKind(source, enabledRootCount)` used by both admin DTO encoding and TV root readiness; export it from `packages/shared/src/index.ts`.
- Produces: `filterDeltaPageToEnabledRoots(page, roots, repository, sourceId): Promise<ChangesPage>`.
- Produces: `chooseSyncMode(source, enabledRootCount): "initial" | "delta"`.

- [ ] **Step 1: Write failing scope tests**

Add to `tests/indexer.test.ts`:

```ts
it("performs no provider crawl when a source has no enabled roots", async () => {
  repository.listRootsForSource.mockResolvedValue([]);
  expect(await orchestrator.runNext("s1", "initial", "owner")).toEqual({ complete: true });
  expect(provider.listFolder).not.toHaveBeenCalled();
});

it("drops delta nodes outside every enabled root", async () => {
  provider.getChanges.mockResolvedValue({
    changes: [
      change(image("inside", "Inside.jpg", "photos")),
      change(image("outside", "Outside.jpg", "unselected"))
    ],
    nextCursor: null,
    deltaCursor: "next"
  });
  await orchestrator.runNext("s1", "delta", "owner");
  expect(await repository.getNodeByProviderId("s1", "inside")).not.toBeNull();
  expect(await repository.getNodeByProviderId("s1", "outside")).toBeNull();
});

it("marks nodes from a removed root unavailable during reconciliation", async () => {
  await seedIndexedRoot(repository, { rootId: "kept", providerNodeId: "photos" });
  await seedIndexedRoot(repository, { rootId: "removed", providerNodeId: "movies" });
  await repository.disableRoot({ householdId: "h1", rootId: "removed" });
  await runInitialToCompletion(orchestrator, "s1", "owner");
  expect(await repository.getNodeByProviderId("s1", "removed-child"))
    .toMatchObject({ available: false });
});

it("records Firestore quota exhaustion as a recoverable terminal index state", async () => {
  repository.commitIndexBatch.mockRejectedValue(Object.assign(new Error("Quota exceeded"), { code: 8 }));
  await expect(orchestrator.runNext("s1", "initial", "owner")).rejects.toThrow("Quota exceeded");
  expect(repository.recordSyncFailure).toHaveBeenCalledWith(expect.objectContaining({
    sourceId: "s1",
    status: "error",
    errorCode: "RESOURCE_EXHAUSTED",
    nextSyncAt: null
  }));
});
```

Add service cases in `tests/indexer.test.ts` proving manual **Sync now** and due-source launches select `initial`, `reconcile`, or `delta` from persisted state instead of trusting a hard-coded caller mode.

- [ ] **Step 2: Run indexer tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/indexer.test.ts
```

Expected: FAIL because delta currently persists every provider change and no-root initial transitions through reconciliation rather than cleanly completing.

- [ ] **Step 3: Implement root-scoped orchestration**

Move the status-only normalization to `packages/shared/src/index-state.ts`:

```ts
export function sourceIndexStateKind(
  source: Source,
  enabledRootCount: number
): SourceIndexStateKind {
  if (source.status === "reauth-required") return "reauth-required";
  if (source.lastSyncErrorCode === "RESOURCE_EXHAUSTED") return "quota-exhausted";
  if (source.status === "error") return "provider-error";
  if (enabledRootCount === 0) return "unselected";
  if (!source.activeWorkflowRunId && !source.crawlCheckpoint && !source.deltaCursor) return "queued";
  if (source.crawlCheckpoint?.mode === "reconcile") return "reconciling";
  if (source.crawlCheckpoint?.mode === "initial" || source.status === "syncing") return "indexing";
  return "healthy";
}
```

`encodeSourceIndexState` adds counts/recovery metadata around this shared kind; `browse.home` uses the same kind to derive `preparing`, `blocked`, or `ready`.

In `orchestrator.ts`:

```ts
const enabledRoots = (await repository.listRootsForSource(sourceId)).filter(root => root.enabled);
if (mode === "initial" && enabledRoots.length === 0) {
  await finishSource(repository, sourceId, leaseOwner, now());
  return { complete: true };
}
```

For delta pages, load enabled roots and existing indexed ancestry, filter additions/moves outside enabled roots, but still process removals for existing indexed nodes.

In `batch.ts`, implement the filter before `runIndexBatch` conversion:

```ts
export async function filterDeltaPageToEnabledRoots(
  page: ChangesPage,
  roots: Array<{ providerNodeId: string }>,
  repository: Pick<IndexBatchRepository, "getNodeByProviderId">,
  sourceId: string
): Promise<ChangesPage> {
  const rootIds = new Set(roots.map(root => root.providerNodeId));
  const acceptedProviderIds = new Set<string>(rootIds);
  const acceptedChanges = [];

  for (const change of page.changes) {
    const existing = await repository.getNodeByProviderId(sourceId, change.providerNodeId);
    if (change.removed) {
      if (existing) acceptedChanges.push(change);
      continue;
    }
    const parentId = change.node?.parentProviderId ?? null;
    const indexedParent = parentId
      ? await repository.getNodeByProviderId(sourceId, parentId)
      : null;
    const belongs = rootIds.has(change.providerNodeId)
      || (parentId !== null && acceptedProviderIds.has(parentId))
      || (indexedParent?.available ?? false);
    if (belongs) {
      acceptedChanges.push(change);
      acceptedProviderIds.add(change.providerNodeId);
    } else if (existing) {
      acceptedChanges.push({ providerNodeId: change.providerNodeId, removed: true, node: null });
    }
  }
  return { ...page, changes: acceptedChanges };
}
```

This deliberately treats a move out of every selected root as a removal of the existing indexed node; it never materializes an unselected parent with a deterministic placeholder.

In `indexing.ts`:

```ts
export function chooseSyncMode(source: Source, enabledRootCount: number): SyncMode {
  if (enabledRootCount === 0) return "initial";
  if (source.crawlCheckpoint?.mode === "reconcile") return "reconcile";
  if (!source.deltaCursor || source.crawlCheckpoint?.mode === "initial") return "initial";
  return "delta";
}
```

Use it for manual and due-source launches instead of hard-coded delta. A quota or provider error with a completed initial crawl keeps its delta cursor and resumes with `delta`; an unfinished initial checkpoint resumes with `initial`.

`startSource` must load enabled roots before acquiring a lease and compute the effective mode itself:

```ts
async function startSource(sourceId: string, requestedMode?: SyncMode) {
  const source = await dependencies.repository.getSource(sourceId);
  if (!source || source.householdId !== dependencies.householdId) {
    throw new IndexingServiceError("SOURCE_NOT_FOUND", "Source not found.");
  }
  const enabledRootCount = (await dependencies.repository.listRootsForSource(sourceId))
    .filter(root => root.enabled).length;
  const mode = requestedMode === "initial"
    ? "initial"
    : chooseSyncMode(source, enabledRootCount);
  const owner = createOwner();
  const startedAt = now();
  const leased = await dependencies.repository.acquireSyncLease({
    sourceId,
    owner,
    now: startedAt,
    expiresAt: new Date(startedAt.getTime() + 10 * 60 * 1000)
  });
  if (!leased) return { started: false, sourceId };
  try {
    const run = await dependencies.workflowLauncher.start(sourceId, mode, owner);
    const marked = await dependencies.repository.markSyncRunStarted({
      sourceId,
      leaseOwner: owner,
      runId: run.runId,
      startedAt
    });
    return { started: marked, sourceId, ...(marked ? { runId: run.runId } : {}) };
  } catch (error) {
    await dependencies.repository.releaseSyncLease(sourceId, owner);
    throw error;
  }
}
```

`startDueSources` computes the same mode per leased source rather than always launching `"delta"`.

Change `ApiAppDependencies.indexing.startSource` to accept `requestedMode?: SyncMode`; the manual sync route calls `startSource(sourceId)` so the service selects the correct mode. Root creation is the only HTTP path that explicitly requests `"initial"`.

- [ ] **Step 4: Map Firestore quota failures**

Add a shared predicate:

```ts
function isResourceExhausted(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    ("code" in error && ((error as { code?: unknown }).code === 8 || (error as { code?: unknown }).code === "RESOURCE_EXHAUSTED"));
}
```

In the orchestrator catch path, call `recordSyncFailure` for either `ProviderError` or quota exhaustion. Persist `lastSyncErrorCode: "RESOURCE_EXHAUSTED"`, `status: "error"`, and `nextSyncAt: null`. Keep `workflows/sync-source.ts`'s replay-safe one-page step loop unchanged; the test locks that contract so quota mapping remains inside the orchestrator rather than becoming an unbounded workflow-level retry.

Create `tests/workflow-runtime.test.ts`:

```ts
it("keeps each durable workflow step to one orchestrator page", () => {
  const source = readFileSync(new URL("../workflows/sync-source.ts", import.meta.url), "utf8");
  expect(source).toContain('"use step"');
  expect(source).toContain("createServerSyncWorkflowRunner().runNext(sourceId, mode, leaseOwner)");
  expect(source).not.toContain("RESOURCE_EXHAUSTED");
});
```

- [ ] **Step 5: Run indexer and operations tests**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/indexer.test.ts tests/workflow-runtime.test.ts tests/ops-scripts.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/shared/src/index-state.ts packages/shared/src/index.ts packages/indexer/src/orchestrator.ts packages/indexer/src/batch.ts packages/indexer/src/reconcile.ts packages/server/src/services/indexing.ts tests/indexer.test.ts tests/workflow-runtime.test.ts tests/ops-scripts.test.ts
git commit -m "scope sync work to selected roots"
```

---

### Task 6: Build the Admin Live Folder Workbench

**Files:**
- Create: `apps/admin/src/design/ledger.ts`
- Create: `apps/admin/src/components/index-status.tsx`
- Create: `apps/admin/src/components/provider-folder-stage.tsx`
- Create: `apps/admin/src/components/household-program.tsx`
- Create: `apps/admin/src/components/source-workbench.tsx`
- Modify: `apps/admin/src/components/sources.tsx`
- Modify: `apps/admin/src/components/folder-picker.tsx`
- Modify: `apps/admin/src/api/client.ts`
- Test: `apps/admin/src/components/provider-folder-stage.test.tsx`
- Test: `apps/admin/src/components/household-program.test.tsx`
- Test: `apps/admin/src/components/source-workbench.test.tsx`

**Interfaces:**
- Consumes: `AdminApi.providerFolders`, `AdminProviderFolderPageResponse`, `SourceIndexStateDto`.
- Produces: route-level `SourceWorkbench` with no dependency on indexed `MediaNodeDto` for folder selection.

- [ ] **Step 1: Write failing state-distinction tests**

In `provider-folder-stage.test.tsx`:

```tsx
it("shows provider-empty only after a successful live empty response", async () => {
  api.providerFolders.mockResolvedValue(page({ folders: [] }));
  render(<ProviderFolderStage api={api} source={source} />);
  expect(await screen.findByText("This provider folder is empty")).toBeVisible();
  expect(screen.queryByText(/index/i)).not.toBeInTheDocument();
});

it.each([
  ["quota-exhausted", "Cloudframe indexing is paused by Firestore quota"],
  ["indexing", "Indexing selected folders"],
  ["reauth-required", "Reconnect this account"],
  ["provider-error", "Folder listing failed"]
])("renders %s separately", (kind, copy) => {
  render(<IndexStatus state={{ ...baseState, kind }} />);
  expect(screen.getByText(copy)).toBeVisible();
  expect(screen.queryByText("This provider folder is empty")).not.toBeInTheDocument();
});
```

In `source-workbench.test.tsx`, verify breadcrumb navigation, cursor paging, selection, selection persistence after browse, removal impact, and mobile close/back behavior.

- [ ] **Step 2: Run admin component tests and verify RED**

Run:

```powershell
npx vitest run --config apps/admin/vitest.config.ts src/components/provider-folder-stage.test.tsx src/components/household-program.test.tsx src/components/source-workbench.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement ledger presentation helpers**

In `ledger.ts` export:

```ts
export const INDEX_COPY: Record<SourceIndexStateKind, {
  title: string;
  description: string;
  tone: "quiet" | "active" | "warning" | "danger";
  action: "none" | "sync" | "reconnect" | "billing";
}> = {
  unselected: { title: "Choose folders", description: "Connected, with no household folders selected.", tone: "quiet", action: "none" },
  queued: { title: "Indexing queued", description: "Your selected folders are waiting for the durable indexer.", tone: "active", action: "sync" },
  indexing: { title: "Indexing selected folders", description: "Cloudframe is preparing this household program.", tone: "active", action: "none" },
  reconciling: { title: "Refreshing access", description: "Folders outside the current program are being removed from TV access.", tone: "active", action: "none" },
  healthy: { title: "Program ready", description: "Selected folders are indexed and available to approved TVs.", tone: "quiet", action: "sync" },
  "quota-exhausted": { title: "Indexing paused", description: "Firestore quota is exhausted. Choose a smaller program or enable billing, then retry.", tone: "danger", action: "billing" },
  "reauth-required": { title: "Reconnect this account", description: "The cloud provider needs renewed authorization before browsing or indexing can continue.", tone: "warning", action: "reconnect" },
  "provider-error": { title: "Provider unavailable", description: "The cloud provider request failed. Retry now or reconnect if the problem persists.", tone: "warning", action: "sync" }
};

export function providerName(provider: ProviderKind): string;
export function formatIndexMeasure(value: number): string;
```

No infrastructure codes appear without a plain-language explanation.

- [ ] **Step 4: Implement live stage and program rail**

`ProviderFolderStage` owns live page state:

```ts
type BrowseLocation = { providerFolderId?: string; name: string };
const [trail, setTrail] = useState<BrowseLocation[]>([{ name: source.provider === "google" ? "My Drive" : "OneDrive" }]);
const [pages, setPages] = useState<ProviderFolderDto[]>([]);
```

Requirements:

- skeletons while loading;
- abort stale requests when navigation changes;
- append next pages without duplication;
- keyboard-operable folder rows and buttons;
- no modal-in-modal;
- plain provider-empty message only after successful response;
- `Add to household program` calls `createRoot({ providerNodeId })`.

`HouseholdProgram` lists enabled roots with `IndexStatus`, assigned devices, remove impact, and isolated destructive controls.

If an enabled root's `providerNodeId === source.providerRootId`, label it **Entire My Drive** or **Entire OneDrive**, add a **Legacy whole-drive selection** warning, and require the normal impact confirmation before removal. Never auto-replace or auto-disable it.

- [ ] **Step 5: Replace `FolderPicker` entry point**

Keep `folder-picker.tsx` temporarily as a compatibility wrapper:

```tsx
export function FolderPicker(props: FolderPickerProps) {
  return <SourceWorkbench {...props} />;
}
```

Change Sources CTA copy to **Browse & choose folders**.

- [ ] **Step 6: Run focused admin tests**

Run:

```powershell
npx vitest run --config apps/admin/vitest.config.ts src/components/provider-folder-stage.test.tsx src/components/household-program.test.tsx src/components/source-workbench.test.tsx src/components/folder-picker.test.tsx src/app.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/admin/src/design/ledger.ts apps/admin/src/components/index-status.tsx apps/admin/src/components/provider-folder-stage.tsx apps/admin/src/components/household-program.tsx apps/admin/src/components/source-workbench.tsx apps/admin/src/components/sources.tsx apps/admin/src/components/folder-picker.tsx apps/admin/src/api/client.ts apps/admin/src/components/*.test.tsx
git commit -m "build live source folder workbench"
```

---

### Task 7: Replace the Admin Visual World

**Files:**
- Modify: `apps/admin/src/app.tsx`
- Modify: `apps/admin/src/components/shell.tsx`
- Modify: `apps/admin/src/components/login.tsx`
- Modify: `apps/admin/src/components/requests.tsx`
- Modify: `apps/admin/src/components/approval-sheet.tsx`
- Modify: `apps/admin/src/components/devices.tsx`
- Modify: `apps/admin/src/components/sources.tsx`
- Modify: `apps/admin/src/components/settings.tsx`
- Modify: `apps/admin/src/styles/app.css`
- Modify: `apps/admin/src/main.tsx`
- Test: `apps/admin/src/app.test.tsx`
- Test: `apps/admin/src/components/approval-sheet.test.tsx`

**Interfaces:**
- Consumes: ledger helpers/components from Task 6.
- Produces: complete Screening Room Ledger admin surface.

- [ ] **Step 1: Add the direction contract to emitted admin markup**

As the first rendered child of the admin root, emit:

```tsx
{/*
THESIS: Cloud media is programmed like a private screening; refuse generic SaaS dashboard composition.
OWN-WORLD: Projection black, warm program stock, cue orange, hairline seams, ledger type, selective depth.
STORY: Browse the provider live, move folders into the household program, and keep indexing truth attached.
FIRST VIEWPORT: Source truth above; quiet navigation left; live folder stage two-thirds; household program one-third.
FORM: Screening Room Ledger, grounded direction 4, seed b10bdc63; stage-to-program cue movement.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
*/}
```

After production build, grep `dist/admin/index.html` for `b10bdc63`.

- [ ] **Step 2: Write failing admin hierarchy/accessibility assertions**

Update `app.test.tsx` to assert:

- one `h1` per section;
- no “Operations” eyebrow;
- source health and attention list precede decorative metrics;
- mobile bottom navigation has four actions and safe-area padding;
- all async state changes have polite/alert live regions;
- no icon-only button lacks a label.

- [ ] **Step 3: Run admin tests and verify RED**

Run:

```powershell
npx vitest run --config apps/admin/vitest.config.ts src/app.test.tsx src/components/approval-sheet.test.tsx
```

Expected: FAIL against the current dashboard composition.

- [ ] **Step 4: Implement the visual replacement**

Use semantic CSS variables in `app.css`:

```css
:root {
  --projection: #101112;
  --program: #f2efe7;
  --cue: #d96b28;
  --ash: #8b928f;
  --hairline: color-mix(in oklch, var(--program) 18%, transparent);
  --focus: #ffd49c;
}
```

Add exact self-hosted packages in this task:

```powershell
npm install -w @cloudframe/admin @fontsource-variable/instrument-sans @fontsource-variable/archivo-narrow
```

Import Instrument Sans for editorial/body reading and Archivo Narrow for condensed titles from `apps/admin/src/main.tsx`. Recompose existing shadcn primitives; do not introduce nested card walls. Theme text selection, caret, scrollbars, focus rings, disabled/loading/error states, and tabular figures.

- [ ] **Step 5: Update approval and settings flows**

- Approval root rows show provider/account, `IndexStatus`, and affected access.
- Quota-exhausted roots remain assignable with explicit “Content appears after indexing resumes.”
- Settings Library Health uses the same normalized index states and links quota recovery to the operational note, not a fake success state.
- Destructive source/root/device controls remain separated from primary actions.

- [ ] **Step 6: Run admin tests, lint, and build**

Run:

```powershell
npx vitest run --config apps/admin/vitest.config.ts
npm run typecheck
npm run lint
npm run build -w @cloudframe/admin
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add apps/admin/src apps/admin/components.json apps/admin/package.json package-lock.json
git commit -m "replace admin with screening room ledger"
```

---

### Task 8: Replace the TV Visual World Without Breaking Remote Focus

**Files:**
- Modify: `packages/shared/src/api.ts`
- Modify: `packages/server/src/services/browse.ts`
- Create: `apps/tv/src/components/program-status.tsx`
- Modify: `apps/tv/src/app.tsx`
- Modify: `apps/tv/src/components/folder-card.tsx`
- Modify: `apps/tv/src/components/media-card.tsx`
- Modify: `apps/tv/src/components/source-drawer.tsx`
- Modify: `apps/tv/src/components/tv-header.tsx`
- Modify: `apps/tv/src/components/viewer.tsx`
- Modify: `apps/tv/src/components/viewer-overlay.tsx`
- Modify: `apps/tv/src/components/device-request.tsx`
- Modify: `apps/tv/src/components/waiting-screen.tsx`
- Modify: `apps/tv/src/styles/tokens.css`
- Modify: `apps/tv/src/styles/app.css`
- Test: `apps/tv/src/app.test.tsx`
- Test: `apps/tv/src/components/viewer.test.tsx`
- Test: `apps/tv/src/components/source-drawer.test.tsx`

**Interfaces:**
- Consumes: existing TV API and indexed root DTOs; no provider-live API is exposed to TVs.
- Produces: `TvRootCardDto.readiness: "preparing" | "ready" | "blocked"` and `readinessMessage: string` so assigned roots remain visible before the indexed root node exists.
- Produces: `ProgramStatus` for preparing/blocked root states.

- [ ] **Step 1: Write failing TV visual/focus tests**

Add assertions:

```tsx
it("keeps the first approved program as initial focus", async () => {
  renderReadyTv();
  const programs = await screen.findAllByTestId("program-card");
  expect(programs[0]).toHaveAttribute("tabindex", "0");
  expect(screen.getByRole("button", { name: "Manage sources" })).not.toHaveFocus();
});

it("shows unavailable or indexing programs without pretending they are empty", async () => {
  renderReadyTv({ rootState: "indexing" });
  expect(screen.getByText("Preparing this collection")).toBeVisible();
  expect(screen.queryByText("This folder is empty")).not.toBeInTheDocument();
});
```

Keep existing viewer save/restore, arrow-key seeking, back, and source-drawer tests.

Add a server test in `tests/browse-authorization.test.ts`:

```ts
it("keeps an assigned root visible while its first selected-root sync is preparing", async () => {
  await repository.putRoot(makeRoot({ providerNodeId: "photos", enabled: true }));
  await repository.putSource(makeSource({ status: "syncing", crawlCheckpoint: initialCheckpoint() }));
  const response = await browse.home(device, household);
  expect(response.roots).toContainEqual(expect.objectContaining({
    displayName: "Photos",
    nodeId: null,
    readiness: "preparing"
  }));
});
```

- [ ] **Step 2: Run TV tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.core.config.ts apps/tv/src/app.test.tsx apps/tv/src/components/viewer.test.tsx apps/tv/src/components/source-drawer.test.tsx
```

Expected: FAIL on new program semantics.

- [ ] **Step 3: Implement the TV ledger**

Extend the DTO:

```ts
export interface TvRootCardDto {
  id: string;
  sourceId: string;
  displayName: string;
  provider: Source["provider"];
  accountLabel: string;
  nodeId: string | null;
  folderCoverNodeIds: string[];
  childFolderCount: number;
  childMediaCount: number;
  readiness: "preparing" | "ready" | "blocked";
  readinessMessage: string;
}
```

In `browse.home`, do not `continue` when the selected root node has not been materialized yet. Return `preparing` for queued/indexing/reconciling, `blocked` for quota/reauth/provider errors, and `ready` only when the root node exists and is available. Keep folder/media counts at `0` only for `ready`; the TV component must hide them in non-ready states rather than presenting them as authoritative.

- Use legacy-safe CSS only: no `gap`, `min()`, `max()`, `clamp()`, `inset`, `aspect-ratio`, or `color-scheme` without checker-approved fallback.
- The first viewport shows one oversized current collection plus a restrained program row.
- Focus increases brightness, scale, and cue-orange boundary; unfocused items recede without becoming unreadable.
- Viewer chrome appears on interaction and remains manual-focus safe.
- Enrollment/waiting/error states use program-stock panels on projection black and explicit recovery copy.

- [ ] **Step 4: Run TV tests and compatibility checks**

Run:

```powershell
npx vitest run --config vitest.core.config.ts tests/browse-authorization.test.ts apps/tv/src
npm run build -w @cloudframe/tv
node scripts/check-tv-bundle.mjs
npm run check:chromium68
```

Expected: PASS; legacy JS < `180 KiB` gzip and CSS < `45 KiB` gzip.

- [x] **Step 5: Commit**

```powershell
git add packages/shared/src/api.ts packages/server/src/services/browse.ts tests/browse-authorization.test.ts apps/tv/src
git commit -m "replace TV with household screening program"
```

---

### Task 9: Add End-to-End Source Workbench and Recovery Coverage

**Files:**
- Modify: `e2e/fixtures.ts`
- Create: `e2e/source-workbench.spec.ts`
- Modify: `e2e/enrollment.spec.ts`
- Modify: `playwright.config.ts`
- Modify: `tests/e2e-config.test.ts`

**Interfaces:**
- Consumes: new admin API contracts and UI from Tasks 3–8.
- Produces: deterministic synthetic live provider pages and index-state transitions.

- [ ] **Step 1: Extend the E2E fixture**

Add synthetic handlers for:

```ts
providerFolders: {
  root: [{ providerNodeId: "photos", name: "Photos" }, { providerNodeId: "movies", name: "Movies" }],
  photos: [{ providerNodeId: "trips", name: "Trips" }]
},
indexStates: ["unselected", "queued", "indexing", "quota-exhausted", "healthy"]
```

- [ ] **Step 2: Write the failing Playwright journey**

`source-workbench.spec.ts` must:

1. sign in;
2. open Sources;
3. open **Browse & choose folders**;
4. navigate My Drive → Photos;
5. add Trips to the program;
6. observe queued → indexing;
7. switch fixture to quota-exhausted and verify recovery copy;
8. verify provider folders remain browsable;
9. verify mobile full-screen composition; and
10. remove the root with impact confirmation.

- [ ] **Step 3: Run E2E and verify RED**

Run:

```powershell
npm run build:e2e
npx playwright test e2e/source-workbench.spec.ts
```

Expected: FAIL until fixture and UI integration are complete.

- [ ] **Step 4: Finish fixture and responsive behavior**

Implement deterministic transitions, add `source-workbench.spec.ts` to `admin-mobile` and `admin-wide` project matches, and update screenshot expectations only after visual inspection.

- [ ] **Step 5: Run all E2E tests**

Run:

```powershell
npx playwright test
```

Expected: all journeys PASS.

- [ ] **Step 6: Commit**

```powershell
git add e2e playwright.config.ts tests/e2e-config.test.ts
git commit -m "cover live source selection and quota recovery"
```

---

### Task 10: Update Operations, Run Full Verification, and Prepare Impeccable Review

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/firebase-vercel-setup.md`
- Create at finish: `.impeccable/review/desktop.png`
- Create at finish: `.impeccable/review/mobile.png`
- Create at finish: `.impeccable/review/tv-1920.png`
- Create at finish via documenter: `DESIGN.md`

**Interfaces:**
- Consumes: completed implementation and visual direction contract.
- Produces: operational truth, valid review evidence, final design-system documentation.

- [ ] **Step 1: Update operational documentation**

Document:

- source connection no longer indexes the whole drive;
- live folder browse is provider-backed and no-store;
- selected roots launch initial indexing;
- quota-exhausted state and recovery actions;
- current free-tier/billing limitation; and
- a one-time migration procedure: reconnect or run **Sync now** after selecting desired roots, then remove the legacy whole-drive root only after devices are reassigned.

- [ ] **Step 2: Run the complete verification matrix**

Run:

```powershell
npm test
npm run typecheck
npm run lint
npm run build:vercel
node scripts/check-tv-bundle.mjs
npm run check:chromium68
npx playwright test
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run Impeccable detector once**

Run:

```powershell
node .agents/skills/impeccable/scripts/detect.mjs --json apps/admin/src apps/tv/src
```

Fix mechanical findings in one batch. Do not run the detector a second time.

- [ ] **Step 4: Capture one batched visual round**

Create valid screenshots from document top after fonts and motion settle:

- admin desktop `1440x960` → `.impeccable/review/desktop.png`;
- admin mobile Pixel 7 viewport → `.impeccable/review/mobile.png`;
- TV `1920x1080` → `.impeccable/review/tv-1920.png`.

Open each file once and confirm it shows the claimed surface with no blank/loading/incorrect state.

- [ ] **Step 5: Spawn the Impeccable finish reviewer**

Use `impeccable_finish_reviewer` with `fork_turns: "none"` and provide:

- original request and approved answers;
- artifact paths;
- all three screenshot paths;
- direction contract from the spec;
- detector findings;
- QUALITY BAR board/hero for the cutting-bench challenger as the craft bar;
- `F:/Projects/tv-video-ui/.agents/skills/impeccable/reference/craft-floor.md`;
- note: code-led build, no approved comp.

Act exactly on `recapture`, `rebuild`, `fix`, or `ship`. One fix batch and one verdict pass are the normal ceiling.

- [ ] **Step 6: Spawn the Impeccable documenter**

After the final reviewer closes, use `impeccable_documenter` with:

- project root;
- admin/TV artifact paths;
- direction contract;
- `PRODUCT.md`;
- `.agents/skills/impeccable/reference/document.md`;
- boundary: shared Cloudframe system with admin and TV adaptations.

Verify `DESIGN.md` describes the shipped world rather than the discarded dashboard.

- [ ] **Step 7: Commit final documentation and evidence changes**

```powershell
git add README.md docs/operations/firebase-vercel-setup.md DESIGN.md .impeccable/review
git commit -m "document screening room design system"
```

---

## Plan Self-Review

- **Spec coverage:** live provider browsing, selected-root indexing, delta scoping, quota state, full admin replacement, full TV replacement, accessibility, Chromium 68, E2E, review, and documentation each have an explicit task.
- **Placeholder scan:** no `TBD`, `TODO`, “implement later,” or unspecified test step remains.
- **Type consistency:** Task 1 defines `providerRootId`, `SourceIndexStateDto`, `ProviderFolderDto`, `AdminProviderFolderPageResponse`, `GetNodeInput`, and provider-ID root creation; Task 2 defines `decodeSourceDocument`; Task 5 defines `sourceIndexStateKind` and `filterDeltaPageToEnabledRoots`; Tasks 6–10 consume those exact names.
- **Migration safety:** legacy whole-drive roots remain enabled and visible until an administrator explicitly migrates device assignments and removes them.
- **Scope boundary:** billing enablement is explicitly external; implementation provides quota-efficient behavior and honest recovery but does not claim to create Firestore capacity.
