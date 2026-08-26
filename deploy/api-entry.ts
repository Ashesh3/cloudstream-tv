import {
  FirestoreRepository,
  createApiApp,
  createBrowseService,
  createFirestoreClient,
  requestOidcTokenSupplier,
  createIndexingService,
  createMediaUrlService,
  createOAuthService,
  createProviderFolderService,
  createSourceService,
} from "@cloudframe/server";
import {
  createGoogleDriveAdapter,
  createOneDriveAdapter,
  createProviderRegistry
} from "@cloudframe/providers";
import {
  createWorkflowApiLauncher,
} from "@cloudframe/indexer";
import { start as startWorkflow } from "workflow/api";

declare const __SYNC_SOURCE_WORKFLOW_ID__: string;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const firestoreConfig = {
  environment: process.env.VERCEL_ENV === "production" ? "production" : "staging",
  projectId: required("FIRESTORE_PROJECT_ID"),
  databaseId: process.env.FIRESTORE_DATABASE_ID,
  emulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
  workloadIdentityProvider: process.env.GCP_WORKLOAD_IDENTITY_PROVIDER,
  serviceAccountEmail: process.env.GCP_SERVICE_ACCOUNT_EMAIL
} as const;
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
const workflowLauncher = createWorkflowApiLauncher(__SYNC_SOURCE_WORKFLOW_ID__, (workflow, args) =>
  startWorkflow(workflow, args)
);
const appOrigin = required("APP_ORIGIN").replace(/\/$/, "");

export default {
  fetch(request: Request): Promise<Response> {
    return createRequestApp(request)(request);
  }
};

function createRequestApp(request: Request) {
  const firestore = createFirestoreClient({ ...firestoreConfig, oidcTokenSupplier: requestOidcTokenSupplier(request) });
  const repository = new FirestoreRepository(firestore);
  const sourceService = createSourceService({ repository, providers, keyring: { currentVersion: tokenKeyVersion, keys: { [tokenKeyVersion]: tokenKey } }, now: () => new Date() });
  const browse = createBrowseService({ repository, cursorSecret: required("BROWSE_CURSOR_SECRET") });
  const mediaUrls = createMediaUrlService({ repository, browse, providers, sourceService });
  const indexing = createIndexingService({ repository, workflowLauncher, householdId: required("HOUSEHOLD_ID"), cronSecret: required("CRON_SECRET") });
  const oauth = createOAuthService({ repository, providers, keyring: { currentVersion: tokenKeyVersion, keys: { [tokenKeyVersion]: tokenKey } }, now: () => new Date(), createId: () => crypto.randomUUID() });
  const providerFolders = createProviderFolderService({ repository, providers, sourceService, indexing });
  return createApiApp({ repository, browse, mediaUrls, indexing, oauth, providerFolders, config: { householdId: required("HOUSEHOLD_ID"), adminInitialPassphrase: process.env.ADMIN_INITIAL_PASSPHRASE, passphrasePepper: required("ADMIN_PASSPHRASE_PEPPER"), csrfSecret: required("CSRF_SECRET"), allowedOrigin: appOrigin } });
}
