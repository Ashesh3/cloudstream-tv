import type {
  AdminSession,
  ApproveDeviceRequestInput,
  AssignedRoot,
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
import type { Firestore, Query, Transaction, WriteBatch } from "@google-cloud/firestore";
import { createHash } from "node:crypto";
import {
  applyIndexRemovals,
  recomputeFolderMetadata,
  type IndexBatchCommitInput
} from "@cloudframe/indexer";
import { decodeSourceDocument } from "./decode";

export interface RateLimitConsumeInput {
  bucket: string;
  subject: string;
  now: Date;
  windowSeconds: number;
  limit: number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface AuthenticateAdminSessionInput {
  tokenHash: string;
  householdId: string;
  now: Date;
  renewalExpiresAt: Date;
  renewBefore: Date;
}

export type AuthenticateDeviceSessionInput = AuthenticateAdminSessionInput;

export interface AuthenticatedDeviceSession {
  session: DeviceSession;
  device: Device;
  household: Household;
  renewed: boolean;
}

export interface AuthenticatedAdminSession {
  session: AdminSession;
  household: Household;
  renewed: boolean;
}

export interface ResolveDeviceRequestInput {
  requestId: string;
  householdId: string;
  now: Date;
}

export interface UpdateDeviceInput {
  deviceId: string;
  householdId: string;
  rootIds: string[];
  patch: Partial<
    Pick<
      Device,
      "name" | "enabled" | "mediaOrder" | "slideshowSeconds"
    >
  >;
}

export interface SourceImpact {
  roots: AssignedRoot[];
  devices: Device[];
}
export interface NodeCountSummary { total: number; available: number; }

export interface SourceCredentialMutationInput {
  sourceId: string;
  expectedEncryptedRefreshToken: Source["encryptedRefreshToken"];
  credentials: Pick<Source, "encryptedRefreshToken" | "encryptedAccessToken" | "accessTokenExpiresAt">;
}

export interface ReconnectSourceInput {
  sourceId: string;
  householdId: string;
  provider: Source["provider"];
  providerAccountId: string;
  providerRootId: string;
  accountLabel: string;
  credentials: Pick<Source, "encryptedRefreshToken" | "encryptedAccessToken" | "accessTokenExpiresAt">;
}

export function assignedRootDocumentId(
  householdId: string,
  sourceId: string,
  providerNodeId: string
): string {
  const digest = createHash("sha256")
    .update("assigned-root\0", "utf8")
    .update(householdId, "utf8")
    .update("\0", "utf8")
    .update(sourceId, "utf8")
    .update("\0", "utf8")
    .update(providerNodeId, "utf8")
    .digest("base64url");
  return `root_${digest}`;
}

export interface ListWatchHistoryInput {
  householdId: string;
  deviceId: string;
}

export interface DueSourceLeaseInput {
  householdId: string;
  owner: string;
  now: Date;
  expiresAt: Date;
  limit: number;
}

export interface ConsumeOAuthStateInput {
  stateHash: string;
  householdId: string;
  adminSessionId: string;
  provider: Source["provider"];
  redirectUri: string;
  now: Date;
}

export type RepositoryErrorCode =
  | "DEVICE_REQUEST_NOT_FOUND"
  | "DEVICE_REQUEST_NOT_PENDING"
  | "DEVICE_APPROVAL_CONFLICT"
  | "ROOT_ASSIGNMENT_INVALID"
  | "DEVICE_NOT_FOUND"
  | "SYNC_LEASE_STALE"
  | "SYNC_CHECKPOINT_STALE"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_RECONNECT_MISMATCH"
  | "ROOT_NOT_FOUND"
  | "ROOT_CONFLICT";

export class RepositoryError extends Error {
  constructor(readonly code: RepositoryErrorCode, message: string) {
    super(message);
    this.name = "RepositoryError";
  }
}

export interface AppRepository {
  getHousehold(id: string): Promise<Household | null>;
  putHousehold(household: Household): Promise<void>;
  createHouseholdIfAbsent(household: Household): Promise<Household>;
  getAdminSessionByHash(tokenHash: string): Promise<AdminSession | null>;
  putAdminSession(session: AdminSession): Promise<void>;
  authenticateAdminSession(
    input: AuthenticateAdminSessionInput
  ): Promise<AuthenticatedAdminSession | null>;
  revokeAdminSession(sessionId: string, tokenHash: string, revokedAt: Date): Promise<boolean>;
  rotateAdminPassphrase(input: RotateAdminPassphraseInput): Promise<Household>;
  updateHouseholdSettings(input: UpdateHouseholdSettingsInput): Promise<Household>;
  createDeviceRequest(request: DeviceRequest): Promise<void>;
  getDeviceRequest(id: string): Promise<DeviceRequest | null>;
  getDeviceRequestBySecretHash(tokenHash: string): Promise<DeviceRequest | null>;
  listDeviceRequests(householdId: string): Promise<DeviceRequest[]>;
  approveDeviceRequest(input: ApproveDeviceRequestInput): Promise<void>;
  approveDeviceRequestWithRoots(input: ApproveDeviceRequestInput): Promise<void>;
  denyDeviceRequest(input: ResolveDeviceRequestInput): Promise<DeviceRequest>;
  expireDeviceRequest(input: ResolveDeviceRequestInput): Promise<DeviceRequest>;
  putDevice(device: Device): Promise<void>;
  getDevice(id: string): Promise<Device | null>;
  listDevices(householdId: string): Promise<Device[]>;
  updateDeviceWithRoots(input: UpdateDeviceInput): Promise<Device>;
  revokeDevice(deviceId: string, revokedAt: Date): Promise<void>;
  putDeviceSession(session: DeviceSession): Promise<void>;
  getDeviceSessionByHash(tokenHash: string): Promise<DeviceSession | null>;
  authenticateDeviceSession(
    input: AuthenticateDeviceSessionInput
  ): Promise<AuthenticatedDeviceSession | null>;
  consumeRateLimit(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult>;
  putSource(source: Source): Promise<void>;
  updateSourceCredentialsIfCurrent(input: SourceCredentialMutationInput): Promise<Source | null>;
  markSourceReauthRequiredIfCurrent(input: Omit<SourceCredentialMutationInput, "credentials">): Promise<Source | null>;
  reconnectSource(input: ReconnectSourceInput): Promise<Source>;
  connectSource(source: Source): Promise<void>;
  getSource(id: string): Promise<Source | null>;
  listSources(householdId: string): Promise<Source[]>;
  getSourceImpact(householdId: string, sourceId: string): Promise<SourceImpact>;
  removeSource(input: RemoveSourceInput): Promise<SourceImpact>;
  createOAuthState(state: OAuthState): Promise<void>;
  consumeOAuthState(input: ConsumeOAuthStateInput): Promise<OAuthState | null>;
  listOAuthStates(householdId: string): Promise<OAuthState[]>;
  acquireSyncLease(input: SyncLeaseInput): Promise<boolean>;
  releaseSyncLease(sourceId: string, owner: string): Promise<boolean>;
  putRoot(root: AssignedRoot): Promise<void>;
  createOrEnableRoot(root: AssignedRoot): Promise<AssignedRoot>;
  enableRootAndResetInitial(input: {
    root: AssignedRoot;
    sourceId: string;
    resetAt: Date;
  }): Promise<AssignedRoot>;
  disableRoot(input: DisableRootInput): Promise<SourceImpact>;
  getRoot(id: string): Promise<AssignedRoot | null>;
  listRootsForSource(sourceId: string): Promise<AssignedRoot[]>;
  listRootsByIds(rootIds: string[]): Promise<AssignedRoot[]>;
  putNode(node: MediaNode): Promise<void>;
  getNode(id: string): Promise<MediaNode | null>;
  getNodeByProviderId(sourceId: string, providerNodeId: string): Promise<MediaNode | null>;
  listChildNodes(parentNodeId: string | null, sourceIds: string[]): Promise<MediaNode[]>;
  listNodesForSource(sourceId: string): Promise<MediaNode[]>;
  countNodesForHousehold(householdId: string): Promise<NodeCountSummary>;
  commitIndexBatch(input: IndexBatchCommitInput): Promise<number>;
  reconcileSourceGeneration(input: {
    sourceId: string;
    generation: string;
    cursor: string | null;
    limit: number;
    now: Date;
    leaseOwner: string;
  }): Promise<{ nodes: MediaNode[]; nextCursor: string | null }>;
  leaseDueSources(input: DueSourceLeaseInput): Promise<Source[]>;
  completeSyncRun(input: { sourceId: string; leaseOwner: string; completedAt: Date; nextSyncAt: Date }): Promise<void>;
  markSyncRunStarted(input: { sourceId: string; leaseOwner: string; runId: string; startedAt: Date }): Promise<boolean>;
  recordSyncFailure(input: {
    sourceId: string;
    expectedLeaseOwner: string;
    expectedCheckpoint: import("@cloudframe/shared").IndexCheckpoint | null;
    failedAt: Date;
    status: "reauth-required" | "error";
    errorCode: string;
    nextSyncAt: Date | null;
  }): Promise<boolean>;
  putWatchHistory(history: WatchHistory): Promise<void>;
  getWatchHistory(deviceId: string, nodeId: string): Promise<WatchHistory | null>;
  listWatchHistory(input: ListWatchHistoryInput): Promise<WatchHistory[]>;
}

const COLLECTIONS = {
  households: "households",
  adminSessions: "adminSessions",
  deviceRequests: "deviceRequests",
  devices: "devices",
  deviceSessions: "deviceSessions",
  deviceSessionTokenClaims: "deviceSessionTokenClaims",
  rateLimits: "rateLimits",
  oauthStates: "oauthStates",
  sources: "sources",
  roots: "roots",
  nodes: "nodes",
  watchHistory: "watchHistory"
} as const;

export class FirestoreRepository implements AppRepository {
  constructor(private readonly firestore: Firestore) {}

  getHousehold(id: string) { return this.getById<Household>(COLLECTIONS.households, id); }
  putHousehold(value: Household) { return this.put(COLLECTIONS.households, value); }
  async createHouseholdIfAbsent(value: Household): Promise<Household> {
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.households).doc(value.id);
      const snapshot = await transaction.get(reference);
      if (snapshot.exists) {
        return decodeFirestoreDocument<Household>(snapshot.id, snapshot.data());
      }
      transaction.create(reference, value);
      return value;
    });
  }
  getAdminSessionByHash(hash: string) { return this.getOne<AdminSession>(this.query(COLLECTIONS.adminSessions, "tokenHash", hash)); }
  putAdminSession(value: AdminSession) { return this.put(COLLECTIONS.adminSessions, value); }
  createDeviceRequest(value: DeviceRequest) { return this.create(COLLECTIONS.deviceRequests, value); }
  getDeviceRequest(id: string) { return this.getById<DeviceRequest>(COLLECTIONS.deviceRequests, id); }
  getDeviceRequestBySecretHash(hash: string) { return this.getOne<DeviceRequest>(this.query(COLLECTIONS.deviceRequests, "requestSecretHash", hash)); }
  listDeviceRequests(householdId: string) { return this.getMany<DeviceRequest>(this.query(COLLECTIONS.deviceRequests, "householdId", householdId)); }
  putDevice(value: Device) { return this.put(COLLECTIONS.devices, value); }
  getDevice(id: string) { return this.getById<Device>(COLLECTIONS.devices, id); }
  listDevices(householdId: string) { return this.getMany<Device>(this.query(COLLECTIONS.devices, "householdId", householdId)); }
  putDeviceSession(value: DeviceSession) { return this.put(COLLECTIONS.deviceSessions, value); }
  getDeviceSessionByHash(hash: string) { return this.getOne<DeviceSession>(this.query(COLLECTIONS.deviceSessions, "tokenHash", hash)); }
  putSource(value: Source) { return this.put(COLLECTIONS.sources, value); }
  async updateSourceCredentialsIfCurrent(input: SourceCredentialMutationInput): Promise<Source | null> {
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const current = decodeSourceDocument(snapshot.id, snapshot.data());
      if (!sameEncryptedSecret(current.encryptedRefreshToken, input.expectedEncryptedRefreshToken)) return current;
      const updated: Source = {
        ...current,
        ...input.credentials,
        status: current.status === "reauth-required" ? "syncing" : current.status,
        lastSyncErrorCode: null
      };
      transaction.set(reference, updated);
      return updated;
    });
  }
  async markSourceReauthRequiredIfCurrent(input: Omit<SourceCredentialMutationInput, "credentials">): Promise<Source | null> {
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return null;
      const current = decodeSourceDocument(snapshot.id, snapshot.data());
      if (!sameEncryptedSecret(current.encryptedRefreshToken, input.expectedEncryptedRefreshToken)) return current;
      const updated = { ...current, status: "reauth-required" as const, lastSyncErrorCode: "PROVIDER_REAUTH_REQUIRED" };
      transaction.set(reference, updated);
      return updated;
    });
  }
  async connectSource(source: Source): Promise<void> {
    await this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.sources).doc(source.id);
      if ((await transaction.get(reference)).exists) {
        throw new RepositoryError("ROOT_CONFLICT", "Source already exists");
      }
      transaction.create(reference, source);
    });
  }
  async reconnectSource(input: ReconnectSourceInput): Promise<Source> {
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
      const rootsQuery = this.firestore
        .collection(COLLECTIONS.roots)
        .where("sourceId", "==", input.sourceId)
        .where("enabled", "==", true);
      const [snapshot, rootsSnapshot] = await Promise.all([
        transaction.get(reference),
        transaction.get(rootsQuery)
      ]);
      if (!snapshot.exists) {
        throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found");
      }
      const current = decodeSourceDocument(snapshot.id, snapshot.data());
      if (current.householdId !== input.householdId || current.provider !== input.provider) {
        throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found");
      }
      const migrationReconnect =
        current.providerAccountId === null &&
        current.status === "reauth-required" &&
        current.lastSyncErrorCode?.startsWith("MIGRATION_") === true;
      if (!migrationReconnect && current.providerAccountId !== input.providerAccountId) {
        throw new RepositoryError(
          "SOURCE_RECONNECT_MISMATCH",
          "Reconnect account does not match the current source"
        );
      }
      if (current.providerRootId !== null && current.providerRootId !== input.providerRootId) {
        throw new RepositoryError(
          "SOURCE_RECONNECT_MISMATCH",
          "Reconnect root does not match the current source"
        );
      }
      const hasEnabledRoots = rootsSnapshot.docs.some(root => {
        const decoded = decodeFirestoreDocument<AssignedRoot>(root.id, root.data());
        return decoded.householdId === input.householdId;
      });
      const hasResumableSync =
        current.status === "syncing" ||
        current.crawlCheckpoint !== null ||
        current.activeWorkflowRunId !== null;
      const patch: Partial<Source> = {
        providerAccountId: current.providerAccountId ?? input.providerAccountId,
        providerRootId: current.providerRootId ?? input.providerRootId,
        accountLabel: input.accountLabel,
        ...input.credentials,
        status: hasEnabledRoots && hasResumableSync ? "syncing" : "healthy",
        lastSyncErrorCode: null
      };
      transaction.update(reference, patch);
      return { ...current, ...patch };
    });
  }
  async getSource(id: string): Promise<Source | null> {
    const snapshot = await this.firestore.collection(COLLECTIONS.sources).doc(id).get();
    return snapshot.exists ? decodeSourceDocument(snapshot.id, snapshot.data()) : null;
  }
  async listSources(householdId: string): Promise<Source[]> {
    const snapshot = await this.query(COLLECTIONS.sources, "householdId", householdId).get();
    return snapshot.docs.map(document => decodeSourceDocument(document.id, document.data()));
  }
  async getSourceImpact(householdId: string, sourceId: string): Promise<SourceImpact> {
    const source = await this.getSource(sourceId);
    if (!source || source.householdId !== householdId) throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found");
    const roots = (await this.listRootsForSource(sourceId)).filter(root => root.householdId === householdId);
    const ids = new Set(roots.map(root => root.id));
    const devices = (await this.listDevices(householdId)).filter(device => device.assignedRootIds.some(id => ids.has(id)));
    return { roots, devices };
  }
  async removeSource(input: RemoveSourceInput): Promise<SourceImpact> {
    const sourceRef = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
    return this.firestore.runTransaction(async transaction => {
      const sourceSnapshot = await transaction.get(sourceRef);
      const source = sourceSnapshot.exists ? decodeSourceDocument(sourceSnapshot.id, sourceSnapshot.data()) : null;
      if (!source || source.householdId !== input.householdId) throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found");
      const [rootSnapshots, deviceSnapshots] = await Promise.all([
        transaction.get(this.firestore.collection(COLLECTIONS.roots).where("sourceId", "==", input.sourceId)),
        transaction.get(this.firestore.collection(COLLECTIONS.devices).where("householdId", "==", input.householdId))
      ]);
      const roots = rootSnapshots.docs.map(snapshot => decodeFirestoreDocument<AssignedRoot>(snapshot.id, snapshot.data())).filter(root => root.householdId === input.householdId);
      const rootIds = new Set(roots.map(root => root.id));
      const devices = deviceSnapshots.docs.map(snapshot => decodeFirestoreDocument<Device>(snapshot.id, snapshot.data())).filter(device => device.assignedRootIds.some(id => rootIds.has(id)));
      transaction.delete(sourceRef);
      for (const snapshot of rootSnapshots.docs) {
        const root = decodeFirestoreDocument<AssignedRoot>(snapshot.id, snapshot.data());
        if (root.householdId === input.householdId) transaction.update(snapshot.ref, { enabled: false });
      }
      for (const snapshot of deviceSnapshots.docs) {
        const device = decodeFirestoreDocument<Device>(snapshot.id, snapshot.data());
        const assignedRootIds = device.assignedRootIds.filter(id => !rootIds.has(id));
        if (assignedRootIds.length !== device.assignedRootIds.length) transaction.update(snapshot.ref, { assignedRootIds });
      }
      return { roots, devices };
    });
  }
  createOAuthState(value: OAuthState) { return this.create(COLLECTIONS.oauthStates, value); }
  listOAuthStates(householdId: string) { return this.getMany<OAuthState>(this.query(COLLECTIONS.oauthStates, "householdId", householdId)); }
  async consumeOAuthState(input: ConsumeOAuthStateInput): Promise<OAuthState | null> {
    return this.firestore.runTransaction(async transaction => {
      const snapshots = await transaction.get(
        this.firestore.collection(COLLECTIONS.oauthStates).where("stateHash", "==", input.stateHash).limit(1)
      );
      const snapshot = snapshots.docs[0];
      if (!snapshot) return null;
      const state = decodeFirestoreDocument<OAuthState>(snapshot.id, snapshot.data());
      if (
        state.householdId !== input.householdId ||
        state.adminSessionId !== input.adminSessionId ||
        state.provider !== input.provider ||
        state.redirectUri !== input.redirectUri ||
        state.consumedAt !== null ||
        state.expiresAt <= input.now
      ) {
        return null;
      }
      const consumed = { ...state, consumedAt: input.now };
      transaction.set(snapshot.ref, consumed);
      return consumed;
    });
  }
  putRoot(value: AssignedRoot) { return this.put(COLLECTIONS.roots, value); }
  async createOrEnableRoot(value: AssignedRoot): Promise<AssignedRoot> {
    return this.firestore.runTransaction(async transaction => {
      const deterministicId = assignedRootDocumentId(value.householdId, value.sourceId, value.providerNodeId);
      const deterministicRef = this.firestore.collection(COLLECTIONS.roots).doc(deterministicId);
      const duplicateQuery = this.firestore.collection(COLLECTIONS.roots)
        .where("sourceId", "==", value.sourceId)
        .where("providerNodeId", "==", value.providerNodeId)
        .limit(1);
      const [deterministicSnapshot, duplicateSnapshots, deviceSnapshots] = await Promise.all([
        transaction.get(deterministicRef),
        transaction.get(duplicateQuery),
        transaction.get(this.firestore.collection(COLLECTIONS.devices).where("householdId", "==", value.householdId))
      ]);
      if (deterministicSnapshot.exists) {
        const current = decodeFirestoreDocument<AssignedRoot>(deterministicSnapshot.id, deterministicSnapshot.data());
        if (current.householdId !== value.householdId || current.sourceId !== value.sourceId || current.providerNodeId !== value.providerNodeId) {
          throw new RepositoryError("ROOT_CONFLICT", "Root identity conflicts with existing data");
        }
        const enabled = { ...current, displayName: value.displayName, ancestryProviderIds: [...value.ancestryProviderIds], enabled: true };
        transaction.set(deterministicRef, enabled);
        return enabled;
      }
      const duplicate = duplicateSnapshots.docs[0];
      if (duplicate) {
        const current = decodeFirestoreDocument<AssignedRoot>(duplicate.id, duplicate.data());
        if (current.householdId !== value.householdId) throw new RepositoryError("ROOT_CONFLICT", "Root conflicts with another household");
        const enabled = { ...current, id: deterministicId, displayName: value.displayName, ancestryProviderIds: [...value.ancestryProviderIds], enabled: true };
        transaction.create(deterministicRef, enabled);
        transaction.delete(duplicate.ref);
        for (const snapshot of deviceSnapshots.docs) {
          const device = decodeFirestoreDocument<Device>(snapshot.id, snapshot.data());
          if (device.assignedRootIds.includes(current.id)) {
            transaction.update(snapshot.ref, { assignedRootIds: device.assignedRootIds.map(id => id === current.id ? deterministicId : id) });
          }
        }
        return enabled;
      }
      const deterministic = { ...value, id: deterministicId };
      transaction.create(deterministicRef, deterministic);
      return deterministic;
    });
  }
  async enableRootAndResetInitial(input: {
    root: AssignedRoot;
    sourceId: string;
    resetAt: Date;
  }): Promise<AssignedRoot> {
    if (input.root.sourceId !== input.sourceId) {
      throw new RepositoryError("ROOT_CONFLICT", "Root source identity conflicts with the requested source");
    }
    return this.firestore.runTransaction(async transaction => {
      const value = input.root;
      const sourceRef = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
      const deterministicId = assignedRootDocumentId(value.householdId, value.sourceId, value.providerNodeId);
      const deterministicRef = this.firestore.collection(COLLECTIONS.roots).doc(deterministicId);
      const duplicateQuery = this.firestore.collection(COLLECTIONS.roots)
        .where("sourceId", "==", value.sourceId)
        .where("providerNodeId", "==", value.providerNodeId)
        .limit(1);
      const [sourceSnapshot, deterministicSnapshot, duplicateSnapshots, deviceSnapshots] = await Promise.all([
        transaction.get(sourceRef),
        transaction.get(deterministicRef),
        transaction.get(duplicateQuery),
        transaction.get(this.firestore.collection(COLLECTIONS.devices).where("householdId", "==", value.householdId))
      ]);
      const source = sourceSnapshot.exists
        ? decodeSourceDocument(sourceSnapshot.id, sourceSnapshot.data())
        : null;
      if (!source || source.householdId !== value.householdId || source.status === "disabled") {
        throw new RepositoryError("SOURCE_NOT_FOUND", "Source not found");
      }

      let enabled: AssignedRoot;
      let alreadyEnabledIdenticalRoot = false;
      if (deterministicSnapshot.exists) {
        const current = decodeFirestoreDocument<AssignedRoot>(deterministicSnapshot.id, deterministicSnapshot.data());
        if (current.householdId !== value.householdId || current.sourceId !== value.sourceId || current.providerNodeId !== value.providerNodeId) {
          throw new RepositoryError("ROOT_CONFLICT", "Root identity conflicts with existing data");
        }
        alreadyEnabledIdenticalRoot = sameEnabledRootSelection(current, value);
        enabled = { ...current, displayName: value.displayName, ancestryProviderIds: [...value.ancestryProviderIds], enabled: true };
        transaction.set(deterministicRef, enabled);
      } else {
        const duplicate = duplicateSnapshots.docs[0];
        if (duplicate) {
          const current = decodeFirestoreDocument<AssignedRoot>(duplicate.id, duplicate.data());
          if (current.householdId !== value.householdId) throw new RepositoryError("ROOT_CONFLICT", "Root conflicts with another household");
          alreadyEnabledIdenticalRoot = sameEnabledRootSelection(current, value);
          enabled = { ...current, id: deterministicId, displayName: value.displayName, ancestryProviderIds: [...value.ancestryProviderIds], enabled: true };
          transaction.create(deterministicRef, enabled);
          transaction.delete(duplicate.ref);
          for (const snapshot of deviceSnapshots.docs) {
            const device = decodeFirestoreDocument<Device>(snapshot.id, snapshot.data());
            if (device.assignedRootIds.includes(current.id)) {
              transaction.update(snapshot.ref, { assignedRootIds: device.assignedRootIds.map(id => id === current.id ? deterministicId : id) });
            }
          }
        } else {
          enabled = { ...value, id: deterministicId, enabled: true, createdAt: input.resetAt };
          transaction.create(deterministicRef, enabled);
        }
      }
      if (!(alreadyEnabledIdenticalRoot && hasActiveSelectedRootSync(source, input.resetAt))) {
        transaction.update(sourceRef, initialSourceReset());
      }
      return enabled;
    });
  }
  async disableRoot(input: DisableRootInput): Promise<SourceImpact> {
    const rootRef = this.firestore.collection(COLLECTIONS.roots).doc(input.rootId);
    return this.firestore.runTransaction(async transaction => {
      const [rootSnapshot, deviceSnapshots] = await Promise.all([
        transaction.get(rootRef),
        transaction.get(this.firestore.collection(COLLECTIONS.devices).where("householdId", "==", input.householdId))
      ]);
      const root = rootSnapshot.exists ? decodeFirestoreDocument<AssignedRoot>(rootSnapshot.id, rootSnapshot.data()) : null;
      if (!root || root.householdId !== input.householdId) throw new RepositoryError("ROOT_NOT_FOUND", "Root not found");
      const devices = deviceSnapshots.docs.map(snapshot => decodeFirestoreDocument<Device>(snapshot.id, snapshot.data())).filter(device => device.assignedRootIds.includes(root.id));
      transaction.update(rootRef, { enabled: false });
      for (const snapshot of deviceSnapshots.docs) {
        const device = decodeFirestoreDocument<Device>(snapshot.id, snapshot.data());
        if (device.assignedRootIds.includes(root.id)) transaction.update(snapshot.ref, { assignedRootIds: device.assignedRootIds.filter(id => id !== root.id) });
      }
      return { roots: [root], devices };
    });
  }
  getRoot(id: string) { return this.getById<AssignedRoot>(COLLECTIONS.roots, id); }
  listRootsForSource(sourceId: string) { return this.getMany<AssignedRoot>(this.query(COLLECTIONS.roots, "sourceId", sourceId)); }
  async listRootsByIds(rootIds: string[]) {
    const roots = await Promise.all(rootIds.map(id => this.getRoot(id)));
    return roots.filter((root): root is AssignedRoot => root !== null);
  }
  putNode(value: MediaNode) { return this.put(COLLECTIONS.nodes, value); }
  getNode(id: string) { return this.getById<MediaNode>(COLLECTIONS.nodes, id); }
  getNodeByProviderId(sourceId: string, providerNodeId: string) {
    return this.getOne<MediaNode>(this.firestore.collection(COLLECTIONS.nodes).where("sourceId", "==", sourceId).where("providerNodeId", "==", providerNodeId));
  }
  putWatchHistory(value: WatchHistory) { return this.put(COLLECTIONS.watchHistory, value); }
  getWatchHistory(deviceId: string, nodeId: string) {
    return this.getOne<WatchHistory>(this.firestore.collection(COLLECTIONS.watchHistory).where("deviceId", "==", deviceId).where("nodeId", "==", nodeId));
  }
  listWatchHistory(input: ListWatchHistoryInput) {
    return this.getMany<WatchHistory>(
      this.firestore.collection(COLLECTIONS.watchHistory)
        .where("householdId", "==", input.householdId)
        .where("deviceId", "==", input.deviceId)
    );
  }

  async listChildNodes(parentNodeId: string | null, sourceIds: string[]): Promise<MediaNode[]> {
    const chunks: string[][] = [];
    for (let index = 0; index < sourceIds.length; index += 10) {
      chunks.push(sourceIds.slice(index, index + 10));
    }
    const pages = await Promise.all(chunks.map(chunk => {
      let query: Query = this.firestore.collection(COLLECTIONS.nodes).where("parentNodeId", "==", parentNodeId);
      query = chunk.length === 1
        ? query.where("sourceId", "==", chunk[0])
        : query.where("sourceId", "in", chunk);
      return this.getMany<MediaNode>(query);
    }));
    return pages.flat();
  }

  listNodesForSource(sourceId: string) {
    return this.getMany<MediaNode>(this.query(COLLECTIONS.nodes, "sourceId", sourceId));
  }
  async countNodesForHousehold(householdId: string): Promise<NodeCountSummary> {
    const collection = this.firestore.collection(COLLECTIONS.nodes);
    const [total, available] = await Promise.all([
      collection.where("householdId", "==", householdId).count().get(),
      collection.where("householdId", "==", householdId).where("available", "==", true).count().get()
    ]);
    return { total: total.data().count, available: available.data().count };
  }

  async commitIndexBatch(input: IndexBatchCommitInput): Promise<number> {
    const sourceRef = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
    const existingNodes = await this.listNodesForSource(input.sourceId);
    const byId = new Map(existingNodes.map(node => [node.id, node]));
    for (const node of input.nodes) byId.set(node.id, node);
    const removedIds = applyIndexRemovals(byId, input.removedNodeIds, input.committedAt);
    const affectedIds = affectedFoldersForRemovals(
      byId,
      input.affectedAncestorNodeIds,
      removedIds
    );
    recomputeAffectedFolders(byId, affectedIds);
    const changedIds = new Set([
      ...input.nodes.map(node => node.id),
      ...removedIds,
      ...affectedIds
    ]);
    const writes = [...changedIds]
      .map(id => byId.get(id))
      .filter((node): node is MediaNode => Boolean(node));
    if (writes.length + 1 > 450) {
      throw new Error("Index batch exceeds Firestore write bounds");
    }
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(sourceRef);
      const current = snapshot.exists
        ? decodeSourceDocument(snapshot.id, snapshot.data())
        : null;
      validateIndexCommit(current, input);
      const liveNodes = new Map(existingNodes.map(node => [node.id, node]));
      for (const node of input.nodes) liveNodes.set(node.id, node);
      applyIndexRemovals(liveNodes, input.removedNodeIds, input.committedAt);
      recomputeAffectedFolders(liveNodes, affectedIds);
      for (const node of writes) {
        transaction.set(
          this.firestore.collection(COLLECTIONS.nodes).doc(node.id),
          liveNodes.get(node.id) ?? node
        );
      }
      transaction.update(sourceRef, sourcePatch(input));
    });
    return byId.size;
  }

  async reconcileSourceGeneration(input: {
    sourceId: string; generation: string; cursor: string | null; limit: number; now: Date; leaseOwner: string;
  }) {
    const nodes = (await this.listNodesForSource(input.sourceId))
      .filter(node => node.available && node.syncGeneration !== input.generation)
      .sort((a, b) => a.id.localeCompare(b.id));
    const start = input.cursor
      ? Math.max(0, nodes.findIndex(node => node.id === input.cursor) + 1)
      : 0;
    const page = nodes.slice(start, start + input.limit);
    const nextCursor = start + page.length < nodes.length ? page.at(-1)?.id ?? null : null;
    const sourceRef = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(sourceRef);
      const source = snapshot.exists
        ? decodeSourceDocument(snapshot.id, snapshot.data())
        : null;
      if (
        !source ||
        source.leaseOwner !== input.leaseOwner ||
        !source.leaseExpiresAt ||
        source.leaseExpiresAt <= input.now ||
        source.crawlCheckpoint?.generation !== input.generation
      ) throw new RepositoryError("SYNC_LEASE_STALE", "Sync lease is stale");
      page.forEach(node => transaction.update(this.firestore.collection(COLLECTIONS.nodes).doc(node.id), {
        available: false,
        indexedAt: input.now
      }));
      const affectedIds = new Set(page.flatMap(node => [
        ...node.ancestorNodeIds,
        ...(node.parentNodeId ? [node.parentNodeId] : [])
      ]));
      const remaining = nodes.map(node =>
        page.some(stale => stale.id === node.id)
          ? { ...node, available: false }
          : node
      );
      for (const id of affectedIds) {
        const folder = remaining.find(node => node.id === id);
        if (!folder || folder.kind !== "folder") continue;
        const descendants = remaining.filter(node =>
          node.id !== id &&
          (node.parentNodeId === id || node.ancestorNodeIds.includes(id))
        );
        transaction.set(
          this.firestore.collection(COLLECTIONS.nodes).doc(id),
          recomputeFolderMetadata(folder, descendants)
        );
      }
      transaction.update(sourceRef, {
        leaseExpiresAt: new Date(input.now.getTime() + 10 * 60 * 1000),
        crawlCheckpoint: {
          mode: "reconcile",
          providerPageCursor: null,
          processedNodeCount: start + page.length,
          generation: input.generation,
          reconciliationCursor: nextCursor
        }
      });
    });
    return { nodes: page, nextCursor };
  }

  async leaseDueSources(input: DueSourceLeaseInput): Promise<Source[]> {
    const candidates = (await this.listSources(input.householdId))
      .filter(source => source.status !== "disabled" && source.status !== "reauth-required")
      .filter(source => !source.nextSyncAt || source.nextSyncAt <= input.now)
      .sort((a, b) => (a.nextSyncAt?.getTime() ?? 0) - (b.nextSyncAt?.getTime() ?? 0))
      .slice(0, Math.max(0, input.limit));
    const leased: Source[] = [];
    for (const source of candidates) {
      const owner = `${input.owner}:${source.id}`;
      if (await this.acquireSyncLease({ sourceId: source.id, owner, now: input.now, expiresAt: input.expiresAt })) {
        leased.push({ ...source, leaseOwner: owner, leaseExpiresAt: input.expiresAt });
      }
    }
    return leased;
  }

  async completeSyncRun(input: { sourceId: string; leaseOwner: string; completedAt: Date; nextSyncAt: Date }): Promise<void> {
    const ref = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
    await this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const source = snapshot.exists ? decodeSourceDocument(snapshot.id, snapshot.data()) : null;
      if (
        !source ||
        source.leaseOwner !== input.leaseOwner ||
        !source.leaseExpiresAt ||
        source.leaseExpiresAt <= input.completedAt
      ) {
        throw new RepositoryError("SYNC_LEASE_STALE", "Sync lease is stale");
      }
      transaction.update(ref, {
        status: "healthy",
        crawlCheckpoint: null,
        activeWorkflowRunId: null,
        lastSyncCompletedAt: input.completedAt,
        nextSyncAt: input.nextSyncAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastSyncErrorCode: null
      });
    });
  }

  async markSyncRunStarted(input: { sourceId: string; leaseOwner: string; runId: string; startedAt: Date }): Promise<boolean> {
    const ref = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
    return this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const source = snapshot.exists ? decodeSourceDocument(snapshot.id, snapshot.data()) : null;
      if (!source || source.leaseOwner !== input.leaseOwner || !source.leaseExpiresAt || source.leaseExpiresAt <= input.startedAt) return false;
      transaction.update(ref, { status: "syncing", activeWorkflowRunId: input.runId, lastSyncStartedAt: input.startedAt, lastSyncErrorCode: null });
      return true;
    });
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
    const ref = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
    return this.firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const source = snapshot.exists ? decodeSourceDocument(snapshot.id, snapshot.data()) : null;
      if (
        !source ||
        source.leaseOwner !== input.expectedLeaseOwner ||
        !source.leaseExpiresAt ||
        source.leaseExpiresAt <= input.failedAt ||
        JSON.stringify(source.crawlCheckpoint) !== JSON.stringify(input.expectedCheckpoint)
      ) return false;
      transaction.update(ref, {
        status: input.status,
        lastSyncErrorCode: input.errorCode,
        nextSyncAt: input.nextSyncAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        activeWorkflowRunId: null
      });
      return true;
    });
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
    await this.firestore.runTransaction(async transaction => {
      const requestRef = this.firestore.collection(COLLECTIONS.deviceRequests).doc(input.requestId);
      const deviceRef = this.firestore.collection(COLLECTIONS.devices).doc(input.device.id);
      const sessionRef = this.firestore.collection(COLLECTIONS.deviceSessions).doc(input.session.id);
      const tokenClaimRef = this.firestore
        .collection(COLLECTIONS.deviceSessionTokenClaims)
        .doc(input.session.tokenHash);
      const rootReferences = validateRoots
        ? input.rootIds.map(rootId =>
            this.firestore.collection(COLLECTIONS.roots).doc(rootId)
          )
        : [];
      const [requestSnapshot, deviceSnapshot, sessionSnapshot, tokenClaimSnapshot, ...rootSnapshots] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(deviceRef),
        transaction.get(sessionRef),
        transaction.get(tokenClaimRef),
        ...rootReferences.map(reference => transaction.get(reference))
      ]);
      const request = requestSnapshot.exists
        ? decodeFirestoreDocument<DeviceRequest>(
            requestSnapshot.id,
            requestSnapshot.data()
          )
        : undefined;
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
      if (deviceSnapshot.exists) {
        throw new RepositoryError("DEVICE_APPROVAL_CONFLICT", "Device already exists");
      }
      if (sessionSnapshot.exists) {
        throw new RepositoryError(
          "DEVICE_APPROVAL_CONFLICT",
          "Device session already exists"
        );
      }
      if (tokenClaimSnapshot.exists) {
        throw new RepositoryError(
          "DEVICE_APPROVAL_CONFLICT",
          "Device session token already exists"
        );
      }
      if (validateRoots) {
        validateRootSnapshots(
          rootSnapshots,
          input.device.householdId,
          input.rootIds
        );
      }
      const approvedAt = input.approvedAt;
      transaction.update(requestRef, { status: "approved", resolvedAt: approvedAt, approvedDeviceId: input.device.id });
      transaction.create(deviceRef, { ...input.device, assignedRootIds: [...input.rootIds] });
      transaction.create(sessionRef, input.session);
      transaction.create(tokenClaimRef, {
        tokenHash: input.session.tokenHash,
        sessionId: input.session.id,
        deviceId: input.device.id,
        householdId: input.device.householdId,
        createdAt: approvedAt
      });
    });
  }

  async denyDeviceRequest(input: ResolveDeviceRequestInput): Promise<DeviceRequest> {
    return this.resolveDeviceRequest(input, "denied");
  }

  async expireDeviceRequest(input: ResolveDeviceRequestInput): Promise<DeviceRequest> {
    return this.resolveDeviceRequest(input, "expired");
  }

  async updateDeviceWithRoots(input: UpdateDeviceInput): Promise<Device> {
    return this.firestore.runTransaction(async transaction => {
      const deviceReference = this.firestore.collection(COLLECTIONS.devices).doc(input.deviceId);
      const rootReferences = input.rootIds.map(rootId =>
        this.firestore.collection(COLLECTIONS.roots).doc(rootId)
      );
      const [deviceSnapshot, ...rootSnapshots] = await Promise.all([
        transaction.get(deviceReference),
        ...rootReferences.map(reference => transaction.get(reference))
      ]);
      if (!deviceSnapshot.exists) {
        throw new RepositoryError("DEVICE_NOT_FOUND", "Device not found");
      }
      const device = decodeFirestoreDocument<Device>(deviceSnapshot.id, deviceSnapshot.data());
      if (device.householdId !== input.householdId) {
        throw new RepositoryError("DEVICE_NOT_FOUND", "Device not found");
      }
      validateRootSnapshots(rootSnapshots, input.householdId, input.rootIds);
      const updated: Device = {
        ...device,
        ...input.patch,
        assignedRootIds: [...input.rootIds]
      };
      transaction.set(deviceReference, updated);
      return updated;
    });
  }

  async authenticateAdminSession(
    input: AuthenticateAdminSessionInput
  ): Promise<AuthenticatedAdminSession | null> {
    return this.firestore.runTransaction(async transaction => {
      const sessions = await transaction.get(
        this.firestore.collection(COLLECTIONS.adminSessions).where("tokenHash", "==", input.tokenHash).limit(1)
      );
      const snapshot = sessions.docs[0];
      if (!snapshot) return null;
      const session = decodeFirestoreDocument<AdminSession>(snapshot.id, snapshot.data());
      const householdReference = this.firestore.collection(COLLECTIONS.households).doc(input.householdId);
      const householdSnapshot = await transaction.get(householdReference);
      if (!householdSnapshot.exists) return null;
      const household = decodeFirestoreDocument<Household>(householdSnapshot.id, householdSnapshot.data());
      if (!isValidAdminSession(session, household, input)) return null;
      const renewed = session.expiresAt < input.renewBefore;
      const updated = {
        ...session,
        lastSeenAt: input.now,
        ...(renewed ? { expiresAt: input.renewalExpiresAt } : {})
      };
      transaction.set(snapshot.ref, updated);
      return { session: updated, household, renewed };
    });
  }

  async revokeAdminSession(
    sessionId: string,
    tokenHash: string,
    revokedAt: Date
  ): Promise<boolean> {
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.adminSessions).doc(sessionId);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return false;
      const session = decodeFirestoreDocument<AdminSession>(snapshot.id, snapshot.data());
      if (session.tokenHash !== tokenHash) return false;
      transaction.update(reference, { revokedAt });
      return true;
    });
  }

  async authenticateDeviceSession(
    input: AuthenticateDeviceSessionInput
  ): Promise<AuthenticatedDeviceSession | null> {
    return this.firestore.runTransaction(async transaction => {
      const sessions = await transaction.get(
        this.firestore.collection(COLLECTIONS.deviceSessions).where("tokenHash", "==", input.tokenHash).limit(1)
      );
      const snapshot = sessions.docs[0];
      if (!snapshot) return null;
      const session = decodeFirestoreDocument<DeviceSession>(snapshot.id, snapshot.data());
      const [deviceSnapshot, householdSnapshot] = await Promise.all([
        transaction.get(this.firestore.collection(COLLECTIONS.devices).doc(session.deviceId)),
        transaction.get(this.firestore.collection(COLLECTIONS.households).doc(input.householdId))
      ]);
      if (!deviceSnapshot.exists || !householdSnapshot.exists) return null;
      const device = decodeFirestoreDocument<Device>(deviceSnapshot.id, deviceSnapshot.data());
      const household = decodeFirestoreDocument<Household>(householdSnapshot.id, householdSnapshot.data());
      if (!isValidDeviceSession(session, device, household, input)) return null;
      const renewed = session.expiresAt < input.renewBefore;
      const updatedSession = {
        ...session,
        lastSeenAt: input.now,
        ...(renewed ? { expiresAt: input.renewalExpiresAt } : {})
      };
      const updatedDevice = { ...device, lastSeenAt: input.now };
      transaction.set(snapshot.ref, updatedSession);
      transaction.set(deviceSnapshot.ref, updatedDevice);
      return { session: updatedSession, device: updatedDevice, household, renewed };
    });
  }

  async consumeRateLimit(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
    const windowMs = input.windowSeconds * 1000;
    const windowStart = Math.floor(input.now.getTime() / windowMs) * windowMs;
    const documentId = rateLimitDocumentId(input.bucket, input.subject, windowStart);
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.rateLimits).doc(documentId);
      const snapshot = await transaction.get(reference);
      const count = snapshot.exists ? Number(snapshot.data()?.count ?? 0) : 0;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((windowStart + windowMs - input.now.getTime()) / 1000)
      );
      if (count >= input.limit) {
        return { allowed: false, remaining: 0, retryAfterSeconds };
      }
      const next = count + 1;
      transaction.set(reference, {
        bucket: input.bucket,
        subject: input.subject,
        windowStart: new Date(windowStart),
        expiresAt: new Date(windowStart + windowMs * 2),
        count: next
      });
      return {
        allowed: true,
        remaining: Math.max(0, input.limit - next),
        retryAfterSeconds
      };
    });
  }

  async revokeDevice(deviceId: string, revokedAt: Date): Promise<void> {
    await this.firestore.runTransaction(async transaction => {
      const deviceRef = this.firestore.collection(COLLECTIONS.devices).doc(deviceId);
      const [deviceSnapshot, sessionsSnapshot] = await Promise.all([
        transaction.get(deviceRef),
        transaction.get(this.firestore.collection(COLLECTIONS.deviceSessions).where("deviceId", "==", deviceId))
      ]);
      if (!deviceSnapshot.exists) {
        throw new RepositoryError("DEVICE_NOT_FOUND", "Device not found");
      }
      transaction.update(deviceRef, { enabled: false, revokedAt });
      sessionsSnapshot.docs.forEach(snapshot => transaction.update(snapshot.ref, { revokedAt }));
    });
  }

  async rotateAdminPassphrase(input: RotateAdminPassphraseInput): Promise<Household> {
    return this.firestore.runTransaction(async transaction => {
      const householdRef = this.firestore.collection(COLLECTIONS.households).doc(input.householdId);
      const [householdSnapshot, sessionsSnapshot] = await Promise.all([
        transaction.get(householdRef),
        transaction.get(this.firestore.collection(COLLECTIONS.adminSessions).where("householdId", "==", input.householdId))
      ]);
      const household = householdSnapshot.exists
        ? decodeFirestoreDocument<Household>(
            householdSnapshot.id,
            householdSnapshot.data()
          )
        : undefined;
      if (!household) throw new Error("Household not found");
      const updated: Household = {
        ...household,
        id: input.householdId,
        adminPassphraseHash: input.adminPassphraseHash,
        adminPassphraseVersion: household.adminPassphraseVersion + 1
      };
      transaction.set(householdRef, updated);
      sessionsSnapshot.docs.forEach(snapshot => transaction.update(snapshot.ref, { revokedAt: input.revokedAt }));
      return updated;
    });
  }

  async updateHouseholdSettings(input: UpdateHouseholdSettingsInput): Promise<Household> {
    return this.firestore.runTransaction(async transaction => {
      const ref = this.firestore.collection(COLLECTIONS.households).doc(input.householdId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new Error("Household not found");
      const household = decodeFirestoreDocument<Household>(snapshot.id, snapshot.data());
      const updated = { ...household, ...input };
      transaction.set(ref, updated);
      return updated;
    });
  }

  async acquireSyncLease(input: SyncLeaseInput): Promise<boolean> {
    return this.firestore.runTransaction(async transaction => {
      const ref = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
      const snapshot = await transaction.get(ref);
      const source = snapshot.exists
        ? decodeSourceDocument(snapshot.id, snapshot.data())
        : undefined;
      if (!source) throw new Error("Source not found");
      if (source.leaseOwner && source.leaseExpiresAt && source.leaseExpiresAt > input.now) return false;
      transaction.update(ref, { leaseOwner: input.owner, leaseExpiresAt: input.expiresAt });
      return true;
    });
  }

  async releaseSyncLease(sourceId: string, owner: string): Promise<boolean> {
    return this.firestore.runTransaction(async transaction => {
      const ref = this.firestore.collection(COLLECTIONS.sources).doc(sourceId);
      const snapshot = await transaction.get(ref);
      const source = snapshot.exists
        ? decodeSourceDocument(snapshot.id, snapshot.data())
        : undefined;
      if (!source) throw new Error("Source not found");
      if (source.leaseOwner !== owner) return false;
      transaction.update(ref, { leaseOwner: null, leaseExpiresAt: null });
      return true;
    });
  }

  private async resolveDeviceRequest(
    input: ResolveDeviceRequestInput,
    status: "denied" | "expired"
  ): Promise<DeviceRequest> {
    return this.firestore.runTransaction(async transaction => {
      const reference = this.firestore.collection(COLLECTIONS.deviceRequests).doc(input.requestId);
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) {
        throw new RepositoryError(
          "DEVICE_REQUEST_NOT_FOUND",
          "Device request not found"
        );
      }
      const request = decodeFirestoreDocument<DeviceRequest>(snapshot.id, snapshot.data());
      if (request.householdId !== input.householdId || request.status !== "pending") {
        throw new RepositoryError(
          "DEVICE_REQUEST_NOT_PENDING",
          "Device request is not pending"
        );
      }
      const updated: DeviceRequest = {
        ...request,
        status,
        resolvedAt: input.now
      };
      transaction.set(reference, updated);
      return updated;
    });
  }

  private query(collection: string, field: string, value: unknown): Query {
    return this.firestore.collection(collection).where(field, "==", value);
  }
  private async getById<T>(collection: string, id: string): Promise<T | null> {
    const snapshot = await this.firestore.collection(collection).doc(id).get();
    return snapshot.exists
      ? decodeFirestoreDocument<T>(snapshot.id, snapshot.data())
      : null;
  }
  private async getOne<T>(query: Query): Promise<T | null> {
    const snapshot = await query.limit(1).get();
    const document = snapshot.docs[0];
    return document
      ? decodeFirestoreDocument<T>(document.id, document.data())
      : null;
  }
  private async getMany<T>(query: Query): Promise<T[]> {
    const snapshot = await query.get();
    return snapshot.docs.map(document =>
      decodeFirestoreDocument<T>(document.id, document.data())
    );
  }
  private async put(collection: string, value: { id: string }): Promise<void> {
    await this.firestore.collection(collection).doc(value.id).set(value);
  }
  private async create(collection: string, value: { id: string }): Promise<void> {
    await this.firestore.collection(collection).doc(value.id).create(value);
  }
}

