import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  cookieHeader,
  createControlApiHarness,
  jsonRequest
} from "./helpers/api";

describe("final control HTTP API", () => {
  it("serves the final route table with no sync or server-history endpoints", async () => {
    const harness = await createControlApiHarness();

    const snapshot = await harness.app(
      jsonRequest(
        "/api/admin/snapshot",
        "GET",
        undefined,
        harness.adminHeaders()
      )
    );

    expect(snapshot.status).toBe(200);
    expect(
      (await harness.app(jsonRequest("/api/internal/sync-due-sources", "GET")))
        .status
    ).toBe(404);
    expect(
      (
        await harness.app(
          jsonRequest(
            "/api/tv/watch-history",
            "GET",
            undefined,
            harness.deviceHeaders()
          )
        )
      ).status
    ).toBe(404);
    expect(
      (
        await harness.app(
          jsonRequest(
            "/api/tv/heartbeat",
            "POST",
            {},
            harness.deviceHeaders()
          )
        )
      ).status
    ).toBe(404);
  });

  it("accepts sealed handles, not raw node ids", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(harness.mediaRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { itemId: expect.stringMatching(/^item_/) }
    });

    const rejected = await harness.app(
      jsonRequest(
        "/api/tv/media-url",
        "POST",
        { nodeId: "node-1" },
        harness.deviceHeaders()
      )
    );
    expect(rejected.status).toBe(400);
  });

  it("does not expose a Firestore repository in API dependencies", () => {
    const source = readFileSync(
      "packages/server/src/http/control-app.ts",
      "utf8"
    );
    expect(source).not.toMatch(
      /AppRepository|FirestoreRepository|createFirestoreClient/
    );
  });

  it("loads and conditionally revalidates the active control snapshot once per protected request", async () => {
    const harness = await createControlApiHarness();

    await harness.app(harness.folderRequest());

    expect(harness.controlStore.loadCount).toBe(1);
    expect(harness.durable.conditionalReadCount).toBe(1);
  });

  it("reuses the same request context in live admin folder services", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(
      jsonRequest(
        "/api/admin/sources/source-1/provider-folders",
        "GET",
        undefined,
        harness.adminHeaders()
      )
    );

    expect(response.status).toBe(200);
    expect(harness.controlStore.loadCount).toBe(1);
    expect(harness.durable.conditionalReadCount).toBe(1);
  });

  it("keeps mutation services on the store mutation boundary without a redundant HTTP load", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        { allowNewDeviceRequests: false },
        harness.adminMutationHeaders()
      )
    );

    expect(response.status).toBe(200);
    expect(harness.controlStore.loadCount).toBe(1);
    expect(harness.controlStore.mutateCount).toBe(1);
    expect(harness.durable.readCount).toBe(2);
  });

  it("rejects duplicate sensitive cookies at the same safe boundary", async () => {
    const harness = await createControlApiHarness();
    const device = harness.deviceCookie;
    const request = harness.requestCookie;

    const duplicateDevice = await harness.app(
      jsonRequest("/api/tv/home", "GET", undefined, {
        cookie: cookieHeader(
          ["device_session", device],
          ["device_session", device]
        )
      })
    );
    expect(duplicateDevice.status).toBe(401);
    expect(duplicateDevice.headers.getSetCookie().join("\n")).toMatch(
      /device_session=;.*Max-Age=0/
    );

    const duplicateRequest = await harness.app(
      jsonRequest("/api/device-requests/status", "GET", undefined, {
        cookie: cookieHeader(
          ["device_request", request],
          ["device_request", request]
        )
      })
    );
    expect(duplicateRequest.status).toBe(401);
    expect(duplicateRequest.headers.getSetCookie().join("\n")).toMatch(
      /device_request=;.*Max-Age=0/
    );
  });

  it("requires exact origin and CSRF for unsafe admin requests", async () => {
    const harness = await createControlApiHarness();
    const body = { allowNewDeviceRequests: false };

    const missingOrigin = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        body,
        harness.adminHeaders({ "x-csrf-token": harness.adminCsrf })
      )
    );
    expect(missingOrigin.status).toBe(403);

    const missingCsrf = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        body,
        harness.adminHeaders({ origin: harness.origin })
      )
    );
    expect(missingCsrf.status).toBe(403);

    const accepted = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        body,
        harness.adminMutationHeaders()
      )
    );
    expect(accepted.status).toBe(200);
  });

  it("returns no-store, no-referrer JSON with a safe request id", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(
      jsonRequest("/api/tv/home", "GET", undefined, {
        ...harness.deviceHeaders(),
        "x-request-id": "request-safe"
      })
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBe("request-safe");
  });

  it("clears OAuth state on a malformed callback without exposing state", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(
      jsonRequest(
        "/api/admin/sources/google/callback?state=one&state=two&code=secret",
        "GET",
        undefined,
        {
          ...harness.adminHeaders(),
          cookie: cookieHeader(
            ["admin_session", harness.adminCookie],
            ["oauth_state", "sealed-oauth"]
          )
        }
      )
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("oauth=invalid");
    expect(response.headers.getSetCookie().join("\n")).toMatch(
      /oauth_state=;.*Max-Age=0/
    );
    expect(await response.text()).toBe("");
  });

  it("does not serialize provider ids or legacy last-seen fields in impact responses", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(
      jsonRequest(
        "/api/admin/sources/source-1/impact",
        "GET",
        undefined,
        harness.adminHeaders()
      )
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(serialized).not.toMatch(
      /providerNodeId|ancestryProviderIds|lastSeenAt|credentialVersion|encrypted/
    );
  });

  it("rejects oversized JSON before authentication or provider work", async () => {
    const harness = await createControlApiHarness();
    const request = new Request(`${harness.origin}/api/tv/media-url`, {
      method: "POST",
      headers: {
        ...harness.deviceHeaders(),
        "content-type": "application/json",
        "content-length": "32769"
      },
      body: JSON.stringify({ handle: "x" })
    });

    const response = await harness.app(request);

    expect(response.status).toBe(413);
    expect(harness.controlStore.loadCount).toBe(0);
    expect(harness.provider.mediaUrlCalls).toBe(0);
  });

  it("rejects malformed unsafe admin bodies before loading control state", async () => {
    const harness = await createControlApiHarness();

    const response = await harness.app(
      jsonRequest(
        "/api/admin/settings",
        "PATCH",
        { allowNewDeviceRequests: false, providerNodeId: "raw-node" },
        harness.adminMutationHeaders()
      )
    );

    expect(response.status).toBe(400);
    expect(harness.controlStore.loadCount).toBe(0);
  });

  it("logs only static route templates for successful and failed dynamic routes", async () => {
    const harness = await createControlApiHarness();
    const sealedHandle = new URL(harness.folderRequest().url).pathname.split("/").at(-1)!;
    const dynamicId = "device-secret-id";
    const querySecret = "opaque-query-secret";

    await harness.app(harness.folderRequest());
    await harness.app(
      jsonRequest(
        `/api/admin/devices/${dynamicId}?leak=${querySecret}`,
        "GET",
        undefined,
        harness.adminHeaders()
      )
    );

    expect(harness.events.map((event) => event.path)).toEqual([
      "/api/tv/folders/:handle",
      "/api/admin/devices/:id"
    ]);
    const serialized = JSON.stringify(harness.events);
    expect(serialized).not.toContain(sealedHandle);
    expect(serialized).not.toContain(dynamicId);
    expect(serialized).not.toContain(querySecret);
  });

  it("projects browser-safe DTOs for device and destructive mutations", async () => {
    const deviceHarness = await createControlApiHarness();
    const updated = await deviceHarness.app(
      jsonRequest(
        "/api/admin/devices/device-1",
        "PATCH",
        { name: "Den TV" },
        deviceHarness.adminMutationHeaders()
      )
    );
    const updatedJson = JSON.stringify(await updated.json());
    expect(updated.status).toBe(200);
    expect(updatedJson).not.toMatch(/lastSeenAt|sessionVersion|credentialVersion|encrypted/);

    const sourceHarness = await createControlApiHarness();
    const removedSource = await sourceHarness.app(
      jsonRequest(
        "/api/admin/sources/source-1",
        "DELETE",
        { confirm: true },
        sourceHarness.adminMutationHeaders()
      )
    );
    const sourceJson = JSON.stringify(await removedSource.json());
    expect(removedSource.status).toBe(200);
    expect(sourceJson).not.toMatch(
      /providerNodeId|ancestryProviderIds|lastSeenAt|sessionVersion|credentialVersion|encrypted/
    );

    const rootHarness = await createControlApiHarness();
    const removedRoot = await rootHarness.app(
      jsonRequest(
        "/api/admin/roots/root-1",
        "DELETE",
        { confirm: true },
        rootHarness.adminMutationHeaders()
      )
    );
    const rootJson = JSON.stringify(await removedRoot.json());
    expect(removedRoot.status).toBe(200);
    expect(rootJson).not.toMatch(
      /providerNodeId|ancestryProviderIds|lastSeenAt|sessionVersion|credentialVersion|encrypted/
    );
  });

  it.each([
    ["missing admin", ""],
    ["duplicate admin", "duplicate"]
  ])("clears OAuth state when callback authentication is %s", async (_name, mode) => {
    const harness = await createControlApiHarness();
    const callback = await harness.oauthCallbackRequest("google");
    const cookies: Array<[string, string]> = [["oauth_state", callback.oauthCookie]];
    if (mode === "duplicate") {
      cookies.push(["admin_session", harness.adminCookie]);
      cookies.push(["admin_session", harness.adminCookie]);
    }
    const response = await harness.app(
      jsonRequest(callback.path, "GET", undefined, {
        cookie: cookieHeader(...cookies)
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("oauth=invalid");
    const setCookies = response.headers.getSetCookie().join("\n");
    expect(setCookies).toMatch(/oauth_state=;.*Max-Age=0/);
    expect(setCookies).toMatch(/admin_session=;.*Max-Age=0/);
  });

  it.each([
    ["store unavailable", "store"],
    ["unexpected service error", "service"]
  ])("clears OAuth state and redirects when the callback hits %s", async (_name, failure) => {
    const harness = await createControlApiHarness();
    const callback = await harness.oauthCallbackRequest("google");
    if (failure === "store") harness.failNextControlLoad();
    else harness.failOAuthComplete(new Error("secret unexpected failure"));

    const response = await harness.app(
      jsonRequest(callback.path, "GET", undefined, {
        cookie: cookieHeader(
          ["admin_session", harness.adminCookie],
          ["oauth_state", callback.oauthCookie]
        )
      })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("oauth=failed");
    expect(response.headers.getSetCookie().join("\n")).toMatch(
      /oauth_state=;.*Max-Age=0/
    );
    expect(JSON.stringify(harness.events)).not.toContain("secret unexpected failure");
  });

  it.each([
    [null, [new Uint8Array(20_000), new Uint8Array(20_000)]],
    ["10", [new Uint8Array(20_000), new Uint8Array(20_000)]]
  ])("caps chunked JSON bodies without trusting Content-Length %s", async (length, chunks) => {
    const harness = await createControlApiHarness();
    const headers = new Headers({ "content-type": "application/json" });
    if (length !== null) headers.set("content-length", length);
    const request = streamRequest(
      `${harness.origin}/api/tv/media-url`,
      headers,
      chunks
    );

    const response = await harness.app(request);

    expect(response.status).toBe(413);
    expect(harness.controlStore.loadCount).toBe(0);
    expect(harness.provider.mediaUrlCalls).toBe(0);
  });

  it("maps invalid UTF-8 request bodies to safe invalid JSON", async () => {
    const harness = await createControlApiHarness();
    const response = await harness.app(
      streamRequest(
        `${harness.origin}/api/tv/media-url`,
        new Headers({ "content-type": "application/json" }),
        [Uint8Array.from([0xc3, 0x28])]
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "INVALID_JSON" });
    expect(harness.controlStore.loadCount).toBe(0);
  });

  it.each([
    ["/api/bootstrap/", "GET", undefined, {}],
    ["/api/bootstrap?extra=1", "GET", undefined, {}],
    ["/api/tv/home?extra=1", "GET", undefined, "device"],
    ["/api/admin/snapshot?extra=1", "GET", undefined, "admin"],
    ["/api/admin/settings?extra=1", "PATCH", { allowNewDeviceRequests: false }, "mutation"]
  ])("rejects non-exact route or query %s", async (path, method, body, authKind) => {
    const harness = await createControlApiHarness();
    const headers =
      authKind === "device"
        ? harness.deviceHeaders()
        : authKind === "admin"
          ? harness.adminHeaders()
          : authKind === "mutation"
            ? harness.adminMutationHeaders()
            : {};
    const response = await harness.app(jsonRequest(path, method, body, headers));
    expect(response.status).toBe(path.endsWith("/") ? 404 : 400);
  });

  it("rejects unknown or duplicate OAuth callback query keys and accepts documented diagnostics", async () => {
    const invalidHarness = await createControlApiHarness();
    const invalid = await invalidHarness.oauthCallbackRequest("google");
    for (const suffix of ["&unknown=secret", "&scope=one&scope=two"]) {
      const response = await invalidHarness.app(
        jsonRequest(`${invalid.path}${suffix}`, "GET", undefined, {
          cookie: cookieHeader(
            ["admin_session", invalidHarness.adminCookie],
            ["oauth_state", invalid.oauthCookie]
          )
        })
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toContain("oauth=invalid");
    }

    const googleHarness = await createControlApiHarness();
    const google = await googleHarness.oauthCallbackRequest("google");
    const googleResponse = await googleHarness.app(
      jsonRequest(
        `${google.path}&scope=drive&authuser=0&prompt=consent`,
        "GET",
        undefined,
        {
          cookie: cookieHeader(
            ["admin_session", googleHarness.adminCookie],
            ["oauth_state", google.oauthCookie]
          )
        }
      )
    );
    expect(googleResponse.headers.get("location")).toContain("oauth=connected");

    const oneDriveHarness = await createControlApiHarness();
    const oneDrive = await oneDriveHarness.oauthCallbackRequest("onedrive");
    const oneDriveResponse = await oneDriveHarness.app(
      jsonRequest(
        `${oneDrive.path}&session_state=session&trace_id=trace&correlation_id=correlation&timestamp=now`,
        "GET",
        undefined,
        {
          cookie: cookieHeader(
            ["admin_session", oneDriveHarness.adminCookie],
            ["oauth_state", oneDrive.oauthCookie]
          )
        }
      )
    );
    expect(oneDriveResponse.headers.get("location")).toContain("oauth=connected");
  });

  it.each([
    [{ handles: ["one", "one"], maxDimension: 720 }],
    [{ handles: ["one"], maxDimension: 63 }],
    [{ handles: ["one"], maxDimension: 4097 }],
    [{ handles: ["one"], maxDimension: 64.5 }]
  ])("validates thumbnail batches and dimensions before auth or limiting", async (body) => {
    const harness = await createControlApiHarness();
    const response = await harness.app(
      jsonRequest(
        "/api/tv/thumbnail-urls",
        "POST",
        body,
        harness.deviceHeaders()
      )
    );

    expect(response.status).toBe(400);
    expect(harness.controlStore.loadCount).toBe(0);
    expect(harness.rateLimiter.consumeCount).toBe(0);
    expect(harness.provider.thumbnailUrlCalls).toBe(0);
  });
});

function streamRequest(
  url: string,
  headers: Headers,
  chunks: Uint8Array[]
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Request(url, {
    method: "POST",
    headers,
    body,
    duplex: "half"
  } as RequestInit & { duplex: "half" });
}
