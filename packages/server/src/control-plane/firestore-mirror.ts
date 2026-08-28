import type { Firestore } from "@google-cloud/firestore";

import type { RecoveryMirror } from "./store";

export function createFirestoreRecoveryMirror(
  firestore: Pick<Firestore, "collection">,
  householdId: string
): RecoveryMirror {
  return {
    async write(document) {
      if (document.householdId !== householdId) {
        throw new Error("Household mismatch");
      }
      await firestore.collection("controlPlaneBackups").doc(householdId).set(document);
    }
  };
}
