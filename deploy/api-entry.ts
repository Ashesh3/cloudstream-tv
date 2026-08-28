import { waitUntil } from "@vercel/functions";

import {
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
  createFirestoreRecoveryMirror,
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
  type ControlPlaneTelemetryObserver,
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
  telemetryObserver?: ControlPlaneTelemetryObserver;
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
  const telemetryObserver = dependencies.telemetryObserver ?? {
    emit(event: import("@cloudframe/server").ControlPlaneTelemetryEvent) {
      try {
        const output = event.level === "error" ? console.error : console.info;
        output(JSON.stringify(event));
      } catch {
        // Runtime telemetry must never alter request state.
      }
    }
  };
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
  const requestContext = createControlRequestContextScope();
  const controlStore = createControlPlaneStore({
    durable,
    cache,
    mirror,
    deferred: { run: deferred },
    keyring: versionedAeadKeyringFromEnv(environment, "CONTROL_PLANE_KEY"),
    now,
    householdId
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
    fetch: providerFetch,
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
    telemetryObserver,
    config: { householdId, allowedOrigin: appOrigin },
    now
  });
}

export default {
  fetch(request: Request): Promise<Response> {
    return createProductionApi(request)(request);
  }
};

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
