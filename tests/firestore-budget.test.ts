import { expect, it } from "vitest";

import { createControlApiHarness } from "./helpers/api";

it("performs zero Firestore reads across 10,000 browse and media requests", async () => {
  const harness = await createControlApiHarness();

  for (let index = 0; index < 5_000; index += 1) {
    const folder = await harness.app(harness.folderRequest());
    const media = await harness.app(harness.mediaRequest());
    if (folder.status !== 200 || media.status !== 200) {
      throw new Error(`Unexpected status at ${index}: ${folder.status}/${media.status}`);
    }
  }

  expect(harness.firestore.readCount).toBe(0);
  expect(harness.firestore.writeCount).toBe(0);
  expect(harness.controlStore.loadCount).toBe(10_000);
  expect(harness.durable.conditionalReadCount).toBe(10_000);
  expect(harness.provider.listFolderCalls).toBe(5_000);
  expect(harness.provider.mediaUrlCalls).toBe(5_000);
});
