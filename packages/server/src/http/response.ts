import type { ApiError, ApiResult } from "@cloudframe/shared";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer"
};

export function jsonResponse<T>(
  data: T,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(JSON_HEADERS);
  const incoming = new Headers(init.headers);
  incoming.forEach((value, name) => {
    if (name !== "set-cookie") headers.set(name, value);
  });
  for (const value of incoming.getSetCookie()) headers.append("set-cookie", value);
  return new Response(JSON.stringify(data), {
    ...init,
    headers
  });
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return jsonResponse<ApiResult<T>>({ ok: true, data }, init);
}

export function errorResponse(
  error: ApiError,
  status: number,
  headers?: HeadersInit
): Response {
  return jsonResponse(error, { status, headers });
}
