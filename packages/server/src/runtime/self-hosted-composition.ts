import { access, statfs } from "node:fs/promises";
import { join } from "node:path";
import {
  createGoogleDriveAdapter,
  createOneDriveAdapter,
  createProviderRegistry,
  type ProviderAdapter,
  type ProviderKind,
} from "@cloudframe/providers";
import {
  createBrowseHandleCodec,
} from "../auth/browse-handles.ts";
import { createSealedSessionCodec } from "../auth/sealed-sessions.ts";
import { createControlRequestContextScope } from "../http/request-context.ts";
import { createControlApiApp } from "../http/control-app.ts";
import { createInstallationApiApp } from "../http/installation-app.ts";
import { createTranscodeApiApp } from "../http/transcode-app.ts";
import { requestSubject } from "../http/request.ts";
import { createSelfHostedApp } from "../http/self-hosted-app.ts";
import { createStaticApp } from "../http/static-app.ts";
import { createControlAdminService } from "../services/control-admin.ts";
import { createControlAuth } from "../services/control-auth.ts";
import { createControlEnrollmentService } from "../services/control-enrollment.ts";
import { createControlOAuthService } from "../services/control-oauth.ts";
import { createCredentialBroker } from "../services/credential-broker.ts";
import { createDirectMediaService } from "../services/direct-media.ts";
import { createInstallationService } from "../services/installation.ts";
import { createLiveBrowseService } from "../services/live-browse.ts";
import { createLiveProviderFolderService } from "../services/live-provider-folders.ts";
import { createRuntimeRateLimiter } from "../services/runtime-rate-limit.ts";
import { createProviderMediaSourceService } from "../services/provider-media-source.ts";
import { createSqliteControlPlaneStore } from "../sqlite/control-store.ts";
import { openLocalDatabase } from "../sqlite/database.ts";
import {
  createInstallationRepository,
  initializeInstallation,
} from "../sqlite/installation-repository.ts";
import { createSqliteOAuthReplayCache } from "../sqlite/oauth-replay-cache.ts";
import { createDeferredTaskTracker } from "./deferred-tasks.ts";
import { createExpiringMemoryCache } from "./local-cache.ts";
import { deriveLocalKeyMaterial, loadOrCreateMasterKey } from "./local-keys.ts";
import { createReadinessController, type ReadinessController } from "./readiness.ts";
import type { SelfHostedConfig } from "./self-hosted-config.ts";
import { createTranscodeCatalog } from "../transcode/catalog.ts";
import { createTranscodeCache } from "../transcode/cache.ts";
import { createTranscodeSourceAuthorizer } from "../transcode/source-authorizer.ts";
import { createTranscodeSourceGateway } from "../transcode/source-gateway.ts";
import { createProcessRunner } from "../transcode/process-runner.ts";
import { createMediaProbeService } from "../transcode/probe.ts";
import { transcodeProfile } from "../transcode/profile.ts";
import { createWindowEncoder } from "../transcode/window-encoder.ts";
import { createTranscodeCoordinator } from "../transcode/coordinator.ts";

export interface SelfHostedComposition {
  app(request: Request): Promise<Response>;
  readiness: ReadinessController;
  close(signal?: AbortSignal): Promise<void>;
}

export interface SelfHostedCompositionDependencies {
  publicRoot?: string;
  providerAdapters?: Partial<Record<ProviderKind, ProviderAdapter>>;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
  log?: (line: string) => void;
}

