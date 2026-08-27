import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";

import { createFirestoreRecoveryMirror } from "../packages/server/src/control-plane/firestore-mirror";
import { testControlDocument } from "./helpers/control-plane";

function firestoreHarness() {
  const set = vi.fn(async () => undefined);
  const doc = vi.fn(() => ({ set }));
  const collection = vi.fn(() => ({ doc }));
  return {
    firestore: { collection } as unknown as Pick<Firestore, "collection">,
    collection,
    doc,
    set
  };
}

describe("Firestore recovery mirror", () => {
  it("writes one full document to the exact household backup path", async () => {
    const harness = firestoreHarness();
    const mirror = createFirestoreRecoveryMirror(harness.firestore, "h1");
    const document = testControlDocument();

    await mirror.write(document);

    expect(harness.collection).toHaveBeenCalledWith("controlPlaneBackups");
    expect(harness.doc).toHaveBeenCalledWith("h1");
    expect(harness.set).toHaveBeenCalledWith(document);
    expect(harness.set.mock.calls[0]).toHaveLength(1);
    expect("read" in mirror).toBe(false);
  });

  it("rejects a household mismatch before writing", async () => {
    const harness = firestoreHarness();
    const mirror = createFirestoreRecoveryMirror(harness.firestore, "other-household");

    await expect(mirror.write(testControlDocument())).rejects.toThrow("Household mismatch");

    expect(harness.collection).not.toHaveBeenCalled();
    expect(harness.set).not.toHaveBeenCalled();
  });
});
