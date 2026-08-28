// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi } from "./client";

const source = { id: "source-1", provider: "google", accountLabel: "Home Drive", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z" } as const;
const snapshot = {
  revision: 7,
  household: { allowNewDeviceRequests: true, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 },
  pendingRequests: [],
  devices: [],
  sources: [source],
  roots: [],
  recoveryCopy: { status: "current", revision: 7 }
} as const;

const ok = <T>(data: T, csrf?: string) => new Response(JSON.stringify({ ok: true, data }), {
  status: 200,
  headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }
});

describe("admin API browser boundary", () => {
  it("loads the admin with one snapshot request", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok(snapshot, "csrf-next"));
    const client = createAdminApi(fetcher);

    await client.snapshot();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/admin/snapshot", expect.objectContaining({ credentials: "include" }));
    expect("overview" in client).toBe(false);
    expect("settings" in client).toBe(false);
    expect("sources" in client).toBe(false);
  });

  it("always includes cookies and keeps refreshed CSRF only in the client closure", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: true }, "csrf-login"))
      .mockResolvedValueOnce(ok({ revision: 8 }, "csrf-next"))
      .mockResolvedValueOnce(ok({ authenticated: false }));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const sessionStorage = vi.spyOn(window.sessionStorage, "setItem");
    const client = createAdminApi(fetcher);
    await client.login("a very long private passphrase");
    await client.updateSettings({ allowNewDeviceRequests: false });
    await client.logout();

    expect(fetcher.mock.calls.every(([, init]) => init.credentials === "include")).toBe(true);
    expect(new Headers(fetcher.mock.calls[1]![1].headers).get("x-csrf-token")).toBe("csrf-login");
    expect(new Headers(fetcher.mock.calls[2]![1].headers).get("x-csrf-token")).toBe("csrf-next");
    expect(storage).not.toHaveBeenCalled();
    expect(sessionStorage).not.toHaveBeenCalled();
  });

  it("does not let an older concurrent response replace a newer CSRF token", async () => {
    let resolveOld!: (value: Response) => void;
    const old = new Promise<Response>(resolve => { resolveOld = resolve; });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: true }, "csrf-login"))
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce(ok(snapshot, "csrf-new"))
      .mockResolvedValueOnce(ok({ authenticated: false }));
    const client = createAdminApi(fetcher);
    await client.login("a very long private passphrase");
    const mutation = client.updateSettings({ allowNewDeviceRequests: false });
    await client.snapshot();
    resolveOld(ok({ revision: 8 }, "csrf-old"));
    await mutation;
    await client.logout();

    expect(new Headers(fetcher.mock.calls[3]![1].headers).get("x-csrf-token")).toBe("csrf-new");
  });

  it("retries one mutation after a safe 403 response refreshes CSRF", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: true }, "csrf-old"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "CSRF_INVALID", message: "internal detail" }), { status: 403, headers: { "content-type": "application/json", "x-csrf-token": "csrf-new" } }))
      .mockResolvedValueOnce(ok({ revision: 8 }));
    const client = createAdminApi(fetcher);
    await client.login("a very long private passphrase");
    await client.updateSettings({ allowNewDeviceRequests: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[2]![1].headers).get("x-csrf-token")).toBe("csrf-new");
  });

  it("does not retry origin failures and maps server and network failures to safe copy", async () => {
    const forbidden = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "ORIGIN_INVALID", message: "secret internal origin detail" }), { status: 403, headers: { "content-type": "application/json", "x-csrf-token": "csrf-new" } }));
    await expect(createAdminApi(forbidden).logout()).rejects.toMatchObject({ status: 403, code: "ORIGIN_INVALID", message: "This admin request was blocked." });
    expect(forbidden).toHaveBeenCalledTimes(1);
    await expect(createAdminApi(vi.fn().mockRejectedValue(new TypeError("network details"))).snapshot()).rejects.toEqual(expect.objectContaining<Partial<AdminApiError>>({ status: 0, code: "NETWORK_ERROR", message: "Cloudframe could not reach the server." }));
  });

  it("strictly rejects malformed success and error payloads", async () => {
    await expect(createAdminApi(vi.fn().mockResolvedValue(ok({ ...snapshot, internalRootAncestry: ["secret"] }))).snapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(createAdminApi(vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: { code: "PRIVATE", message: "token" } }), { status: 500 }))).snapshot()).rejects.toMatchObject({ code: "REQUEST_FAILED", message: "Cloudframe is temporarily unavailable. Try again." });
  });

  it("rejects hostile successful response objects as INVALID_RESPONSE", async () => {
    const hostileValues: unknown[] = [];
    const inherited = Object.create({ revision: 7 });
    Object.assign(inherited, snapshot);
    hostileValues.push(inherited);
    hostileValues.push(Object.assign(new (class Snapshot {})(), snapshot));
    const symbolRecord = { ...snapshot } as Record<PropertyKey, unknown>;
    symbolRecord[Symbol("hidden")] = true;
    hostileValues.push(symbolRecord);
    const nonEnumerable = { ...snapshot };
    Object.defineProperty(nonEnumerable, "hidden", { value: true, enumerable: false });
    hostileValues.push(nonEnumerable);
    const getter = { ...snapshot } as Record<string, unknown>;
    Object.defineProperty(getter, "revision", { enumerable: true, get() { throw new Error("getter executed"); } });
    hostileValues.push(getter);
    hostileValues.push(new Proxy({ ...snapshot }, { ownKeys() { throw new Error("proxy trap"); } }));
    hostileValues.push({ ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 });

    for (const data of hostileValues) {
      const payload = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(payload, {
        ok: { value: true, enumerable: true },
        data: { value: data, enumerable: true }
      });
      await expect(createAdminApi(vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(payload)
      } as unknown as Response)).snapshot()).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "The server returned an unexpected response." });
    }
  });

  it("accepts null-prototype data records", async () => {
    const data = Object.assign(Object.create(null), snapshot);
    const payload = Object.assign(Object.create(null), { ok: true, data });
    const response = { ok: true, status: 200, headers: new Headers(), json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
    await expect(createAdminApi(vi.fn().mockResolvedValue(response)).snapshot()).resolves.toEqual(snapshot);
  });

  it("allows only exact provider authorization endpoints", async () => {
    const valid = [
      ["google", "https://accounts.google.com/o/oauth2/v2/auth?client_id=one"],
      ["onedrive", "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=one"]
    ] as const;
    for (const [provider, authorizationUrl] of valid) {
      await expect(createAdminApi(vi.fn().mockResolvedValue(ok({ authorizationUrl }))).authorizeSource(provider)).resolves.toEqual({ authorizationUrl });
    }
    const hostile = [
      ["google", "https://evil.test/o/oauth2/v2/auth"],
      ["google", "https://accounts.google.com:444/o/oauth2/v2/auth"],
      ["google", "https://user:pass@accounts.google.com/o/oauth2/v2/auth"],
      ["google", "https://accounts.google.com/o/oauth2/v2/auth#fragment"],
      ["google", "https://accounts.google.com/o/oauth2/v2/auth/../token"],
      ["onedrive", "https://login.microsoftonline.com/common/extra/oauth2/v2.0/authorize"],
      ["onedrive", "https://login.microsoftonline.com/common%2Fevil/oauth2/v2.0/authorize"],
      ["onedrive", "https://login.microsoftonline.com/../common/oauth2/v2.0/authorize"],
      ["onedrive", "https://login.microsoftonline.com//oauth2/v2.0/authorize"]
    ] as const;
    for (const [provider, authorizationUrl] of hostile) {
      await expect(createAdminApi(vi.fn().mockResolvedValue(ok({ authorizationUrl }))).authorizeSource(provider)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("uses exact final routes and mutation bodies", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: false, revision: 8 }))
      .mockResolvedValueOnce(ok({ removed: true, roots: [], devices: [] }));
    const client = createAdminApi(fetcher);
    await client.rotatePassphrase("current passphrase value", "replacement passphrase value");
    await client.removeSource("source/a");

    expect(fetcher.mock.calls[0]![0]).toBe("/api/admin/passphrase");
    expect(fetcher.mock.calls[0]![1].body).toBe(JSON.stringify({ currentPassphrase: "current passphrase value", newPassphrase: "replacement passphrase value" }));
    expect(fetcher.mock.calls[1]![0]).toBe("/api/admin/sources/source%2Fa");
    expect(fetcher.mock.calls[1]![1].body).toBe(JSON.stringify({ confirm: true }));
  });

  it("encodes live provider folder paging parameters without leaking them into storage", async () => {
    const providerRoot = { providerNodeId: "provider-root", parentProviderId: null, name: "My Drive", assignedRootId: null };
    const fetcher = vi.fn().mockResolvedValue(ok({ source, current: providerRoot, breadcrumbs: [providerRoot], folders: [], nextCursor: null }));
    const client = createAdminApi(fetcher);
    const controller = new AbortController();

    await client.providerFolders("source/a", { providerFolderId: "folder & one", cursor: "cursor+/=", limit: 25, signal: controller.signal });

    expect(fetcher.mock.calls[0]![0]).toBe("/api/admin/sources/source%2Fa/provider-folders?providerFolderId=folder+%26+one&cursor=cursor%2B%2F%3D&limit=25");
    expect(fetcher.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});
