import { ProviderError } from "./types";

export async function providerFetch(
  fetch: typeof globalThis.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  options: {
    now?: () => Date;
    acceptedStatuses?: readonly number[];
  } = {}
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError(
        "PROVIDER_TIMEOUT",
        "The cloud provider request timed out.",
        { retryable: true }
      );
    }
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "The cloud provider is temporarily unavailable.",
      { retryable: true }
    );
  }

  if (response.ok || options.acceptedStatuses?.includes(response.status)) {
    return response;
  }
  const retryAfterSeconds = parseRetryAfter(
    response.headers.get("retry-after"),
    options.now?.() ?? new Date()
  );
  if (response.status === 429) {
    throw new ProviderError(
      "PROVIDER_THROTTLED",
      "The cloud provider asked us to retry later.",
      { retryable: true, retryAfterSeconds }
    );
  }
  if (response.status === 503 || response.status >= 500) {
    throw new ProviderError(
      "PROVIDER_UNAVAILABLE",
      "The cloud provider is temporarily unavailable.",
      { retryable: true, retryAfterSeconds }
    );
  }
  if (response.status === 404) {
    throw new ProviderError(
      "PROVIDER_NOT_FOUND",
      "Provider item was not found.",
      { retryable: false }
    );
  }
  const errorCode = await readProviderErrorCode(response);
  if (errorCode === "invalid_grant") {
    throw new ProviderError("PROVIDER_REAUTH_REQUIRED", "Provider authorization is required.", {
      retryable: false,
      reauthReason: "invalid_grant"
    });
  }
  if (response.status === 401) {
    throw new ProviderError(
      "PROVIDER_REAUTH_REQUIRED",
      "Provider authorization is required.",
      { retryable: false }
    );
  }
  throw new ProviderError(
    "PROVIDER_BAD_RESPONSE",
    "The cloud provider rejected the request.",
    { retryable: false }
  );
}

async function readProviderErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as {
      error?: string | { code?: string };
    };
    return typeof body.error === "string" ? body.error : body.error?.code ?? null;
  } catch {
    return null;
  }
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / 1000));
}

export function bearer(accessToken: string): HeadersInit {
  return { authorization: `Bearer ${accessToken}`, accept: "application/json" };
}

export async function json<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError(
      "PROVIDER_BAD_RESPONSE",
      "The cloud provider returned an invalid response.",
      { retryable: false }
    );
  }
}

export async function optionalJson<T>(response: Response): Promise<T | null> {
  if (response.status === 404) return null;
  return json<T>(response);
}

export function temporaryExpiry(now: Date): Date {
  return new Date(now.getTime() + 50 * 60 * 1000);
}