function sameEncryptedSecret(left: Source["encryptedRefreshToken"], right: Source["encryptedRefreshToken"]): boolean {
  return left.keyVersion === right.keyVersion && left.iv === right.iv && left.ciphertext === right.ciphertext && left.authTag === right.authTag;
}

function initialSourceReset(): Pick<
  Source,
  | "status"
  | "deltaCursor"
  | "crawlCheckpoint"
  | "activeWorkflowRunId"
  | "syncGeneration"
  | "nextSyncAt"
  | "leaseOwner"
  | "leaseExpiresAt"
  | "lastSyncErrorCode"
> {
  return {
    status: "syncing",
    deltaCursor: null,
    crawlCheckpoint: null,
    activeWorkflowRunId: null,
    syncGeneration: null,
    nextSyncAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastSyncErrorCode: null
  };
}

function hasActiveSelectedRootSync(source: Source, resetAt: Date): boolean {
  return (
    source.status === "syncing" &&
    source.deltaCursor === null &&
    (
      source.crawlCheckpoint === null ||
      source.crawlCheckpoint.mode === "initial" ||
      source.crawlCheckpoint.mode === "reconcile"
    ) &&
    source.nextSyncAt === null &&
    source.lastSyncErrorCode === null &&
    source.leaseOwner !== null &&
    source.leaseExpiresAt !== null &&
    source.leaseExpiresAt > resetAt
  );
}

