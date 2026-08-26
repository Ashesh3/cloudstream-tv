import {
  FirestoreRepository,
  createApiApp,
  createBrowseService,
  createFirestoreClient,
  createIndexingService,
  createMediaUrlService,
  createOAuthService,
  createSourceService,
  IndexingUnavailableError
} from "@cloudframe/server";
import {
  createGoogleDriveAdapter,
  createOneDriveAdapter,
  createProviderRegistry
} from "@cloudframe/providers";
import {
  configureSyncSourceWorkflow,
  createIndexOrchestrator,
  createInjectedWorkflowLauncher
} from "@cloudframe/indexer";

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
  keyring: { currentVersion: tokenKeyVersion, keys: { [tokenKeyVersion]: tokenKey } },
  now: () => new Date()
});
const browse = createBrowseService({
  repository,
  cursorSecret: required("BROWSE_CURSOR_SECRET")
});
const mediaUrls = createMediaUrlService({
  repository,
  browse,
  providers,
  sourceService
});
configureSyncSourceWorkflow(() => createIndexOrchestrator({
  repository,
  providers,
  getCredentials: (sourceId, householdId) =>
    sourceService.getUsableCredentials(sourceId, householdId),
  now: () => new Date()
}));
const workflowLauncher = createInjectedWorkflowLauncher(async () => {
  throw new IndexingUnavailableError();
});
const indexing = createIndexingService({
  repository,
  workflowLauncher,
  householdId: required("HOUSEHOLD_ID"),
  cronSecret: required("CRON_SECRET")
});
const appOrigin = required("APP_ORIGIN").replace(/\/$/, "");
const oauth = createOAuthService({
  repository,
  providers,
  keyring: { currentVersion: tokenKeyVersion, keys: { [tokenKeyVersion]: tokenKey } },
  now: () => new Date(),
  createId: () => crypto.randomUUID(),
  startInitialSync: async sourceId => {
    await indexing.startSource(sourceId, "initial");
  }
});

const app = createApiApp({
  repository,
  browse,
  mediaUrls,
  indexing,
  oauth,
  config: {
    householdId: required("HOUSEHOLD_ID"),
    adminInitialPassphrase: process.env.ADMIN_INITIAL_PASSPHRASE,
    passphrasePepper: required("ADMIN_PASSPHRASE_PEPPER"),
    csrfSecret: required("CSRF_SECRET"),
    allowedOrigin: appOrigin
  }
});

export default {
  fetch(request: Request): Promise<Response> {
    return app(request);
  }
};
