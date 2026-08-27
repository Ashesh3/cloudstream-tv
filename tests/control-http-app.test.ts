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
});
