import { FirestoreRepository, createApiApp, createFirestoreClient } from "@cloudframe/server";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const firestore = createFirestoreClient({
  environment: process.env.VERCEL_ENV === "production" ? "production" : "staging",
  projectId: required("FIRESTORE_PROJECT_ID"),
  databaseId: process.env.FIRESTORE_DATABASE_ID,
  emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
  workloadIdentityProvider: process.env.GCP_WORKLOAD_IDENTITY_PROVIDER,
  serviceAccountEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL
});

const app = createApiApp({
  repository: new FirestoreRepository(firestore),
  config: {
    householdId: required("HOUSEHOLD_ID"),
    adminInitialPassphrase: process.env.ADMIN_INITIAL_PASSPHRASE,
    passphrasePepper: required("ADMIN_PASSPHRASE_PEPPER"),
    csrfSecret: required("CSRF_SECRET"),
    allowedOrigin: required("APP_ORIGIN")
  }
});

export default {
  fetch(request: Request): Promise<Response> {
    return app(request);
  }
};
