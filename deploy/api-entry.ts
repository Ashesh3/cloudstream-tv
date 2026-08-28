import { waitUntil } from "@vercel/functions";

import {
  CONTROL_SESSION_LIFETIME_MS,
  createBrowseHandleCodec,
  createControlAdminService,
  createControlApiApp,
  createControlAuth,
  createControlEnrollmentService,
  createControlOAuthService,
  createControlPlaneStore,
  createControlRequestContextScope,
  createCredentialBroker,
  createDirectMediaService,
  createFirestoreClient,
  createFirestoreLegacySessionReader,
  createFirestoreRecoveryMirror,
  createLegacySessionExchange,
  createLiveBrowseService,
  createLiveProviderFolderService,
  createRuntimeRateLimiter,
  createSealedSessionCodec,
  createVercelBlobControlStore,
  createVercelRuntimeControlCache,
  providerTokenKeyringFromEnv,
  requestOidcTokenSupplier,
  versionedAeadKeyringFromEnv,
  type FirestoreClientConfig,
  type FirestoreClientDependencies,
  type LegacySessionExchange,
} from "@cloudframe/server";
import {
  createGoogleDriveAdapter,
  createOneDriveAdapter,
  createProviderRegistry
} from "@cloudframe/providers";

export interface ProductionApiCompositionDependencies {
  createFirestoreClient?: <TClient = import("@google-cloud/firestore").Firestore>(
    config: FirestoreClientConfig,
    dependencies?: FirestoreClientDependencies<TClient>
  ) => TClient;
  now?: () => Date;
  fetch?: typeof globalThis.fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function createProductionApi(
  request: Request,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: ProductionApiCompositionDependencies = {}
) {
  const householdId = required(environment, "HOUSEHOLD_ID");
  const controlEnvironment = required(environment, "CONTROL_PLANE_ENV");
  const appOrigin = exactOrigin(required(environment, "APP_ORIGIN"));
  const now = dependencies.now ?? (() => new Date());
  const providerFetch = dependencies.fetch ?? fetch;
  const firestoreFactory = dependencies.createFirestoreClient ?? createFirestoreClient;
  const deferred = dependencies.waitUntil ?? ((promise) => { waitUntil(promise); });
  const firestoreConfig = {
    environment: environment.VERCEL_ENV === "production" ? "production" as const : "staging" as const,
    projectId: required(environment, "FIRESTORE_PROJECT_ID"),
    ...(environment.FIRESTORE_DATABASE_ID ? { databaseId: environment.FIRESTORE_DATABASE_ID } : {}),
    ...(environment.FIRESTORE_EMULATOR_HOST ? { emulatorHost: environment.FIRESTORE_EMULATOR_HOST } : {}),
    workloadIdentityProvider: required(environment, "GCP_WORKLOAD_IDENTITY_PROVIDER"),
    oidcTokenSupplier: requestOidcTokenSupplier(request)
  };

  const writer = firestoreFactory({
    ...firestoreConfig,
    serviceAccountEmail: required(environment, "GCP_SERVICE_ACCOUNT_EMAIL")
  });
  const mirror = createFirestoreRecoveryMirror(writer, householdId);
  const durable = createVercelBlobControlStore({
    householdId,
    environment: controlEnvironment,
    storeId: required(environment, "BLOB_STORE_ID")
  });
  const cache = createVercelRuntimeControlCache({
    householdId,
    environment: controlEnvironment
  });
  const controlStore = createControlPlaneStore({
    durable,
    cache,
    mirror,
    deferred: { run: deferred },
    keyring: versionedAeadKeyringFromEnv(environment, "CONTROL_PLANE_KEY"),
    now
  });
  const providers = createProviderRegistry({
    google: createGoogleDriveAdapter({
      clientId: required(environment, "GOOGLE_CLIENT_ID"),
      clientSecret: required(environment, "GOOGLE_CLIENT_SECRET"),
      fetch: providerFetch,
      now
    }),
    onedrive: createOneDriveAdapter({
      clientId: required(environment, "ONEDRIVE_CLIENT_ID"),
      clientSecret: required(environment, "ONEDRIVE_CLIENT_SECRET"),
      tenant: required(environment, "ONEDRIVE_TENANT"),
      fetch: providerFetch,
      now
    })
  });
  const sessionCodec = createSealedSessionCodec(
    versionedAeadKeyringFromEnv(environment, "SESSION_KEY"),
    now
  );
  const browseHandles = createBrowseHandleCodec(
    versionedAeadKeyringFromEnv(environment, "BROWSE_HANDLE_KEY"),
    requiredSecret(environment, "BROWSE_ID_SECRET"),
    now
  );
  const requestContext = createControlRequestContextScope();
  const providerTokenKeyring = providerTokenKeyringFromEnv(environment);
  const credentialBroker = createCredentialBroker({
    controlStore,
    controlState: () => requestContext.current(),
    providers,
    providerTokenKeyring,
    now
  });
  const admin = createControlAdminService({
    store: controlStore,
    cache,
    passphrasePepper: requiredSecret(environment, "ADMIN_PASSPHRASE_PEPPER"),
    now
  });
  const auth = createControlAuth({
    store: controlStore,
    codec: sessionCodec,
    householdId,
    passphrasePepper: requiredSecret(environment, "ADMIN_PASSPHRASE_PEPPER"),
    csrfSecret: requiredSecret(environment, "CSRF_SECRET"),
    failedLoginDelayMs: 400
  });
  const enrollment = createControlEnrollmentService({
    store: controlStore,
    codec: sessionCodec,
    admin,
    householdId
  });
  const oauth = createControlOAuthService({
    store: controlStore,
    codec: sessionCodec,
    providers,
    keyring: providerTokenKeyring,
    redirectUris: {
      google: `${appOrigin}/api/admin/sources/google/callback`,
      onedrive: `${appOrigin}/api/admin/sources/onedrive/callback`
    },
    now
  });
  const providerFolders = createLiveProviderFolderService({
    controlStore,
    controlState: () => requestContext.current(),
    credentialBroker,
    providers,
    rootIdSecret: requiredSecret(environment, "ROOT_ID_SECRET"),
    now
  });
  const browse = createLiveBrowseService({
    handles: browseHandles,
    credentialBroker,
    providers,
    now
  });
  const directMedia = createDirectMediaService({
    browse,
    credentialBroker,
    providers,
    now
  });
  const legacySessionExchange = createOptionalLegacyExchange({
    environment,
    request,
    firestoreConfig,
    firestoreFactory,
    householdId,
    sessionCodec,
    controlStore,
    now
  });

  return createControlApiApp({
    controlStore,
    requestContext,
    auth,
    admin,
    enrollment,
    oauth,
    providerFolders,
    browse,
    directMedia,
    rateLimiter: createRuntimeRateLimiter({
      secret: requiredSecret(environment, "RATE_LIMIT_SECRET")
    }),
    ...(legacySessionExchange ? { legacySessionExchange } : {}),
    config: { householdId, allowedOrigin: appOrigin },
    now
  });
}

export default {
  fetch(request: Request): Promise<Response> {
    return createProductionApi(request)(request);
  }
};

interface LegacyComposition {
  environment: NodeJS.ProcessEnv;
  request: Request;
  firestoreConfig: {
    environment: "production" | "staging";
    projectId: string;
    databaseId?: string;
    emulatorHost?: string;
    workloadIdentityProvider: string;
    oidcTokenSupplier: () => Promise<string>;
  };
  firestoreFactory: NonNullable<ProductionApiCompositionDependencies["createFirestoreClient"]>;
  householdId: string;
  sessionCodec: ReturnType<typeof createSealedSessionCodec>;
  controlStore: ReturnType<typeof createControlPlaneStore>;
  now: () => Date;
}

function createOptionalLegacyExchange(
  input: LegacyComposition
): LegacySessionExchange | undefined {
  if (input.environment.ENABLE_LEGACY_SESSION_EXCHANGE !== "1") return undefined;
  const readerClient = input.firestoreFactory({
    ...input.firestoreConfig,
    serviceAccountEmail: required(
      input.environment,
      "GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL"
    )
  });
  return createLegacySessionExchange({
    reader: createFirestoreLegacySessionReader(readerClient),
    codec: input.sessionCodec,
    householdId: input.householdId,
    loadControlDocument: async () => (await input.controlStore.load()).document,
    sessionLifetimeMs: CONTROL_SESSION_LIFETIME_MS
  });
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value !== value.trim()) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function requiredSecret(environment: NodeJS.ProcessEnv, name: string): string {
  const value = required(environment, name);
  if (Buffer.byteLength(value, "utf8") < 32) throw new Error(`${name}_INVALID`);
  return value;
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) throw new Error("APP_ORIGIN_INVALID");
  return url.origin;
}
