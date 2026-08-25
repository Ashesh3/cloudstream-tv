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
import {
  RepositoryError,
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
  ResolveDeviceRequestInput,
  UpdateDeviceInput
} from "./repository";

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
  async getSource(id: string) { return this.get(this.sources, id); }
  async listSources(householdId: string) { return this.filter(this.sources, value => value.householdId === householdId); }
  async putRoot(value: AssignedRoot) { this.set(this.roots, value); }
  async getRoot(id: string) { return this.get(this.roots, id); }
  async listRootsForSource(sourceId: string) { return this.filter(this.roots, value => value.sourceId === sourceId); }
  async putNode(value: MediaNode) { this.set(this.nodes, value); }
  async getNode(id: string) { return this.get(this.nodes, id); }
  async getNodeByProviderId(sourceId: string, providerNodeId: string) { return this.find(this.nodes, value => value.sourceId === sourceId && value.providerNodeId === providerNodeId); }
  async listChildNodes(parentNodeId: string | null, sourceIds: string[]) { return this.filter(this.nodes, value => value.parentNodeId === parentNodeId && sourceIds.includes(value.sourceId)); }
  async putWatchHistory(value: WatchHistory) { this.set(this.history, value); }
  async getWatchHistory(deviceId: string, nodeId: string) { return this.find(this.history, value => value.deviceId === deviceId && value.nodeId === nodeId); }

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
