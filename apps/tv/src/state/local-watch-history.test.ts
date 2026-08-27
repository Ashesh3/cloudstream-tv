import { describe, expect, it } from "vitest";

import { createLocalWatchHistory } from "./local-watch-history";

const now = new Date("2026-08-27T12:00:00.000Z");

describe("local TV watch history", () => {
  it("persists history by pseudonymous item id and caps it at 500 newest entries", () => {
    let tick = 0;
    const storage = memoryStorage();
    const history = createLocalWatchHistory(storage, "device-1", () => new Date(now.getTime() + tick++));

    for (let index = 0; index < 501; index += 1) {
      history.save(`item_${index}`, { positionSeconds: index, durationSeconds: 1_000, completed: false });
    }

    expect(history.list()).toHaveLength(500);
    expect(history.get("item_0")).toBeNull();
    expect(history.list()[0]).toMatchObject({ itemId: "item_500", positionSeconds: 500 });
    expect(JSON.parse(storage.values.get("cloudframe.tv.watch-history.v1:device-1")!)).toEqual({
      version: 1,
      entries: expect.objectContaining({
        item_500: {
          positionSeconds: 500,
          durationSeconds: 1_000,
          completed: false,
          updatedAt: "2026-08-27T12:00:00.500Z"
        }
      })
    });
  });

  it("salvages valid entries, discards invalid fields, and serializes only the exact schema", () => {
    const storage = memoryStorage({
      "cloudframe.tv.watch-history.v1:device-1": JSON.stringify({
        version: 1,
        entries: {
          item_valid: {
            positionSeconds: 12,
            durationSeconds: 90,
            completed: false,
            updatedAt: "2026-08-27T10:00:00.000Z",
            handle: "sealed-secret",
            providerId: "provider-secret",
            url: "https://provider.example/private",
            name: "Private name"
          },
          item_too_long: { positionSeconds: 31_622_401, durationSeconds: 31_622_401, completed: false, updatedAt: "2026-08-27T09:00:00.000Z" },
          item_past_duration: { positionSeconds: 91, durationSeconds: 90, completed: false, updatedAt: "2026-08-27T09:00:00.000Z" },
          item_bad_date: { positionSeconds: 1, durationSeconds: 2, completed: false, updatedAt: "not-a-date" },
          item_impossible_date: { positionSeconds: 1, durationSeconds: 2, completed: false, updatedAt: "2026-02-30T10:00:00.000Z" },
          item_offset_date: { positionSeconds: 2, durationSeconds: 10, completed: false, updatedAt: "2026-08-27T15:30:00+05:30" },
          unsafe: { positionSeconds: 1, durationSeconds: 2, completed: false, updatedAt: "2026-08-27T09:00:00.000Z" }
        }
      })
    });

    const history = createLocalWatchHistory(storage, "device-1", () => now);

    expect(history.available).toBe(true);
    expect(history.list()).toEqual([
      {
        itemId: "item_offset_date",
        positionSeconds: 2,
        durationSeconds: 10,
        completed: false,
        updatedAt: "2026-08-27T10:00:00.000Z"
      },
      {
        itemId: "item_valid",
        positionSeconds: 12,
        durationSeconds: 90,
        completed: false,
        updatedAt: "2026-08-27T10:00:00.000Z"
      }
    ]);

    history.save("item_valid", {
      positionSeconds: 20,
      durationSeconds: 90,
      completed: false,
      handle: "must-not-persist",
      token: "must-not-persist",
      arbitrary: { nested: true }
    } as never);

    expect(JSON.parse(storage.values.get("cloudframe.tv.watch-history.v1:device-1")!)).toEqual({
      version: 1,
      entries: {
        item_offset_date: {
          positionSeconds: 2,
          durationSeconds: 10,
          completed: false,
          updatedAt: "2026-08-27T10:00:00.000Z"
        },
        item_valid: {
          positionSeconds: 20,
          durationSeconds: 90,
          completed: false,
          updatedAt: "2026-08-27T12:00:00.000Z"
        }
      }
    });
  });

  it("orders newest first with deterministic item-id ties and isolates device keys", () => {
    const storage = memoryStorage();
    const first = createLocalWatchHistory(storage, "device-1", () => now);
    const second = createLocalWatchHistory(storage, "device-2", () => now);

    first.save("item_z", validHistory());
    first.save("item_a", validHistory());
    second.save("item_other", validHistory());

    expect(first.list().map(entry => entry.itemId)).toEqual(["item_a", "item_z"]);
    expect(second.list().map(entry => entry.itemId)).toEqual(["item_other"]);
    expect(storage.values.has("cloudframe.tv.watch-history.v1:device-1")).toBe(true);
    expect(storage.values.has("cloudframe.tv.watch-history.v1:device-2")).toBe(true);
  });

  it("recovers from corrupt or unavailable localStorage without blocking playback", () => {
    const corrupt = memoryStorage({ "cloudframe.tv.watch-history.v1:device-1": "{" });
    const corruptHistory = createLocalWatchHistory(corrupt, "device-1", () => now);
    expect(corruptHistory.list()).toEqual([]);
    expect(corruptHistory.available).toBe(false);
    expect(() => corruptHistory.save("item_1", validHistory())).not.toThrow();
    expect(corruptHistory.get("item_1")).toMatchObject(validHistory());

    const unavailable = createLocalWatchHistory(throwingStorage(), "device-1", () => now);
    expect(unavailable.list()).toEqual([]);
    expect(() => unavailable.save("item_1", validHistory())).not.toThrow();
    expect(unavailable.get("item_1")).toMatchObject(validHistory());
    expect(unavailable.available).toBe(false);
    expect(() => unavailable.clear()).not.toThrow();
    expect(unavailable.list()).toEqual([]);
  });

  it("keeps the atomic in-memory update when quota persistence fails", () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); };
    const history = createLocalWatchHistory(storage, "device-1", () => now);

    expect(() => history.save("item_1", validHistory())).not.toThrow();
    expect(history.get("item_1")).toEqual({ itemId: "item_1", ...validHistory(), updatedAt: now.toISOString() });
    expect(history.available).toBe(false);
  });

  it("rejects invalid device ids, item ids, values, and timestamps without touching storage", () => {
    const storage = memoryStorage();
    const invalidDevice = createLocalWatchHistory(storage, "../device", () => now);
    expect(invalidDevice.available).toBe(false);
    expect(() => invalidDevice.save("item_valid", validHistory())).not.toThrow();
    const history = createLocalWatchHistory(storage, "device-1", () => new Date(Number.NaN));

    expect(() => history.save("../item", validHistory())).not.toThrow();
    expect(() => history.save("item_bad", { positionSeconds: -1, durationSeconds: 2, completed: false })).not.toThrow();
    expect(() => history.save("item_nan", { positionSeconds: Number.NaN, durationSeconds: 2, completed: false })).not.toThrow();
    expect(() => history.save("item_past", { positionSeconds: 3, durationSeconds: 2, completed: false })).not.toThrow();
    expect(() => history.save("item_long", { positionSeconds: 0, durationSeconds: 31_622_401, completed: false })).not.toThrow();
    expect(history.list()).toEqual([]);
    expect(storage.values.size).toBe(0);
  });
});

function validHistory() {
  return { positionSeconds: 12, durationSeconds: 90, completed: false };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
    removeItem(key: string) { values.delete(key); }
  };
}

function throwingStorage() {
  return {
    getItem(): string | null { throw Object.assign(new Error("denied"), { name: "SecurityError" }); },
    setItem(): void { throw Object.assign(new Error("denied"), { name: "SecurityError" }); },
    removeItem(): void { throw Object.assign(new Error("denied"), { name: "SecurityError" }); }
  };
}
