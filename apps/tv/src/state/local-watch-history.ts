const MAX_HISTORY_ENTRIES = 500;
const MAX_HISTORY_SECONDS = 366 * 24 * 60 * 60;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const ITEM_ID_PATTERN = /^item_[A-Za-z0-9_-]{1,256}$/;

export interface WatchHistoryValue {
  positionSeconds: number;
  durationSeconds: number;
  completed: boolean;
}

export interface LocalWatchHistoryEntry extends WatchHistoryValue {
  itemId: string;
  updatedAt: string;
}

export interface WatchHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalWatchHistory {
  readonly available: boolean;
  list(): LocalWatchHistoryEntry[];
  get(itemId: string): LocalWatchHistoryEntry | null;
  save(itemId: string, value: WatchHistoryValue): void;
  clear(): void;
}

interface StoredWatchHistoryEntryV1 extends WatchHistoryValue {
  updatedAt: string;
}

interface StoredWatchHistoryV1 {
  version: 1;
  entries: Record<string, StoredWatchHistoryEntryV1>;
}

export function createLocalWatchHistory(
  storage: WatchHistoryStorage | null | undefined,
  deviceId: string,
  now: () => Date = () => new Date()
): LocalWatchHistory {
  const storageKey = validDeviceId(deviceId) ? `cloudframe.tv.watch-history.v1:${deviceId}` : null;
  let available = Boolean(storage && storageKey);
  let entries: Record<string, StoredWatchHistoryEntryV1> = {};

  if (available) {
    try {
      const serialized = storage!.getItem(storageKey!);
      if (serialized !== null) entries = parseStoredHistory(serialized);
    } catch {
      available = false;
      entries = {};
    }
  }

  const api: LocalWatchHistory = {
    get available() { return available; },
    list() {
      return sortedEntries(entries).map(([itemId, value]) => ({ itemId, ...copyEntry(value) }));
    },
    get(itemId) {
      if (!validItemId(itemId)) return null;
      const value = entries[itemId];
      return value ? { itemId, ...copyEntry(value) } : null;
    },
    save(itemId, value) {
      if (!validItemId(itemId) || !validHistoryValue(value)) return;
      const updatedAt = safeNow(now);
      if (!updatedAt) return;
      const next = { ...entries, [itemId]: { ...copyValue(value), updatedAt } };
      entries = cappedEntries(next);
      persist();
    },
    clear() {
      entries = {};
      if (!available || !storage || !storageKey) return;
      try {
        storage.removeItem(storageKey);
      } catch {
        available = false;
      }
    }
  };

  return api;

  function persist() {
    if (!available || !storage || !storageKey) return;
    const stored: StoredWatchHistoryV1 = { version: 1, entries: {} };
    sortedEntries(entries).forEach(([itemId, value]) => {
      stored.entries[itemId] = copyEntry(value);
    });
    try {
      storage.setItem(storageKey, JSON.stringify(stored));
    } catch {
      available = false;
    }
  }
}

function parseStoredHistory(serialized: string): Record<string, StoredWatchHistoryEntryV1> {
  const parsed = JSON.parse(serialized) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) throw new Error("Invalid local watch history.");
  const rawEntries = parsed.entries;
  const entries: Record<string, StoredWatchHistoryEntryV1> = {};
  Object.keys(rawEntries).forEach(itemId => {
    const value = rawEntries[itemId];
    if (!validItemId(itemId) || !isRecord(value) || !validHistoryValue(value)) return;
    const updatedAt = normalizedIsoTimestamp(value.updatedAt);
    if (!updatedAt) return;
    entries[itemId] = { ...copyValue(value), updatedAt };
  });
  return cappedEntries(entries);
}

function cappedEntries(entries: Record<string, StoredWatchHistoryEntryV1>): Record<string, StoredWatchHistoryEntryV1> {
  const capped: Record<string, StoredWatchHistoryEntryV1> = {};
  sortedEntries(entries).slice(0, MAX_HISTORY_ENTRIES).forEach(([itemId, value]) => {
    capped[itemId] = copyEntry(value);
  });
  return capped;
}

function sortedEntries(entries: Record<string, StoredWatchHistoryEntryV1>): Array<[string, StoredWatchHistoryEntryV1]> {
  return Object.keys(entries).map(itemId => [itemId, entries[itemId]!] as [string, StoredWatchHistoryEntryV1]).sort((left, right) => {
    const timeOrder = right[1].updatedAt.localeCompare(left[1].updatedAt);
    if (timeOrder) return timeOrder;
    return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  });
}

function validHistoryValue(value: unknown): value is WatchHistoryValue {
  if (!isRecord(value)) return false;
  return finiteHistoryNumber(value.positionSeconds) &&
    finiteHistoryNumber(value.durationSeconds) &&
    value.positionSeconds <= value.durationSeconds &&
    typeof value.completed === "boolean";
}

function finiteHistoryNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_HISTORY_SECONDS;
}

function normalizedIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  if (day > daysInMonth(year, month)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const offsetMinutes = match[8] === "Z" ? 0 : (match[9] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  const local = new Date(timestamp + offsetMinutes * 60_000);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month || local.getUTCDate() !== day ||
    local.getUTCHours() !== hour || local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second || local.getUTCMilliseconds() !== millisecond) return null;
  return new Date(timestamp).toISOString();
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function safeNow(now: () => Date): string | null {
  try {
    const value = now();
    return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

function validDeviceId(value: string): boolean {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

function validItemId(value: string): boolean {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyValue(value: WatchHistoryValue): WatchHistoryValue {
  return {
    positionSeconds: value.positionSeconds,
    durationSeconds: value.durationSeconds,
    completed: value.completed
  };
}

function copyEntry(value: StoredWatchHistoryEntryV1): StoredWatchHistoryEntryV1 {
  return { ...copyValue(value), updatedAt: value.updatedAt };
}
