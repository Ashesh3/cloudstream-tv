import { Firestore } from "@google-cloud/firestore";
import { readFile } from "node:fs/promises";

import { createVercelBlobControlStore } from "../packages/server/src/control-plane/vercel-blob.ts";
import { createVercelRuntimeControlCache } from "../packages/server/src/control-plane/runtime-cache.ts";
import type { ControlPlaneDocumentV2 } from "../packages/shared/src/control-plane.ts";
import {
  runControlPlaneMigration,
  createMigrationFirestoreReader,
  type LegacyControlPlaneReader,
  type LegacyMigrationCollection
} from "./lib/control-plane-ops.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fixturePath = valueAfter("--fixture");
if (fixturePath && apply) throw new Error("FIXTURE_APPLY_FORBIDDEN");
const householdId = required("HOUSEHOLD_ID");
const environment = required("CONTROL_PLANE_ENV");
const reader = fixturePath
  ? fixtureAdapter(JSON.parse(await readFile(fixturePath, "utf8")) as unknown)
  : createMigrationFirestoreReader(new Firestore({
      projectId: required("FIRESTORE_PROJECT_ID"),
      databaseId: process.env.FIRESTORE_DATABASE_ID || "(default)"
    }));
const result = apply
  ? await runControlPlaneMigration({
      apply,
      environment,
      householdId,
      now: new Date(),
      firestore: reader,
      ...activeStoreDependencies()
    })
  : await runControlPlaneMigration({
      apply,
      environment,
      householdId,
      now: new Date(),
      firestore: reader,
      ...unusedStoreDependencies()
    });

process.stdout.write(`${JSON.stringify(result)}\n`);

function fixtureAdapter(value: unknown): LegacyControlPlaneReader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("FIXTURE_INVALID");
  }
  const fixture = value as Record<string, unknown>;
  return {
    async listCollection(name: LegacyMigrationCollection) {
      const records = fixture[name];
      if (!Array.isArray(records)) throw new Error("FIXTURE_INVALID");
      return structuredClone(records) as Array<Record<string, unknown>>;
    },
    async readRecovery(_path: string) {
      void _path;
      throw new Error("FIXTURE_RECOVERY_READ_FORBIDDEN");
    },
    async writeRecovery(_path: string, _document: ControlPlaneDocumentV2) {
      void _path;
      void _document;
      throw new Error("FIXTURE_RECOVERY_WRITE_FORBIDDEN");
    }
  };
}

function decodeKey(value: string): Uint8Array {
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new Error("CONTROL_PLANE_KEY_INVALID");
  }
  return key;
}

function activeStoreDependencies() {
  const keyVersion = process.env.CONTROL_PLANE_KEY_VERSION ?? "v1";
  const key = decodeKey(required(`CONTROL_PLANE_KEY_${keyVersion.toUpperCase()}`));
  return {
    durable: createVercelBlobControlStore({
      environment,
      householdId,
      storeId: process.env.BLOB_STORE_ID
    }),
    cache: createVercelRuntimeControlCache({ environment, householdId }),
    keyring: { currentVersion: keyVersion, keys: { [keyVersion]: key } }
  };
}

function unusedStoreDependencies() {
  return {
    durable: forbiddenStore("DRY_RUN_BLOB_ACCESS_FORBIDDEN"),
    cache: forbiddenCache(),
    keyring: { currentVersion: "unused", keys: {} }
  };
}

function forbiddenStore(message: string) {
  const fail = async () => { throw new Error(message); };
  return { read: fail, create: fail, replace: fail };
}

function forbiddenCache() {
  const fail = async () => { throw new Error("DRY_RUN_CACHE_ACCESS_FORBIDDEN"); };
  return {
    get: fail,
    set: fail,
    delete: fail,
    getMirrorStatus: fail,
    setMirrorStatus: fail
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function valueAfter(flag: string): string | null {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}
