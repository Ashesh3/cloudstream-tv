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
import { validateDeviceApproval, type AppRepository } from "./repository";

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

  async getHousehold(id: string) { return this.get(this.households, id); }
  async putHousehold(value: Household) { this.set(this.households, value); }
  async getAdminSessionByHash(hash: string) { return this.find(this.adminSessions, value => value.tokenHash === hash); }
  async putAdminSession(value: AdminSession) { this.set(this.adminSessions, value); }
  async createDeviceRequest(value: DeviceRequest) { this.create(this.deviceRequests, value, "Device request"); }
  async getDeviceRequest(id: string) { return this.get(this.deviceRequests, id); }
  async listDeviceRequests(householdId: string) { return this.filter(this.deviceRequests, value => value.householdId === householdId); }
  async putDevice(value: Device) { this.set(this.devices, value); }
  async getDevice(id: string) { return this.get(this.devices, id); }
  async listDevices(householdId: string) { return this.filter(this.devices, value => value.householdId === householdId); }
  async putDeviceSession(value: DeviceSession) { this.set(this.deviceSessions, value); }
  async getDeviceSessionByHash(hash: string) { return this.find(this.deviceSessions, value => value.tokenHash === hash); }
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
    const request = this.deviceRequests.get(input.requestId);
    if (!request || request.status !== "pending") throw new Error("Device request is not pending");
    validateDeviceApproval(request, input);
    if (this.devices.has(input.device.id)) throw new Error("Device already exists");
    if (this.deviceSessions.has(input.session.id)) throw new Error("Device session already exists");
    if ([...this.deviceSessions.values()].some(value => value.tokenHash === input.session.tokenHash)) throw new Error("Device session token already exists");
    this.deviceRequests.set(input.requestId, copy({ ...request, status: "approved", resolvedAt: input.approvedAt, approvedDeviceId: input.device.id }));
    this.devices.set(input.device.id, copy({ ...input.device, assignedRootIds: [...input.rootIds] }));
    this.deviceSessions.set(input.session.id, copy(input.session));
  }

  async revokeDevice(deviceId: string, revokedAt: Date): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error("Device not found");
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

  private get<T>(map: Map<string, T>, id: string): T | null { const value = map.get(id); return value ? copy(value) : null; }
  private set<T extends { id: string }>(map: Map<string, T>, value: T): void { map.set(value.id, copy(value)); }
  private create<T extends { id: string }>(map: Map<string, T>, value: T, label: string): void { if (map.has(value.id)) throw new Error(`${label} already exists`); this.set(map, value); }
  private find<T>(map: Map<string, T>, predicate: (value: T) => boolean): T | null { const value = [...map.values()].find(predicate); return value ? copy(value) : null; }
  private filter<T>(map: Map<string, T>, predicate: (value: T) => boolean): T[] { return [...map.values()].filter(predicate).map(copy); }
}
