import type { ReadinessController } from "../runtime/readiness.ts";
import { errorResponse, ok } from "./response.ts";

export type OptionalWebHandler = (request: Request) => Promise<Response | null>;

export interface SelfHostedAppOptions {
  readiness: ReadinessController;
  setupApp: OptionalWebHandler;
  transcodeApp: OptionalWebHandler;
  controlApp: OptionalWebHandler;
  staticApp: OptionalWebHandler;
}

export function createSelfHostedApp(options: SelfHostedAppOptions) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
      return ok(options.readiness.snapshot());
    }
    if (path === "/readyz") {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
      const snapshot = options.readiness.snapshot();
      return snapshot.ready
        ? ok(snapshot)
        : errorResponse({ code: snapshot.errorCode ?? "NOT_READY", message: "Cloudframe is not ready." }, 503);
    }

    for (const handler of [options.setupApp, options.transcodeApp, options.controlApp]) {
      const response = await handler(request);
      if (response) return response;
    }
    if (path.startsWith("/api/")) {
      return errorResponse({ code: "NOT_FOUND", message: "API route not found." }, 404);
    }
    return await options.staticApp(request) ?? new Response(null, { status: 404 });
  };
}

function methodNotAllowed(): Response {
  return errorResponse(
    { code: "METHOD_NOT_ALLOWED", message: "The request method is not allowed." },
    405,
    { allow: "GET, HEAD" },
  );
}
