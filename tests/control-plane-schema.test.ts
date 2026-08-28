import { describe, expect, it } from "vitest";

import {
  cloneControlPlaneDocument,
  parseControlPlaneDocument,
  pruneExpiredRequests
} from "@cloudframe/server";
import {
  TEST_NOW,
  testControlDevice,
  testControlDocument
} from "./helpers/control-plane";

const invalidDocument = (code = "CONTROL_PLANE_INVALID") =>
  expect.objectContaining({ code });

describe("control-plane document schema", () => {
  it("rejects an oversized control document before storage", () => {
    const document = testControlDocument();
    document.devices = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `d${index}`,
        testControlDevice(`d${index}`)
      ])
    );

    expect(() => parseControlPlaneDocument(document)).toThrowError(
      invalidDocument("CONTROL_PLANE_LIMIT_EXCEEDED")
    );
  });

  it("enforces every collection and ancestry ceiling", () => {
    const cases = [
      () => {
        const document = testControlDocument();
        document.pendingDeviceRequests = Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `request-${index}`,
            { ...document.pendingDeviceRequests["request-1"], id: `request-${index}` }
          ])
        );
        return document;
      },
      () => {
        const document = testControlDocument();
        document.sources = Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [
            `source-${index}`,
            { ...document.sources["source-1"], id: `source-${index}` }
          ])
        );
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots = Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [
            `root-${index}`,
            { ...document.roots["root-1"], id: `root-${index}` }
          ])
        );
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots["root-1"].ancestryProviderIds = Array.from(
          { length: 65 },
          (_, index) => `ancestor-${index}`
        );
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots = {
          "root-1": {
            ...document.roots["root-1"],
            ancestryProviderIds: Array.from(
              { length: 33 },
              (_, index) => `first-${index}`
            )
          },
          "root-2": {
            ...document.roots["root-1"],
            id: "root-2",
            ancestryProviderIds: Array.from(
              { length: 32 },
              (_, index) => `second-${index}`
            )
          }
        };
        return document;
      },
      () => {
        const document = testControlDocument();
        document.devices["device-1"].name = "x".repeat(121);
        return document;
      }
    ];

    for (const build of cases) {
      expect(() => parseControlPlaneDocument(build())).toThrowError(
        invalidDocument("CONTROL_PLANE_LIMIT_EXCEEDED")
      );
    }
  });

  it("rejects broken record identity and cross-record references", () => {
    const cases = [
      () => {
        const document = testControlDocument();
        document.devices["device-1"].id = "different";
        return document;
      },
      () => {
        const document = testControlDocument();
        document.devices["device-1"].assignedRootIds = ["missing"];
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots["root-1"].enabled = false;
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots["root-1"].sourceId = "missing";
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots["root-1"].ancestryProviderIds = ["same", "same"];
        return document;
      }
    ];

    for (const build of cases) {
      expect(() => parseControlPlaneDocument(build())).toThrowError(invalidDocument());
    }
  });

  it("rejects malformed names, ids, versions, and timestamps", () => {
    const cases = [
      () => {
        const document = testControlDocument();
        document.devices["device-1"].name = " Living Room";
        return document;
      },
      () => {
        const document = testControlDocument();
        document.sources["source-1"].accountLabel = "";
        return document;
      },
      () => {
        const document = testControlDocument();
        document.sources["source-1"].providerAccountId = "";
        return document;
      },
      () => {
        const document = testControlDocument();
        document.roots["root-1"].providerNodeId = "";
        return document;
      },
      () => ({ ...testControlDocument(), revision: 0 }),
      () => {
        const document = testControlDocument();
        document.devices["device-1"].sessionVersion = 1.5;
        return document;
      },
      () => {
        const document = testControlDocument();
        document.updatedAt = "2026-08-27";
        return document;
      }
    ];

    for (const build of cases) {
      expect(() => parseControlPlaneDocument(build())).toThrowError(invalidDocument());
    }
  });

  it("returns independent deep clones", () => {
    const input = testControlDocument();
    const parsed = parseControlPlaneDocument(input);
    const cloned = cloneControlPlaneDocument(parsed);

    input.devices["device-1"].name = "Input mutation";
    cloned.devices["device-1"].assignedRootIds.length = 0;

    expect(parsed.devices["device-1"].name).toBe("Living Room");
    expect(parsed.devices["device-1"].assignedRootIds).toEqual(["root-1"]);
  });

  it("expires elapsed pending requests without mutating the input", () => {
    const input = testControlDocument();
    input.pendingDeviceRequests["request-1"].expiresAt = new Date(
      TEST_NOW.getTime() - 1
    ).toISOString();

    const pruned = pruneExpiredRequests(input, TEST_NOW);

    expect(pruned.pendingDeviceRequests["request-1"]).toMatchObject({
      status: "expired",
      resolvedAt: TEST_NOW.toISOString()
    });
    expect(input.pendingDeviceRequests["request-1"]).toMatchObject({
      status: "pending",
      resolvedAt: null
    });
  });
});
