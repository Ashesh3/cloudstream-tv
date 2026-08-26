import type {
  AdminSession,
  ApproveDeviceRequestInput,
  AssignedRoot,
  ConnectSourceInput,
  Device,
  DeviceRequest,
  DeviceSession,
  Household,
  MediaNode,
  OAuthState,
  DisableRootInput,
  RemoveSourceInput,
  RotateAdminPassphraseInput,
  Source,
  SyncLeaseInput,
  UpdateHouseholdSettingsInput,
  WatchHistory
} from "@cloudframe/shared";
import { recomputeFolderMetadata, type IndexBatchCommitInput } from "@cloudframe/indexer";
import {
  RepositoryError,
  assignedRootDocumentId,
  validateDeviceApproval,
  type AppRepository
} from "./repository";
import type {
  AuthenticateAdminSessionInput,
  AuthenticateDeviceSessionInput,
  AuthenticatedAdminSession,
  AuthenticatedDeviceSession,
  RateLimitConsumeInput,
  RateLimitConsumeResult,
  ConsumeOAuthStateInput,
  ResolveDeviceRequestInput,
  UpdateDeviceInput
} from "./repository";
import type { DueSourceLeaseInput, ListWatchHistoryInput } from "./repository";

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryRepository implements AppRepository {
  private households = new Map<string, Household>();
  private adminSessions = new Map<string, AdminSession>();
  private deviceRequests = new Map<string, DeviceRequest>();
  private devices = new Map<string, Device>();
  private deviceSessions = new Map<string, DeviceSession>();
  private sources = new Map<string, Source>();
  private roots = new Map<string, AssignedRoot>();
  private nodes = new Map<string, MediaNode>();
  private history = new Map<string, WatchHistory>();
  private rateLimits = new Map<string, number>();
  private oauthStates = new Map<string, OAuthState>();
  private failIndexCommit = false;

  async getHousehold(id: string) { return this.get(this.households, id); }
  async putHousehold(value: Household) { this.set(this.households, value); }
  async createHouseholdIfAbsent(value: Household) {
    const existing = this.households.get(value.id);
    if (existing) return copy(existing);
    this.set(this.households, value);
    return copy(value);
  }
  async getAdminSessionByHash(hash: string) { return this.find(this.adminSessions, value => value.tokenHash === hash); }
  async putAdminSession(value: AdminSession) { this.set(this.adminSessions, value); }
  async authenticateAdminSession(input: AuthenticateAdminSessionInput): Promise<AuthenticatedAdminSession | null> {
    const session = [...this.adminSessions.values()].find(value => value.tokenHash === input.tokenHash);
    const household = this.households.get(input.householdId);
    if (!session || !household || session.householdId !== input.householdId || session.passphraseVersion !== household.adminPassphraseVersion || session.revokedAt || session.expiresAt <= input.now) return null;
    const renewed = session.expiresAt < input.renewBefore;
    const updated = copy({ ...session, lastSeenAt: input.now, ...(renewed ? { expiresAt: input.renewalExpiresAt } : {}) });
    this.adminSessions.set(session.id, updated);
    return { session: copy(updated), household: copy(household), renewed };
  }
  async revokeAdminSession(sessionId: string, tokenHash: string, revokedAt: Date) {
    const session = this.adminSessions.get(sessionId);
    if (!session || session.tokenHash !== tokenHash) return false;
    this.adminSessions.set(sessionId, copy({ ...session, revokedAt }));
    return true;
  }
  async createDeviceRequest(value: DeviceRequest) { this.create(this.deviceRequests, value, "Device request"); }
  async getDeviceRequest(id: string) { return this.get(this.deviceRequests, id); }
  async getDeviceRequestBySecretHash(hash: string) { return this.find(this.deviceRequests, value => value.requestSecretHash === hash); }
  async listDeviceRequests(householdId: string) { return this.filter(this.deviceRequests, value => value.householdId === householdId); }
  async putDevice(value: Device) { this.set(this.devices, value); }
  async getDevice(id: string) { return this.get(this.devices, id); }
  async listDevices(householdId: string) { return this.filter(this.devices, value => value.householdId === householdId); }
  async putDeviceSession(value: DeviceSession) { this.set(this.deviceSessions, value); }
  async getDeviceSessionByHash(hash: string) { return this.find(this.deviceSessions, value => value.tokenHash === hash); }
  async authenticateDeviceSession(input: AuthenticateDeviceSessionInput): Promise<AuthenticatedDeviceSession | null> {
    const session = [...this.deviceSessions.values()].find(value => value.tokenHash === input.tokenHash);
    const household = this.households.get(input.householdId);
    const device = session ? this.devices.get(session.deviceId) : undefined;
    if (!session || !household || !device || session.householdId !== input.householdId || device.householdId !== input.householdId || session.deviceId !== device.id || session.revokedAt || session.expiresAt <= input.now || !device.enabled || device.revokedAt) return null;
    const renewed = session.expiresAt < input.renewBefore;
    const updatedSession = copy({ ...session, lastSeenAt: input.now, ...(renewed ? { expiresAt: input.renewalExpiresAt } : {}) });
    const updatedDevice = copy({ ...device, lastSeenAt: input.now });
    this.deviceSessions.set(session.id, updatedSession);
    this.devices.set(device.id, updatedDevice);
    return { session: copy(updatedSession), device: copy(updatedDevice), household: copy(household), renewed };
  }
  async putSource(value: Source) { this.set(this.sources, value); }
  async connectSourceWithRoot(input: ConnectSourceInput) {
    const rootId = assignedRootDocumentId(input.root.householdId, input.root.sourceId, input.root.providerNodeId);
    if (this.sources.has(input.source.id) || this.roots.has(rootId)) {
      throw new RepositoryError("ROOT_CONFLICT", "Source connection conflicts with existing data");
    }
    this.sources.set(input.source.id, copy(input.source));
    this.roots.set(rootId, copy({ ...input.root, id: rootId }));
  }
  async getSource(id: string) { return this.get(this.sources, id); }
  async listSources(householdId: string) { return this.filter(this.sources, value => value.householdId === householdId); }
  async getSourceImpact(householdId: string, sourceId: string) {
    const source = this.sources.get(sourceId);
    if (!source || source.householdId !== householdId) {
      throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found");
    }
    const roots = [...this.roots.values()].filter(root => root.householdId === householdId && root.sourceId === sourceId);
    const ids = new Set(roots.map(root => root.id));
    const devices = [...this.devices.values()].filter(device => device.householdId === householdId && device.assignedRootIds.some(id => ids.has(id)));
    return { roots: roots.map(copy), devices: devices.map(copy) };
  }
  async removeSource(input: RemoveSourceInput) {
    const impact = await this.getSourceImpact(input.householdId, input.sourceId);
    this.sources.delete(input.sourceId);
    const rootIds = new Set(impact.roots.map(root => root.id));
    for (const root of impact.roots) this.roots.set(root.id, copy({ ...root, enabled: false }));
    for (const device of impact.devices) {
      this.devices.set(device.id, copy({
        ...device,
        assignedRootIds: device.assignedRootIds.filter(id => !rootIds.has(id))
      }));
    }
    return impact;
  }
  async createOAuthState(value: OAuthState) { this.create(this.oauthStates, value, "OAuth state"); }
  async listOAuthStates(householdId: string) { return this.filter(this.oauthStates, value => value.householdId === householdId); }
  async consumeOAuthState(input: ConsumeOAuthStateInput): Promise<OAuthState | null> {
    const state = [...this.oauthStates.values()].find(value => value.stateHash === input.stateHash);
    if (
      !state ||
      state.householdId !== input.householdId ||
      state.adminSessionId !== input.adminSessionId ||
      state.provider !== input.provider ||
      state.redirectUri !== input.redirectUri ||
      state.consumedAt !== null ||
      state.expiresAt <= input.now
    ) {
      return null;
    }
    const consumed = copy({ ...state, consumedAt: input.now });
    this.oauthStates.set(state.id, consumed);
    return copy(consumed);
  }
  async putRoot(value: AssignedRoot) { this.set(this.roots, value); }
  async createOrEnableRoot(value: AssignedRoot) {
    const deterministicId = assignedRootDocumentId(value.householdId, value.sourceId, value.providerNodeId);
    const deterministic = this.roots.get(deterministicId);
    if (deterministic) {
      const enabled = copy({ ...deterministic, displayName: value.displayName, ancestryProviderIds: [...value.ancestryProviderIds], enabled: true });
      this.roots.set(deterministicId, enabled);
      return copy(enabled);
    }
    const duplicate = [...this.roots.values()].find(root =>
      root.householdId === value.householdId &&
      root.sourceId === value.sourceId &&
      root.providerNodeId === value.providerNodeId
    );
    if (duplicate) {
      const enabled = copy({ ...duplicate, id: deterministicId, displayName: value.displayName, ancestryProviderIds: [...value.ancestryProviderIds], enabled: true });
      this.roots.delete(duplicate.id);
      this.roots.set(deterministicId, enabled);
      for (const [id, device] of this.devices) {
        if (device.assignedRootIds.includes(duplicate.id)) this.devices.set(id, copy({ ...device, assignedRootIds: device.assignedRootIds.map(rootId => rootId === duplicate.id ? deterministicId : rootId) }));
      }
      return copy(enabled);
    }
    const created = copy({ ...value, id: deterministicId });
    this.roots.set(deterministicId, created);
    return copy(created);
  }
  async disableRoot(input: DisableRootInput) {
    const root = this.roots.get(input.rootId);
    if (!root || root.householdId !== input.householdId) {
      throw new RepositoryError("ROOT_NOT_FOUND", "Root not found");
    }
    const devices = [...this.devices.values()].filter(device => device.householdId === input.householdId && device.assignedRootIds.includes(root.id));
    this.roots.set(root.id, copy({ ...root, enabled: false }));
    for (const device of devices) this.devices.set(device.id, copy({ ...device, assignedRootIds: device.assignedRootIds.filter(id => id !== root.id) }));
    return { roots: [copy(root)], devices: devices.map(copy) };
  }
  async getRoot(id: string) { return this.get(this.roots, id); }
  async listRootsForSource(sourceId: string) { return this.filter(this.roots, value => value.sourceId === sourceId); }
  async listRootsByIds(rootIds: string[]) { return rootIds.map(id => this.roots.get(id)).filter((value): value is AssignedRoot => Boolean(value)).map(copy); }
  async putNode(value: MediaNode) { this.set(this.nodes, value); }
  async getNode(id: string) { return this.get(this.nodes, id); }
  async getNodeByProviderId(sourceId: string, providerNodeId: string) { return this.find(this.nodes, value => value.sourceId === sourceId && value.providerNodeId === providerNodeId); }
  async listChildNodes(parentNodeId: string | null, sourceIds: string[]) { return this.filter(this.nodes, value => value.parentNodeId === parentNodeId && sourceIds.includes(value.sourceId)); }
  async listNodesForSource(sourceId: string) { return this.filter(this.nodes, value => value.sourceId === sourceId); }
  async putWatchHistory(value: WatchHistory) { this.set(this.history, value); }
  async getWatchHistory(deviceId: string, nodeId: string) { return this.find(this.history, value => value.deviceId === deviceId && value.nodeId === nodeId); }
  async listWatchHistory(input: ListWatchHistoryInput) { return this.filter(this.history, value => value.householdId === input.householdId && value.deviceId === input.deviceId); }

  failNextIndexCommitForTest(): void { this.failIndexCommit = true; }

  async commitIndexBatch(input: IndexBatchCommitInput): Promise<number> {
    if (this.failIndexCommit) {
      this.failIndexCommit = false;
      throw new Error("Simulated index commit failure");
    }
    const source = this.sources.get(input.sourceId);
    if (!source) throw new Error("Source not found");
    if (
      input.expectedLeaseOwner &&
      (source.leaseOwner !== input.expectedLeaseOwner ||
        !source.leaseExpiresAt ||
        source.leaseExpiresAt <= input.committedAt)
    ) {
      throw new RepositoryError("SYNC_LEASE_STALE", "Sync lease is stale");
    }
    if (JSON.stringify(source.crawlCheckpoint) !== JSON.stringify(input.expectedPreviousCheckpoint ?? null)) {
      throw new RepositoryError("SYNC_CHECKPOINT_STALE", "Sync checkpoint is stale");
    }
    const nextNodes = new Map(this.nodes);
    for (const node of input.nodes) nextNodes.set(node.id, copy(node));
    for (const id of input.removedNodeIds) {
      const node = nextNodes.get(id);
      if (node) nextNodes.set(id, copy({ ...node, available: false }));
    }
    const all = [...nextNodes.values()];
    for (const id of new Set(input.affectedAncestorNodeIds)) {
      const folder = nextNodes.get(id);
      if (!folder || folder.kind !== "folder") continue;
      const descendants = all.filter(node => node.id !== folder.id && (node.parentNodeId === folder.id || node.ancestorNodeIds.includes(folder.id)));
      nextNodes.set(id, copy(recomputeFolderMetadata(folder, descendants)));
    }
    this.nodes = nextNodes;
    this.sources.set(input.sourceId, copy({
      ...source,
      crawlCheckpoint: input.checkpoint,
      syncGeneration: input.generation,
      ...(input.deltaCursor === undefined ? {} : { deltaCursor: input.deltaCursor }),
      status: input.completedAt ? "healthy" : "syncing",
      lastSyncCompletedAt: input.completedAt,
      lastSyncErrorCode: null,
      ...(input.leaseExpiresAt ? { leaseExpiresAt: input.leaseExpiresAt } : {})
    }));
    return [...this.nodes.values()].filter(node => node.sourceId === input.sourceId).length;
  }

  async reconcileSourceGeneration(input: { sourceId: string; generation: string; cursor: string | null; limit: number; now: Date; leaseOwner: string }) {
    const source = this.sources.get(input.sourceId);
    if (
      !source ||
      source.leaseOwner !== input.leaseOwner ||
      !source.leaseExpiresAt ||
      source.leaseExpiresAt <= input.now ||
      source.crawlCheckpoint?.generation !== input.generation
    ) throw new RepositoryError("SYNC_LEASE_STALE", "Sync lease is stale");
    const stale = [...this.nodes.values()]
      .filter(node => node.sourceId === input.sourceId && node.available && node.syncGeneration !== input.generation)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = input.cursor ? Math.max(0, stale.findIndex(node => node.id === input.cursor) + 1) : 0;
    const page = stale.slice(start, start + input.limit);
    for (const node of page) this.nodes.set(node.id, copy({ ...node, available: false, indexedAt: input.now }));
    const affectedIds = new Set(page.flatMap(node => [
      ...node.ancestorNodeIds,
      ...(node.parentNodeId ? [node.parentNodeId] : [])
    ]));
    const all = [...this.nodes.values()];
    for (const id of affectedIds) {
      const folder = this.nodes.get(id);
      if (!folder || folder.kind !== "folder") continue;
      const descendants = all.filter(node =>
        node.id !== id &&
        (node.parentNodeId === id || node.ancestorNodeIds.includes(id))
      );
      this.nodes.set(id, copy(recomputeFolderMetadata(folder, descendants)));
    }
    const nextCursor = start + page.length < stale.length ? page.at(-1)?.id ?? null : null;
    this.sources.set(source.id, copy({ ...source, leaseExpiresAt: new Date(input.now.getTime() + 10 * 60 * 1000), crawlCheckpoint: { mode: "reconcile", providerPageCursor: null, processedNodeCount: start + page.length, generation: input.generation, reconciliationCursor: nextCursor } }));
    return { nodes: page.map(copy), nextCursor };
  }

  async leaseDueSources(input: DueSourceLeaseInput): Promise<Source[]> {
    const candidates = [...this.sources.values()]
      .filter(source => source.householdId === input.householdId && source.status !== "disabled" && source.status !== "reauth-required")
      .filter(source => !source.nextSyncAt || source.nextSyncAt <= input.now)
      .sort((a, b) => (a.nextSyncAt?.getTime() ?? 0) - (b.nextSyncAt?.getTime() ?? 0))
      .slice(0, Math.max(0, input.limit));
    const leased: Source[] = [];
    for (const source of candidates) {
      const owner = `${input.owner}:${source.id}`;
      if (await this.acquireSyncLease({ sourceId: source.id, owner, now: input.now, expiresAt: input.expiresAt })) {
        leased.push(copy({ ...source, leaseOwner: owner, leaseExpiresAt: input.expiresAt }));
      }
    }
    return leased;
  }

  async completeSyncRun(input: { sourceId: string; leaseOwner: string; completedAt: Date; nextSyncAt: Date }): Promise<void> {
    const source = this.sources.get(input.sourceId);
    if (
      !source ||
      source.leaseOwner !== input.leaseOwner ||
      !source.leaseExpiresAt ||
      source.leaseExpiresAt <= input.completedAt
    ) {
      throw new RepositoryError("SYNC_LEASE_STALE", "Sync lease is stale");
    }
    this.sources.set(source.id, copy({
      ...source,
      status: "healthy",
      crawlCheckpoint: null,
      activeWorkflowRunId: null,
      lastSyncCompletedAt: input.completedAt,
      nextSyncAt: input.nextSyncAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastSyncErrorCode: null
    }));
  }

  async markSyncRunStarted(input: { sourceId: string; leaseOwner: string; runId: string; startedAt: Date }): Promise<boolean> {
    const source = this.sources.get(input.sourceId);
    if (!source || source.leaseOwner !== input.leaseOwner || !source.leaseExpiresAt || source.leaseExpiresAt <= input.startedAt) return false;
    this.sources.set(source.id, copy({ ...source, status: "syncing", activeWorkflowRunId: input.runId, lastSyncStartedAt: input.startedAt, lastSyncErrorCode: null }));
    return true;
  }

  async recordSyncFailure(input: {
    sourceId: string;
    expectedLeaseOwner: string;
    expectedCheckpoint: import("@cloudframe/shared").IndexCheckpoint | null;
    failedAt: Date;
    status: "reauth-required" | "error";
    errorCode: string;
    nextSyncAt: Date | null;
  }): Promise<boolean> {
    const source = this.sources.get(input.sourceId);
    if (
      !source ||
      source.leaseOwner !== input.expectedLeaseOwner ||
      !source.leaseExpiresAt ||
      source.leaseExpiresAt <= input.failedAt ||
      JSON.stringify(source.crawlCheckpoint) !== JSON.stringify(input.expectedCheckpoint)
    ) return false;
    this.sources.set(source.id, copy({
      ...source,
      status: input.status,
      lastSyncErrorCode: input.errorCode,
      nextSyncAt: input.nextSyncAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      activeWorkflowRunId: null
    }));
    return true;
  }

  async approveDeviceRequest(input: ApproveDeviceRequestInput): Promise<void> {
    return this.approveDeviceRequestTransaction(input, false);
  }

  async approveDeviceRequestWithRoots(input: ApproveDeviceRequestInput): Promise<void> {
    return this.approveDeviceRequestTransaction(input, true);
  }

  private async approveDeviceRequestTransaction(
    input: ApproveDeviceRequestInput,
    validateRoots: boolean
  ): Promise<void> {
    const request = this.deviceRequests.get(input.requestId);
    if (!request) {
      throw new RepositoryError(
        "DEVICE_REQUEST_NOT_FOUND",
        "Device request not found"
      );
    }
    if (request.status !== "pending") {
      throw new RepositoryError(
        "DEVICE_REQUEST_NOT_PENDING",
        "Device request is not pending"
      );
    }
    validateDeviceApproval(request, input);
    if (validateRoots) this.validateRoots(input.device.householdId, input.rootIds);
    if (this.devices.has(input.device.id)) {
      throw new RepositoryError("DEVICE_APPROVAL_CONFLICT", "Device already exists");
    }
    if (this.deviceSessions.has(input.session.id)) {
      throw new RepositoryError(
        "DEVICE_APPROVAL_CONFLICT",
        "Device session already exists"
      );
    }
    if ([...this.deviceSessions.values()].some(value => value.tokenHash === input.session.tokenHash)) {
      throw new RepositoryError(
        "DEVICE_APPROVAL_CONFLICT",
        "Device session token already exists"
      );
    }
    this.deviceRequests.set(input.requestId, copy({ ...request, status: "approved", resolvedAt: input.approvedAt, approvedDeviceId: input.device.id }));
    this.devices.set(input.device.id, copy({ ...input.device, assignedRootIds: [...input.rootIds] }));
    this.deviceSessions.set(input.session.id, copy(input.session));
  }

  async denyDeviceRequest(input: ResolveDeviceRequestInput): Promise<DeviceRequest> {
    return this.resolveRequest(input, "denied");
  }

  async expireDeviceRequest(input: ResolveDeviceRequestInput): Promise<DeviceRequest> {
    return this.resolveRequest(input, "expired");
  }

  async updateDeviceWithRoots(input: UpdateDeviceInput): Promise<Device> {
    const device = this.devices.get(input.deviceId);
    if (!device || device.householdId !== input.householdId) {
      throw new RepositoryError("DEVICE_NOT_FOUND", "Device not found");
    }
    this.validateRoots(input.householdId, input.rootIds);
    const updated = copy({ ...device, ...input.patch, assignedRootIds: [...input.rootIds] });
    this.devices.set(device.id, updated);
    return copy(updated);
  }

  async consumeRateLimit(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
    const windowMs = input.windowSeconds * 1000;
    const windowStart = Math.floor(input.now.getTime() / windowMs) * windowMs;
    const key = `${input.bucket}\u0000${input.subject}\u0000${windowStart}`;
    const count = this.rateLimits.get(key) ?? 0;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + windowMs - input.now.getTime()) / 1000));
    if (count >= input.limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    const next = count + 1;
    this.rateLimits.set(key, next);
    return { allowed: true, remaining: Math.max(0, input.limit - next), retryAfterSeconds };
  }

  async revokeDevice(deviceId: string, revokedAt: Date): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new RepositoryError("DEVICE_NOT_FOUND", "Device not found");
    }
    this.devices.set(deviceId, copy({ ...device, enabled: false, revokedAt }));
    for (const [id, session] of this.deviceSessions) {
      if (session.deviceId === deviceId) this.deviceSessions.set(id, copy({ ...session, revokedAt }));
    }
  }

  async rotateAdminPassphrase(input: RotateAdminPassphraseInput): Promise<Household> {
    const household = this.households.get(input.householdId);
    if (!household) throw new Error("Household not found");
    const updated = copy({ ...household, adminPassphraseHash: input.adminPassphraseHash, adminPassphraseVersion: household.adminPassphraseVersion + 1 });
    this.households.set(household.id, updated);
    for (const [id, session] of this.adminSessions) {
      if (session.householdId === input.householdId) this.adminSessions.set(id, copy({ ...session, revokedAt: input.revokedAt }));
    }
    return copy(updated);
  }

  async updateHouseholdSettings(input: UpdateHouseholdSettingsInput): Promise<Household> {
    const household = this.households.get(input.householdId);
    if (!household) throw new Error("Household not found");
    const updated = copy({ ...household, ...input });
    this.households.set(household.id, updated);
    return copy(updated);
  }

  async acquireSyncLease(input: SyncLeaseInput): Promise<boolean> {
    const source = this.sources.get(input.sourceId);
    if (!source) throw new Error("Source not found");
    if (source.leaseOwner && source.leaseExpiresAt && source.leaseExpiresAt > input.now) return false;
    this.sources.set(source.id, copy({ ...source, leaseOwner: input.owner, leaseExpiresAt: input.expiresAt }));
    return true;
  }

  async releaseSyncLease(sourceId: string, owner: string): Promise<boolean> {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error("Source not found");
    if (source.leaseOwner !== owner) return false;
    this.sources.set(source.id, copy({ ...source, leaseOwner: null, leaseExpiresAt: null }));
    return true;
  }

  private resolveRequest(input: ResolveDeviceRequestInput, status: "denied" | "expired"): DeviceRequest {
    const request = this.deviceRequests.get(input.requestId);
    if (!request || request.householdId !== input.householdId) {
      throw new RepositoryError(
        "DEVICE_REQUEST_NOT_FOUND",
        "Device request not found"
      );
    }
    if (request.status !== "pending") {
      throw new RepositoryError(
        "DEVICE_REQUEST_NOT_PENDING",
        "Device request is not pending"
      );
    }
    const updated = copy({ ...request, status, resolvedAt: input.now });
    this.deviceRequests.set(request.id, updated);
    return copy(updated);
  }

  private validateRoots(householdId: string, rootIds: string[]): void {
    if (rootIds.length === 0 || new Set(rootIds).size !== rootIds.length) {
      throw new RepositoryError(
        "ROOT_ASSIGNMENT_INVALID",
        "Root assignment is invalid"
      );
    }
    for (const id of rootIds) {
      const root = this.roots.get(id);
      if (!root || root.householdId !== householdId || !root.enabled) {
        throw new RepositoryError(
          "ROOT_ASSIGNMENT_INVALID",
          "Root assignment is invalid"
        );
      }
    }
  }

  private get<T>(map: Map<string, T>, id: string): T | null { const value = map.get(id); return value ? copy(value) : null; }
  private set<T extends { id: string }>(map: Map<string, T>, value: T): void { map.set(value.id, copy(value)); }
  private create<T extends { id: string }>(map: Map<string, T>, value: T, label: string): void { if (map.has(value.id)) throw new Error(`${label} already exists`); this.set(map, value); }
  private find<T>(map: Map<string, T>, predicate: (value: T) => boolean): T | null { const value = [...map.values()].find(predicate); return value ? copy(value) : null; }
  private filter<T>(map: Map<string, T>, predicate: (value: T) => boolean): T[] { return [...map.values()].filter(predicate).map(copy); }
}
