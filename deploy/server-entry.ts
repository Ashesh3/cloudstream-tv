import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createNodeRequest, writeNodeResponse } from "../packages/server/src/http/node-adapter.ts";
import { createSelfHostedComposition } from "../packages/server/src/runtime/self-hosted-composition.ts";
import { parseSelfHostedConfig } from "../packages/server/src/runtime/self-hosted-config.ts";

declare const __CLOUDFRAME_CONTAINER_TEST__: boolean;

const config = parseSelfHostedConfig(process.env);
const composition = await createSelfHostedComposition(config, {
  publicRoot: fileURLToPath(new URL("../public/", import.meta.url)),
  ...(__CLOUDFRAME_CONTAINER_TEST__ ? { containerTestFixturePath: fileURLToPath(new URL("../test-fixtures/legacy-mpeg.mpg", import.meta.url)) } : {}),
});

const server = createServer((incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.once("close", () => controller.abort());
  const request = createNodeRequest(incoming, config.appOrigin, controller.signal);
  void composition.app(request)
    .then((response) => writeNodeResponse(response, outgoing))
    .catch(() => {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
      }
      outgoing.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." }));
    });
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, "0.0.0.0", resolve);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  composition.readiness.beginDrain();
  server.close();
  try {
    await composition.close(AbortSignal.timeout(15_000));
  } catch {
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
