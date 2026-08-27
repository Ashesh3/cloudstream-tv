// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { AdminApiError, createAdminApi } from "./client";

const ok = <T>(data: T, csrf?: string) => new Response(JSON.stringify({ ok: true, data }), {
  status: 200,
  headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }
});

describe("admin API browser boundary", () => {
  it("always includes cookies and keeps refreshed CSRF only in the client closure", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: true }, "csrf-login"))
      .mockResolvedValueOnce(ok({ allowNewDeviceRequests: false, defaultMediaOrder: "name-asc", defaultSlideshowSeconds: 12 }, "csrf-next"))
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

  it("retries one mutation after a safe 403 response refreshes CSRF", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: true }, "csrf-old"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "CSRF_INVALID", message: "Retry safely." }), { status: 403, headers: { "content-type": "application/json", "x-csrf-token": "csrf-new" } }))
      .mockResolvedValueOnce(ok({ allowNewDeviceRequests: false, defaultMediaOrder: "captured-desc", defaultSlideshowSeconds: 8 }));
    const client = createAdminApi(fetcher);
    await client.login("a very long private passphrase");
    await client.updateSettings({ allowNewDeviceRequests: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(new Headers(fetcher.mock.calls[2]![1].headers).get("x-csrf-token")).toBe("csrf-new");
  });

  it("does not retry 403 without a refreshed token and maps offline failures safely", async () => {
    const forbidden = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "ORIGIN_INVALID", message: "Origin check failed." }), { status: 403, headers: { "content-type": "application/json" } }));
    await expect(createAdminApi(forbidden).logout()).rejects.toMatchObject({ status: 403, code: "ORIGIN_INVALID" });
    expect(forbidden).toHaveBeenCalledTimes(1);
    await expect(createAdminApi(vi.fn().mockRejectedValue(new TypeError("network details"))).overview()).rejects.toEqual(expect.objectContaining<Partial<AdminApiError>>({ status: 0, code: "NETWORK_ERROR", message: "Cloudframe could not reach the server." }));
  });

  it("never retries an origin failure even when a token header is present", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(ok({ authenticated: true }, "csrf-old"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "ORIGIN_INVALID", message: "Origin check failed." }), { status: 403, headers: { "content-type": "application/json", "x-csrf-token": "csrf-new" } }));
    const client = createAdminApi(fetcher);
    await client.login("a very long private passphrase");
    await expect(client.logout()).rejects.toMatchObject({ code: "ORIGIN_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("encodes live provider folder paging parameters without leaking them into storage", async () => {
    const fetcher = vi.fn().mockResolvedValue(ok({
      source: {},
      current: {},
      breadcrumbs: [],
      folders: [],
      nextCursor: null
    }));
    const client = createAdminApi(fetcher);
    const controller = new AbortController();

    await client.providerFolders("source/a", {
      providerFolderId: "folder & one",
      cursor: "cursor+/=",
      limit: 25,
      signal: controller.signal
    });

    expect(fetcher.mock.calls[0]![0]).toBe(
      "/api/admin/sources/source%2Fa/provider-folders?providerFolderId=folder+%26+one&cursor=cursor%2B%2F%3D&limit=25"
    );
    expect(fetcher.mock.calls[0]![1].signal).toBe(controller.signal);
  });
});
