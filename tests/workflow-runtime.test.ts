import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

it("keeps each durable workflow step to one orchestrator page", () => {
  const source = readFileSync(new URL("../workflows/sync-source.ts", import.meta.url), "utf8");
  expect(source).toContain('"use step"');
  expect(source).toContain("createServerSyncWorkflowRunner().runNext(sourceId, mode, leaseOwner)");
  expect(source).not.toContain("RESOURCE_EXHAUSTED");
});
