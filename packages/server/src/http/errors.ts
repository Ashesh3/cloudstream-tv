import type { ApiError } from "@cloudframe/shared";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly responseHeaders?: HeadersInit
  ) {
    super(message);
  }

  toApiError(): ApiError {
    return {
      code: this.code,
      message: this.message,
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds })
    };
  }
}