function sameEnabledRootSelection(current: AssignedRoot, requested: AssignedRoot): boolean {
  return (
    current.enabled &&
    current.ancestryProviderIds.length === requested.ancestryProviderIds.length &&
    current.ancestryProviderIds.every((providerId, index) => providerId === requested.ancestryProviderIds[index])
  );
}

export type FirestoreAtomicWriter = Transaction | WriteBatch;

export function validateDeviceApproval(
  request: DeviceRequest,
  input: ApproveDeviceRequestInput
): void {
  if (request.expiresAt <= input.approvedAt) {
    throw new Error("Device request is expired");
  }
  if (
    request.householdId !== input.device.householdId ||
    request.householdId !== input.session.householdId ||
    input.session.deviceId !== input.device.id
  ) {
    throw new Error("Device approval relationship is invalid");
  }
}

interface SnapshotLike {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

function validateRootSnapshots(
  snapshots: SnapshotLike[],
  householdId: string,
  rootIds: string[]
): void {
  if (rootIds.length === 0 || new Set(rootIds).size !== rootIds.length) {
    throw new RepositoryError(
      "ROOT_ASSIGNMENT_INVALID",
      "Root assignment is invalid"
    );
  }
  for (const snapshot of snapshots) {
    if (!snapshot.exists) {
      throw new RepositoryError(
        "ROOT_ASSIGNMENT_INVALID",
        "Root assignment is invalid"
      );
    }
    const root = decodeFirestoreDocument<AssignedRoot>(snapshot.id, snapshot.data());
    if (root.householdId !== householdId || !root.enabled) {
      throw new RepositoryError(
        "ROOT_ASSIGNMENT_INVALID",
        "Root assignment is invalid"
      );
    }
  }
}

function isValidAdminSession(
  session: AdminSession,
  household: Household,
  input: AuthenticateAdminSessionInput
): boolean {
  return (
    session.householdId === input.householdId &&
    household.id === input.householdId &&
    session.passphraseVersion === household.adminPassphraseVersion &&
    session.revokedAt === null &&
    session.expiresAt > input.now
  );
}

function isValidDeviceSession(
  session: DeviceSession,
  device: Device,
  household: Household,
  input: AuthenticateDeviceSessionInput
): boolean {
  return (
    session.householdId === input.householdId &&
    session.deviceId === device.id &&
    device.householdId === input.householdId &&
    household.id === input.householdId &&
    session.revokedAt === null &&
    session.expiresAt > input.now &&
    device.enabled &&
    device.revokedAt === null
  );
}

function rateLimitDocumentId(
  bucket: string,
  subject: string,
  windowStart: number
): string {
  const value = `${bucket}\u0000${subject}\u0000${windowStart}`;
  return Buffer.from(value, "utf8").toString("base64url");
}

interface FirestoreTimestampLike {
  toDate(): Date;
}

function isFirestoreTimestamp(value: unknown): value is FirestoreTimestampLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof value.toDate === "function"
  );
}

