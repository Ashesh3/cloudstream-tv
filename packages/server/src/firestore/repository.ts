import type {
  AdminSession,
  ApproveDeviceRequestInput,
  AssignedRoot,
  Device,
  DeviceRequest,
  DeviceSession,
  Household,
  MediaNode,
  RotateAdminPassphraseInput,
  Source,
  SyncLeaseInput,
  WatchHistory
} from "@cloudframe/shared";
import type { Firestore, Query, Transaction, WriteBatch } from "@google-cloud/firestore";

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

export type RepositoryErrorCode =
  | "DEVICE_REQUEST_NOT_FOUND"
  | "DEVICE_REQUEST_NOT_PENDING"
  | "DEVICE_APPROVAL_CONFLICT"
  | "ROOT_ASSIGNMENT_INVALID"
  | "DEVICE_NOT_FOUND";

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
  getSource(id: string): Promise<Source | null>;
  listSources(householdId: string): Promise<Source[]>;
  acquireSyncLease(input: SyncLeaseInput): Promise<boolean>;
  releaseSyncLease(sourceId: string, owner: string): Promise<boolean>;
  putRoot(root: AssignedRoot): Promise<void>;
  getRoot(id: string): Promise<AssignedRoot | null>;
  listRootsForSource(sourceId: string): Promise<AssignedRoot[]>;
  putNode(node: MediaNode): Promise<void>;
  getNode(id: string): Promise<MediaNode | null>;
  getNodeByProviderId(sourceId: string, providerNodeId: string): Promise<MediaNode | null>;
  listChildNodes(parentNodeId: string | null, sourceIds: string[]): Promise<MediaNode[]>;
  putWatchHistory(history: WatchHistory): Promise<void>;
  getWatchHistory(deviceId: string, nodeId: string): Promise<WatchHistory | null>;
}

const COLLECTIONS = {
  households: "households",
  adminSessions: "adminSessions",
  deviceRequests: "deviceRequests",
  devices: "devices",
  deviceSessions: "deviceSessions",
  deviceSessionTokenClaims: "deviceSessionTokenClaims",
  rateLimits: "rateLimits",
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
  getSource(id: string) { return this.getById<Source>(COLLECTIONS.sources, id); }
  listSources(householdId: string) { return this.getMany<Source>(this.query(COLLECTIONS.sources, "householdId", householdId)); }
  putRoot(value: AssignedRoot) { return this.put(COLLECTIONS.roots, value); }
  getRoot(id: string) { return this.getById<AssignedRoot>(COLLECTIONS.roots, id); }
  listRootsForSource(sourceId: string) { return this.getMany<AssignedRoot>(this.query(COLLECTIONS.roots, "sourceId", sourceId)); }
  putNode(value: MediaNode) { return this.put(COLLECTIONS.nodes, value); }
  getNode(id: string) { return this.getById<MediaNode>(COLLECTIONS.nodes, id); }
  getNodeByProviderId(sourceId: string, providerNodeId: string) {
    return this.getOne<MediaNode>(this.firestore.collection(COLLECTIONS.nodes).where("sourceId", "==", sourceId).where("providerNodeId", "==", providerNodeId));
  }
  putWatchHistory(value: WatchHistory) { return this.put(COLLECTIONS.watchHistory, value); }
  getWatchHistory(deviceId: string, nodeId: string) {
    return this.getOne<WatchHistory>(this.firestore.collection(COLLECTIONS.watchHistory).where("deviceId", "==", deviceId).where("nodeId", "==", nodeId));
  }

  async listChildNodes(parentNodeId: string | null, sourceIds: string[]): Promise<MediaNode[]> {
    if (sourceIds.length === 0) return [];
    let query: Query = this.firestore.collection(COLLECTIONS.nodes).where("parentNodeId", "==", parentNodeId);
    query = sourceIds.length === 1
      ? query.where("sourceId", "==", sourceIds[0])
      : query.where("sourceId", "in", sourceIds);
    return this.getMany<MediaNode>(query);
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

  async acquireSyncLease(input: SyncLeaseInput): Promise<boolean> {
    return this.firestore.runTransaction(async transaction => {
      const ref = this.firestore.collection(COLLECTIONS.sources).doc(input.sourceId);
      const snapshot = await transaction.get(ref);
      const source = snapshot.exists
        ? decodeFirestoreDocument<Source>(snapshot.id, snapshot.data())
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
        ? decodeFirestoreDocument<Source>(snapshot.id, snapshot.data())
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

function decodeFirestoreValue(value: unknown): unknown {
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
