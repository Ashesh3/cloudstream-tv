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

export interface AppRepository {
  getHousehold(id: string): Promise<Household | null>;
  putHousehold(household: Household): Promise<void>;
  getAdminSessionByHash(tokenHash: string): Promise<AdminSession | null>;
  putAdminSession(session: AdminSession): Promise<void>;
  rotateAdminPassphrase(input: RotateAdminPassphraseInput): Promise<Household>;
  createDeviceRequest(request: DeviceRequest): Promise<void>;
  getDeviceRequest(id: string): Promise<DeviceRequest | null>;
  listDeviceRequests(householdId: string): Promise<DeviceRequest[]>;
  approveDeviceRequest(input: ApproveDeviceRequestInput): Promise<void>;
  putDevice(device: Device): Promise<void>;
  getDevice(id: string): Promise<Device | null>;
  listDevices(householdId: string): Promise<Device[]>;
  revokeDevice(deviceId: string, revokedAt: Date): Promise<void>;
  putDeviceSession(session: DeviceSession): Promise<void>;
  getDeviceSessionByHash(tokenHash: string): Promise<DeviceSession | null>;
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
  sources: "sources",
  roots: "roots",
  nodes: "nodes",
  watchHistory: "watchHistory"
} as const;

export class FirestoreRepository implements AppRepository {
  constructor(private readonly firestore: Firestore) {}

  getHousehold(id: string) { return this.getById<Household>(COLLECTIONS.households, id); }
  putHousehold(value: Household) { return this.put(COLLECTIONS.households, value); }
  getAdminSessionByHash(hash: string) { return this.getOne<AdminSession>(this.query(COLLECTIONS.adminSessions, "tokenHash", hash)); }
  putAdminSession(value: AdminSession) { return this.put(COLLECTIONS.adminSessions, value); }
  createDeviceRequest(value: DeviceRequest) { return this.create(COLLECTIONS.deviceRequests, value); }
  getDeviceRequest(id: string) { return this.getById<DeviceRequest>(COLLECTIONS.deviceRequests, id); }
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
    await this.firestore.runTransaction(async transaction => {
      const requestRef = this.firestore.collection(COLLECTIONS.deviceRequests).doc(input.requestId);
      const deviceRef = this.firestore.collection(COLLECTIONS.devices).doc(input.device.id);
      const sessionRef = this.firestore.collection(COLLECTIONS.deviceSessions).doc(input.session.id);
      const tokenHashQuery = this.firestore
        .collection(COLLECTIONS.deviceSessions)
        .where("tokenHash", "==", input.session.tokenHash)
        .limit(1);
      const [requestSnapshot, deviceSnapshot, sessionSnapshot, tokenHashSnapshot] = await Promise.all([
        transaction.get(requestRef),
        transaction.get(deviceRef),
        transaction.get(sessionRef),
        transaction.get(tokenHashQuery)
      ]);
      const request = requestSnapshot.exists
        ? decodeFirestoreDocument<DeviceRequest>(
            requestSnapshot.id,
            requestSnapshot.data()
          )
        : undefined;
      if (!request || request.status !== "pending") throw new Error("Device request is not pending");
      validateDeviceApproval(request, input);
      if (deviceSnapshot.exists) throw new Error("Device already exists");
      if (sessionSnapshot.exists) throw new Error("Device session already exists");
      if (!tokenHashSnapshot.empty) throw new Error("Device session token already exists");
      const approvedAt = input.approvedAt;
      transaction.update(requestRef, { status: "approved", resolvedAt: approvedAt, approvedDeviceId: input.device.id });
      transaction.create(deviceRef, { ...input.device, assignedRootIds: [...input.rootIds] });
      transaction.create(sessionRef, input.session);
    });
  }

  async revokeDevice(deviceId: string, revokedAt: Date): Promise<void> {
    await this.firestore.runTransaction(async transaction => {
      const deviceRef = this.firestore.collection(COLLECTIONS.devices).doc(deviceId);
      const [deviceSnapshot, sessionsSnapshot] = await Promise.all([
        transaction.get(deviceRef),
        transaction.get(this.firestore.collection(COLLECTIONS.deviceSessions).where("deviceId", "==", deviceId))
      ]);
      if (!deviceSnapshot.exists) throw new Error("Device not found");
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