export function decodeFirestoreValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  if (isFirestoreTimestamp(value)) return value.toDate();
  if (Array.isArray(value)) return value.map(decodeFirestoreValue);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      decodeFirestoreValue(nested)
    ])
  );
}

export function decodeFirestoreDocument<T>(
  id: string,
  data: Record<string, unknown> | undefined
): T {
  return decodeFirestoreValue({ ...data, id }) as T;
}

function sourcePatch(input: IndexBatchCommitInput): Partial<Source> {
  return {
    crawlCheckpoint: input.checkpoint,
    syncGeneration: input.generation,
    ...(input.deltaCursor === undefined ? {} : { deltaCursor: input.deltaCursor }),
    status: input.completedAt ? "healthy" : "syncing",
    lastSyncCompletedAt: input.completedAt,
    lastSyncErrorCode: null,
    ...(input.leaseExpiresAt ? { leaseExpiresAt: input.leaseExpiresAt } : {})
  };
}

function validateIndexCommit(
  source: Source | null,
  input: IndexBatchCommitInput
): void {
  if (!source) throw new Error("Source not found");
  if (
    input.expectedLeaseOwner &&
    (source.leaseOwner !== input.expectedLeaseOwner ||
      !source.leaseExpiresAt ||
      source.leaseExpiresAt <= input.committedAt)
  ) {
    throw new RepositoryError("SYNC_LEASE_STALE", "Sync lease is stale");
  }
  if (
    JSON.stringify(source.crawlCheckpoint) !==
    JSON.stringify(input.expectedPreviousCheckpoint ?? null)
  ) {
    throw new RepositoryError("SYNC_CHECKPOINT_STALE", "Sync checkpoint is stale");
  }
}

function recomputeAffectedFolders(
  nodes: Map<string, MediaNode>,
  affectedIds: string[]
): void {
  const all = [...nodes.values()];
  for (const id of new Set(affectedIds)) {
    const folder = nodes.get(id);
    if (!folder || folder.kind !== "folder") continue;
    const descendants = all.filter(node =>
      node.id !== folder.id &&
      (node.parentNodeId === folder.id || node.ancestorNodeIds.includes(folder.id))
    );
    nodes.set(id, recomputeFolderMetadata(folder, descendants));
  }
}

function affectedFoldersForRemovals(
  nodes: ReadonlyMap<string, MediaNode>,
  existingAffectedIds: readonly string[],
  removedIds: readonly string[]
): string[] {
  const affected = new Set(existingAffectedIds);
  for (const id of removedIds) {
    const node = nodes.get(id);
    if (!node) continue;
    node.ancestorNodeIds.forEach(ancestorId => affected.add(ancestorId));
    if (node.parentNodeId) affected.add(node.parentNodeId);
  }
  return [...affected];
}
