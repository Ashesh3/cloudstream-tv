import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createMediaProbeService } from "../packages/server/src/transcode/probe";
import { createProcessRunner } from "../packages/server/src/transcode/process-runner";
import { createTranscodeSourceGateway } from "../packages/server/src/transcode/source-gateway";
import { createContainerTestFixture } from "../packages/server/src/runtime/container-test-fixture";
import type { AuthorizedBrowseItem } from "../packages/server/src/services/live-browse";
import type { TranscodeSourceBinding } from "../packages/server/src/transcode/types";

describe("container smoke fixture", () => {
  it("passes the committed MPEG through the real gateway and FFprobe", async () => {
    const now = () => new Date("2026-08-29T12:00:00.000Z");
    const fixture = await createContainerTestFixture({
      fixturePath: resolve("tests/fixtures/media/legacy-mpeg.mpg"),
      providerTokenKeyring: { currentVersion: "v1", keys: { v1: Buffer.alloc(32, 7) } },
      fallbackFetch: fetch,
      now,
    });
    const item = {
      id: "item_fixture",
      source: { id: "source-container-smoke", provider: "google" },
      claims: { providerNodeId: "fixture-legacy-mpeg" },
    } as AuthorizedBrowseItem;
    const credentials = {
      accessToken: "cloudframe-container-fixture-token",
      refreshToken: null,
      accessTokenExpiresAt: new Date(now().getTime() + 60_000),
    };
    const mediaRequest = await fixture.adapter.getMediaUrl({
      credentials,
      providerNodeId: "fixture-legacy-mpeg",
    });
    if (!("headers" in mediaRequest)) throw new Error("Expected authenticated fixture media");
    const gateway = createTranscodeSourceGateway({
      authorizer: { withReauthorizedItem: async (_binding, operation) => operation(item) },
      mediaSources: {
        resolve: async () => ({
          item,
          provider: "google",
          request: { url: mediaRequest.url, headers: new Headers(mediaRequest.headers), expiresAt: mediaRequest.expiresAt },
          credentialVersion: 1,
        }),
      },
      fetch: fixture.fetcher,
      now,
      randomBytes: size => Buffer.alloc(size, 8),
    });
    await gateway.start();
    try {
      const binding = {
        householdId: "household", deviceId: "device-smoke", deviceSessionVersion: 1,
        sourceId: "source-container-smoke", rootId: "root-container-smoke", rootProviderNodeId: "fixture-root",
        providerNodeId: "fixture-legacy-mpeg", provider: "google", itemId: "item_fixture",
        name: "legacy-mpeg.mpg", mimeType: "video/mpeg", size: fixture.size,
        contentRevision: "fixture-revision-1", credentialVersion: 1,
      } satisfies TranscodeSourceBinding;
      const grant = gateway.grant(binding, "job_" + "a".repeat(32));
      const probe = await createMediaProbeService({ runner: createProcessRunner() }).probe(grant.inputUrl, new AbortController().signal);
      expect(probe).toMatchObject({ videoCodec: "mpeg2video", audioCodec: "mp2", width: 640, height: 360 });
    } finally {
      await gateway.close();
    }
  });
});
