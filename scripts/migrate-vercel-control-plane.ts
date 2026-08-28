import { Firestore } from "@google-cloud/firestore";
import { readFile } from "node:fs/promises";

import { createVercelBlobControlStore } from "../packages/server/src/control-plane/vercel-blob.ts";
import { createVercelRuntimeControlCache } from "../packages/server/src/control-plane/runtime-cache.ts";
import type { ControlPlaneDocumentV2 } from "../packages/shared/src/control-plane.ts";
import { versionedAeadKeyringFromEnv } from "../packages/server/src/runtime/keyrings.ts";
import {
  createMigrationFirestoreReader,
  loadOperatorCredentials,
  loadProviderTokenKeys,
  runControlPlaneMigration,
  type LegacyControlPlaneReader,
  type LegacyMigrationCollection
} from "./lib/control-plane-ops.ts";

await main();

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const fixturePath = valueAfter(args, "--fixture");
    if (fixturePath && apply) throw new Error("FIXTURE_APPLY_FORBIDDEN");
    const householdId = required("HOUSEHOLD_ID");
    const environment = required("CONTROL_PLANE_ENV");
    const firestore = fixturePath
      ? fixtureAdapter(JSON.parse(await readFile(fixturePath, "utf8")) as unknown)
      : createMigrationFirestoreReader(new Firestore({
          projectId: required("FIRESTORE_PROJECT_ID"),
          databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
          ...await loadOperatorCredentials({
            operatorEmail: process.env.GCP_OPERATOR_SERVICE_ACCOUNT_EMAIL,
            credentialFile: process.env.GCP_OPERATOR_CREDENTIALS_FILE,
            runtimeWriterEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL,
            legacyReaderEmail: process.env.GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL
          })
        }));
    const providerTokenKeys = loadProviderTokenKeys(process.env);
    const result = await runControlPlaneMigration({
      apply,
      environment,
      householdId,
      now: new Date(),
      firestore,
      providerTokenKeys,
      ...(apply
        ? activeStoreDependencies(environment, householdId)
        : unusedStoreDependencies())
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${safeOperationCode(error)}\n`);
    process.exitCode = 1;
  }
}

function fixtureAdapter(value: unknown): LegacyControlPlaneReader {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FIXTURE_INVALID");
  const fixture = value as Record<string, unknown>;
  return {
    async readHousehold(householdId) {
      const records = fixture.households;
      if (!Array.isArray(records)) throw new Error("FIXTURE_INVALID");
      return records.find((record) =>
        !!record && typeof record === "object" && (record as Record<string, unknown>).id === householdId
      ) as Record<string, unknown> | undefined ?? null;
    },
    async queryHouseholdCollection(name: Exclude<LegacyMigrationCollection, "households">, householdId) {
      const records = fixture[name];
      if (!Array.isArray(records)) throw new Error("FIXTURE_INVALID");
      return records.filter((record) =>
        !!record && typeof record === "object" &&
        (record as Record<string, unknown>).householdId === householdId
      ) as Array<Record<string, unknown>>;
    },
    async readRecovery() { throw new Error("FIXTURE_RECOVERY_READ_FORBIDDEN"); },
    async writeRecovery(_path: string, _document: ControlPlaneDocumentV2) {
      void _path; void _document;
      throw new Error("FIXTURE_RECOVERY_WRITE_FORBIDDEN");
    }
  };
}

function activeStoreDependencies(environment: string, householdId: string) {
  const storeId = required("BLOB_STORE_ID");
  return {
    durable: createVercelBlobControlStore({ environment, householdId, storeId }),
    cache: createVercelRuntimeControlCache({ environment, householdId }),
    keyring: versionedAeadKeyringFromEnv(process.env, "CONTROL_PLANE_KEY")
  };
}

function unusedStoreDependencies() {
  const fail = async () => { throw new Error("DRY_RUN_STORAGE_ACCESS_FORBIDDEN"); };
  return {
    durable: { inspect: fail, read: fail, create: fail, replace: fail },
    cache: { get: fail, set: fail, delete: fail, getMirrorStatus: fail, setMirrorStatus: fail },
    keyring: { currentVersion: "unused", keys: {} }
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("CONFIGURATION_INVALID");
  return value;
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

function safeOperationCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error &&
      typeof (error as { code?: unknown }).code === "string" &&
      /^CONTROL_PLANE_[A-Z_]+$/.test((error as { code: string }).code)) {
    return (error as { code: string }).code;
  }
  return "CONTROL_PLANE_OPERATION_FAILED";
}
