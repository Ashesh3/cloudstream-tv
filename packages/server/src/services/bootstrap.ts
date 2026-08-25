import type { Household } from "@cloudframe/shared";
import { hashPassphrase } from "../auth/passphrase";
import type { ApiAppDependencies } from "../http/app";
import { HttpError } from "../http/errors";

export async function ensureHousehold(
  dependencies: ApiAppDependencies,
  now: Date
): Promise<Household> {
  const existing = await dependencies.repository.getHousehold(
    dependencies.config.householdId
  );
  if (existing) return existing;
  const passphrase = dependencies.config.adminInitialPassphrase;
  if (!passphrase || passphrase.length < 16) {
    throw new HttpError(
      503,
      "BOOTSTRAP_NOT_CONFIGURED",
      "Initial household setup is not configured."
    );
  }
  const household: Household = {
    id: dependencies.config.householdId,
    createdAt: now,
    allowNewDeviceRequests: true,
    defaultMediaOrder: "captured-desc",
    defaultSlideshowSeconds: 8,
    adminPassphraseHash: await hashPassphrase(
      passphrase,
      dependencies.config.passphrasePepper
    ),
    adminPassphraseVersion: 1
  };
  return dependencies.repository.createHouseholdIfAbsent(household);
}
