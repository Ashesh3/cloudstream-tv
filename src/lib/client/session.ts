const SESSION_STORAGE_KEY = "tv-session-id";
const SESSION_HEADER = "X-Session-Id";

export function getStoredSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_STORAGE_KEY);
}

export function storeSessionId(sessionId: string): void {
  window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
}

export function clearStoredSessionId(): void {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

/**
 * Send the retained TV session explicitly as well as relying on the server
 * cookie. The header is an intentional compatibility fallback for smart-TV
 * browsers with incomplete cookie support.
 */
export function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  const sessionId = getStoredSessionId();

  if (sessionId) {
    headers.set(SESSION_HEADER, sessionId);
  }

  return fetch(input, { ...init, headers });
}
