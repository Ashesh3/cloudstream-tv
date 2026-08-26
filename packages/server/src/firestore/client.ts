import { Firestore } from "@google-cloud/firestore";
import { getVercelOidcTokenSync } from "@vercel/oidc";

export type FirestoreEnvironment = "local" | "staging" | "production";

export interface ExplicitFirestoreCredentials {
  clientEmail: string;
  privateKey: string;
}

export interface FirestoreClientConfig {
  environment: FirestoreEnvironment;
  projectId: string;
  databaseId?: string;
  emulatorHost?: string;
  explicitCredentials?: ExplicitFirestoreCredentials;
  workloadIdentityProvider?: string;
  serviceAccountEmail?: string;
  oidcTokenSupplier?: () => Promise<string>;
}

export interface WorkloadIdentityCredentials {
  type: "external_account";
  audience: string;
  subject_token_type: "urn:ietf:params:oauth:token-type:jwt";
  token_url: "https://sts.googleapis.com/v1/token";
  service_account_impersonation_url: string;
  subject_token_supplier: {
    getSubjectToken(): Promise<string>;
  };
}

export interface FirestoreClientSettings {
  projectId: string;
  databaseId?: string;
  host?: string;
  ssl?: boolean;
  credentials?: WorkloadIdentityCredentials | {
    client_email: string;
    private_key: string;
  };
}

export interface FirestoreClientDependencies<TClient = Firestore> {
  createClient(settings: FirestoreClientSettings): TClient;
  getVercelOidcToken(): Promise<string>;
}

export function requestOidcTokenSupplier(request: Request): () => Promise<string> {
  return async () => {
    const token = request.headers.get("x-vercel-oidc-token");
    if (!token) throw new Error("Vercel OIDC token is unavailable");
    return token;
  };
}

const defaultDependencies: FirestoreClientDependencies = {
  createClient(settings) {
    return new Firestore(settings as ConstructorParameters<typeof Firestore>[0]);
  },
  getVercelOidcToken: async () => getVercelOidcTokenSync()
};

export function createFirestoreClient<TClient = Firestore>(
  config: FirestoreClientConfig,
  dependencies: FirestoreClientDependencies<TClient> =
    defaultDependencies as FirestoreClientDependencies<TClient>
): TClient {
  const base: FirestoreClientSettings = {
    projectId: config.projectId,
    ...(config.databaseId ? { databaseId: config.databaseId } : {})
  };

  if (config.environment === "production") {
    if (
      config.explicitCredentials ||
      !config.workloadIdentityProvider ||
      !config.serviceAccountEmail
    ) {
      throw new Error(
        "Production Firestore requires Vercel OIDC workload identity federation"
      );
    }

    return dependencies.createClient({
      ...base,
      credentials: buildWorkloadIdentityCredentials(
        config.workloadIdentityProvider,
        config.serviceAccountEmail,
        config.oidcTokenSupplier ?? dependencies.getVercelOidcToken
      )
    });
  }

  if (config.emulatorHost) {
    return dependencies.createClient({
      ...base,
      host: config.emulatorHost,
      ssl: false
    });
  }


  if (config.workloadIdentityProvider && config.serviceAccountEmail) {
    if (config.explicitCredentials) {
      throw new Error("Staging Firestore cannot combine explicit credentials with workload identity");
    }
    return dependencies.createClient({
      ...base,
      credentials: buildWorkloadIdentityCredentials(
        config.workloadIdentityProvider,
        config.serviceAccountEmail,
        config.oidcTokenSupplier ?? dependencies.getVercelOidcToken
      )
    });
  }

  if (config.explicitCredentials) {
    return dependencies.createClient({
      ...base,
      credentials: {
        client_email: config.explicitCredentials.clientEmail,
        private_key: config.explicitCredentials.privateKey
      }
    });
  }

  return dependencies.createClient(base);
}

function buildWorkloadIdentityCredentials(
  provider: string,
  serviceAccountEmail: string,
  tokenSupplier: () => Promise<string>
): WorkloadIdentityCredentials {
  const providerResource = provider.startsWith("//iam.googleapis.com/")
    ? provider.slice("//iam.googleapis.com/".length)
    : provider;

  return {
    type: "external_account",
    audience: `//iam.googleapis.com/${providerResource}`,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_url: "https://sts.googleapis.com/v1/token",
    service_account_impersonation_url:
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:generateAccessToken`,
    subject_token_supplier: {
      getSubjectToken: tokenSupplier
    }
  };
}