export async function createSelfHostedComposition(
  config: SelfHostedConfig,
  dependencies: SelfHostedCompositionDependencies = {},
): Promise<SelfHostedComposition> {
  const readiness = createReadinessController();
  const deferred = createDeferredTaskTracker();
  const now = dependencies.now ?? (() => new Date());
  const log = dependencies.log ?? console.info;
  const publicRoot = dependencies.publicRoot ?? join(process.cwd(), "public");
  let localDatabase: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;

  try {
    await Promise.all([
      access(join(publicRoot, "index.html")),
      access(join(publicRoot, "admin", "index.html")),
    ]);
    const masterKey = await loadOrCreateMasterKey(config.dataDir);
    const keys = deriveLocalKeyMaterial(masterKey);
    localDatabase = await openLocalDatabase({ dataDir: config.dataDir, now });
    const controlStore = createSqliteControlPlaneStore({
      connection: localDatabase.connection,
      keyring: keys.controlPlane,
      now,
    });
    const installationRepository = createInstallationRepository({
      connection: localDatabase.connection,
      controlStore,
      setupCodePepper: keys.setupCodePepper,
    });
    const initialized = await initializeInstallation(
      installationRepository,
      now,
      dependencies.randomBytes,
    );
    if (initialized.setupCode) log(`CLOUDFRAME_SETUP_CODE=${initialized.setupCode}`);

    const adapters = dependencies.providerAdapters ?? buildProviderAdapters(
      config,
      dependencies.fetch ?? fetch,
      now,
    );
    const providers = createProviderRegistry(adapters);
    const requestContext = createControlRequestContextScope();
    const credentialCache = createExpiringMemoryCache(now);
    const providerTokenKeyring = keys.providerTokens;
    const credentialBroker = createCredentialBroker({
      controlStore,
      controlState: () => requestContext.current(),
      providers,
      providerTokenKeyring,
      cache: credentialCache,
      now,
    });
    const admin = createControlAdminService({
      store: controlStore,
      passphrasePepper: keys.passphrasePepper,
      now,
    });
    const sessionCodec = createSealedSessionCodec(keys.sessions, now);
    const auth = createControlAuth({
      store: controlStore,
      codec: sessionCodec,
      householdId: initialized.householdId,
      passphrasePepper: keys.passphrasePepper,
      csrfSecret: keys.csrfSecret,
      failedLoginDelayMs: 400,
    });
    const enrollment = createControlEnrollmentService({
      store: controlStore,
      codec: sessionCodec,
      admin,
      householdId: initialized.householdId,
    });
    const oauth = createControlOAuthService({
      store: controlStore,
      codec: sessionCodec,
      providers,
      keyring: providerTokenKeyring,
      redirectUris: {
        google: `${config.appOrigin}/api/admin/sources/google/callback`,
        onedrive: `${config.appOrigin}/api/admin/sources/onedrive/callback`,
      },
      runtimeCache: createSqliteOAuthReplayCache(localDatabase.connection, now),
      now,
    });
    const providerFolders = createLiveProviderFolderService({
      controlStore,
      controlState: () => requestContext.current(),
      credentialBroker,
      providers,
      rootIdSecret: keys.rootIdSecret,
      now,
    });
    const browse = createLiveBrowseService({
      handles: createBrowseHandleCodec(keys.browseHandles, keys.browseIdSecret, now),
      credentialBroker,
      providers,
      now,
    });
    const mediaSources = createProviderMediaSourceService({ credentialBroker, providers, now });
    const sourceAuthorizer = createTranscodeSourceAuthorizer({ controlStore, requestContext, credentialBroker, providers, now });
    const catalog = createTranscodeCatalog(localDatabase.connection);
    const transcodeCache = createTranscodeCache({
      catalog,
      transcodeDir: localDatabase.transcodeDir,
      stagingDir: localDatabase.stagingDir,
      cacheMaxBytes: config.transcode.cacheMaxBytes,
      cacheMinFreeBytes: config.transcode.cacheMinFreeBytes,
      statfs: async (path) => {
        const value = await statfs(path, { bigint: true });
        return { freeBytes: Number(value.bavail * value.bsize) };
      },
      now,
    });
    await transcodeCache.reconcile();
    const gateway = createTranscodeSourceGateway({ authorizer: sourceAuthorizer, mediaSources, fetch: dependencies.fetch ?? fetch, now });
    await gateway.start();
    const runner = createProcessRunner();
    const probe = createMediaProbeService({ runner });
    const profile = transcodeProfile(config.transcode.threads);
    const encoder = createWindowEncoder({ runner, gateway, cache: transcodeCache, catalog, profile, firstSegmentTimeoutMs: config.transcode.firstSegmentTimeoutMs });
    const coordinator = createTranscodeCoordinator({ gateway, probe, catalog, cache: transcodeCache, encoder, profile, now });
    const directMedia = createDirectMediaService({ browse, credentialBroker, providers, mediaSources, transcodes: coordinator, sourceAuthorizer, now });
    const rateLimiter = createRuntimeRateLimiter({ secret: keys.rateLimitSecret, now });
    const installation = createInstallationService({
      repository: installationRepository,
      passphrasePepper: keys.passphrasePepper,
      now,
    });
    const setupApp = createInstallationApiApp({
      service: installation,
      rateLimiter,
      allowedOrigin: config.appOrigin,
      now,
      requestSubject,
    });
    const controlHandler = createControlApiApp({
      controlStore,
      requestContext,
      auth,
      admin,
      enrollment,
      oauth,
      providerFolders,
      browse,
      directMedia,
      rateLimiter,
      config: { householdId: initialized.householdId, allowedOrigin: config.appOrigin },
      now,
      requestSubject,
    });
    const transcodeHandler = createTranscodeApiApp({ controlStore, requestContext, auth, sourceAuthorizer, coordinator, cache: transcodeCache, cacheMaxBytes: config.transcode.cacheMaxBytes, allowedOrigin: config.appOrigin, now });
    const app = createSelfHostedApp({
      readiness,
      setupApp,
      transcodeApp: transcodeHandler,
      controlApp: async (request) =>
        new URL(request.url).pathname.startsWith("/api/")
          ? controlHandler(request)
          : null,
      staticApp: createStaticApp({ publicRoot }),
    });
    readiness.markReady();

    let closed = false;
    return {
      app,
      readiness,
      async close(signal) {
        if (closed) return;
        readiness.beginDrain();
        await coordinator.close();
        await gateway.close();
        const drain = deferred.drain(15_000);
        if (signal) {
          await Promise.race([
            drain,
            new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
          ]);
        } else {
          await drain;
        }
        localDatabase?.close();
        closed = true;
      },
    };
  } catch (error) {
    readiness.fail(startupErrorCode(error));
    localDatabase?.close();
    throw error;
  }
}

function buildProviderAdapters(
  config: SelfHostedConfig,
  providerFetch: typeof globalThis.fetch,
  now: () => Date,
): Partial<Record<ProviderKind, ProviderAdapter>> {
  return {
    ...(config.providers.google
      ? { google: createGoogleDriveAdapter({ ...config.providers.google, fetch: providerFetch, now }) }
      : {}),
    ...(config.providers.onedrive
      ? { onedrive: createOneDriveAdapter({ ...config.providers.onedrive, fetch: providerFetch, now }) }
      : {}),
  };
}

function startupErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "STARTUP_FAILED";
}
