import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createNodeRequest, writeNodeResponse } from "../packages/server/src/http/node-adapter.ts";
import { createSelfHostedComposition } from "../packages/server/src/runtime/self-hosted-composition.ts";
import { parseSelfHostedConfig } from "../packages/server/src/runtime/self-hosted-config.ts";
import { createHttpRequestTracker } from "../packages/server/src/runtime/http-request-tracker.ts";

declare const __CLOUDFRAME_CONTAINER_TEST__: boolean;

const config = parseSelfHostedConfig(process.env);
const dependencies: Parameters<typeof createSelfHostedComposition>[1] = {
  publicRoot: fileURLToPath(new URL("../public/", import.meta.url)),
};
if (__CLOUDFRAME_CONTAINER_TEST__) installContainerTestFixture(dependencies);
const composition = await createSelfHostedComposition(config, {
  ...dependencies,
});
const requests = createHttpRequestTracker();

const server = createServer((incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.once("close", () => controller.abort());
  const request = createNodeRequest(incoming, config.appOrigin, controller.signal);
  const operation = composition.app(request)
    .then((response) => writeNodeResponse(response, outgoing))
    .catch(() => {
      if (!outgoing.headersSent) {
        outgoing.statusCode = 500;
        outgoing.setHeader("content-type", "application/json; charset=utf-8");
      }
      outgoing.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "An unexpected error occurred." }));
    });
  void requests.run(controller, operation);
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
  try {
    await requests.drain(server, 15_000);
    await composition.close(AbortSignal.timeout(15_000));
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

function installContainerTestFixture(target: NonNullable<Parameters<typeof createSelfHostedComposition>[1]>): void {
  target.containerTestFixturePath = fileURLToPath(new URL("../test-fixtures/legacy-mpeg.mpg", import.meta.url));
}
