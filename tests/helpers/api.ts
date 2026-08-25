import type { Household } from "@cloudframe/shared";
import {
  MemoryRepository,
  createApiApp,
  hashOpaqueToken,
  hashPassphrase,
  type ApiAppDependencies,
  type RateLimitPolicy
} from "@cloudframe/server";

const DEFAULT_NOW = new Date("2026-08-26T12:00:00.000Z");
const DEFAULT_ORIGIN = "https://dev.cloudframe.example";

export interface TestApi {
  app: ReturnType<typeof createApiApp>;
  repository: MemoryRepository;
  now: Date;
  origin: string;
  householdId: string;
  pepper: string;
  csrfSecret: string;
}

export interface TestApiOptions {
  allowNewDeviceRequests?: boolean;
  bootstrapHousehold?: boolean;
  now?: Date;
  initialPassphrase?: string;
  storedPassphrase?: string;
  rateLimits?: Partial<Record<string, RateLimitPolicy>>;
  requestSubject?: (request: Request) => string;
}

export async function createTestApi(
  options: TestApiOptions = {}
): Promise<TestApi> {
  const repository = new MemoryRepository();
  const now = options.now ?? DEFAULT_NOW;
  const origin = DEFAULT_ORIGIN;
  const householdId = "household-test";
  const pepper = "test-passphrase-pepper";
  const csrfSecret = "test-csrf-secret-that-is-long-enough";

  if (options.bootstrapHousehold !== false) {
    const household: Household = {
      id: householdId,
      createdAt: now,
      allowNewDeviceRequests: options.allowNewDeviceRequests ?? true,
      defaultMediaOrder: "captured-desc",
      defaultSlideshowSeconds: 8,
      adminPassphraseHash: await hashPassphrase(
        options.storedPassphrase ??
          options.initialPassphrase ??
          "correct horse battery staple",
        pepper
      ),
      adminPassphraseVersion: 1
    };
    await repository.putHousehold(household);
  }

  let id = 0;
  let token = 0;
  const dependencies: ApiAppDependencies = {
    repository,
    config: {
      householdId,
      adminInitialPassphrase: Object.prototype.hasOwnProperty.call(
        options,
        "initialPassphrase"
      )
        ? options.initialPassphrase
        : "correct horse battery staple",
      passphrasePepper: pepper,
      csrfSecret,
      allowedOrigin: origin,
      rateLimits: options.rateLimits
    },
    now: () => new Date(now),
    createId: prefix => `${prefix}-${++id}`,
    issueToken: () => {
      const raw = Buffer.alloc(32, ++token).toString("base64url");
      return {
        raw,
        hash: hashOpaqueToken(raw)
      };
    },
    requestSubject: options.requestSubject
  };

  return {
    app: createApiApp(dependencies),
    repository,
    now,
    origin,
    householdId,
    pepper,
    csrfSecret
  };
}

export function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  headers: HeadersInit = {}
): Request {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(`https://dev.cloudframe.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

export function cookieValue(response: Response, name: string): string | null {
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(cookie);
    if (match) return decodeURIComponent(match[1] ?? "");
  }
  return null;
}

export function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

export function cookieHeader(...cookies: Array<[string, string]>): string {
  return cookies.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}
