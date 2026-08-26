import { createIndexOrchestrator, type SyncWorkflowRunner } from "@cloudframe/indexer";
import { createGoogleDriveAdapter, createOneDriveAdapter, createProviderRegistry } from "@cloudframe/providers";
import { createFirestoreClient } from "../firestore/client";
import { FirestoreRepository } from "../firestore/repository";
import { createSourceService } from "../services/sources";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function createServerSyncWorkflowRunner(): SyncWorkflowRunner {
  const firestore = createFirestoreClient({
    environment: process.env.VERCEL_ENV === "production" ? "production" : "staging",
    projectId: required("FIRESTORE_PROJECT_ID"),
    databaseId: process.env.FIRESTORE_DATABASE_ID,
    emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    workloadIdentityProvider: process.env.GCP_WORKLOAD_IDENTITY_PROVIDER,
    serviceAccountEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL
  });
  const repository = new FirestoreRepository(firestore);
  const providers = createProviderRegistry({
    google: createGoogleDriveAdapter({
      clientId: required("GOOGLE_CLIENT_ID"),
      clientSecret: required("GOOGLE_CLIENT_SECRET"),
      fetch,
      now: () => new Date()
    }),
    onedrive: createOneDriveAdapter({
      clientId: required("ONEDRIVE_CLIENT_ID"),
      clientSecret: required("ONEDRIVE_CLIENT_SECRET"),
      fetch,
      now: () => new Date()
    })
  });
  const tokenKeyVersion = process.env.PROVIDER_TOKEN_KEY_VERSION ?? "v1";
  const tokenKey = Buffer.from(
    required(`PROVIDER_TOKEN_KEY_${tokenKeyVersion.toUpperCase()}`),
    "base64url"
  );
  const sourceService = createSourceService({
    repository,
    providers,
    keyring: {
      currentVersion: tokenKeyVersion,
      keys: { [tokenKeyVersion]: tokenKey }
    },
    now: () => new Date()
  });

  return createIndexOrchestrator({
    repository,
    providers,
    getCredentials: (sourceId, householdId) =>
      sourceService.getUsableCredentials(sourceId, householdId),
    now: () => new Date()
  });
}
