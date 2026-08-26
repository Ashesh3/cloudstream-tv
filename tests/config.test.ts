import { access, readFile, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

const exec = promisify(execFile);

describe("deployment configuration", () => {
  it("denies every direct browser Firestore request", async () => {
    const rules = await readFile("firestore.rules", "utf8");
    expect(rules).toContain("rules_version = '2'");
    expect(rules).toMatch(/match\s+\/\{document=\*\*\}\s*\{[\s\S]*allow read, write:\s*if false;/);
  });

  it("declares the composite indexes used by server queries", async () => {
    const config = await json("firestore.indexes.json") as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }> }>;
    };
    const signatures = config.indexes.map(index =>
      `${index.collectionGroup}:${index.fields.map(field => field.fieldPath).join(",")}`
    );
    expect(signatures).toEqual(expect.arrayContaining([
      "nodes:parentNodeId,sourceId",
      "nodes:sourceId,providerNodeId",
      "watchHistory:householdId,deviceId,updatedAt",
      "deviceRequests:householdId,createdAt",
      "sources:householdId,nextSyncAt"
    ]));
  });

  it("uses a daily Hobby cron and Mumbai server execution", async () => {
    const vercel = await json("vercel.json") as {
      buildCommand: string;
      outputDirectory: string;
      crons: Array<{ path: string; schedule: string }>;
    };
    expect(vercel.buildCommand).toBe("npm run build:vercel");
    expect(vercel.outputDirectory).toBe(".vercel/output");
    expect(vercel.crons).toContainEqual({
      path: "/api/internal/sync-due-sources",
      schedule: "0 2 * * *"
    });

    const contract = await json("deploy/vercel-build-contract.json") as {
      api: { regions: string[] };
      workflows: { regions: string[]; queueNamespace: string | null };
    };
    expect(contract.api.regions).toEqual(["bom1"]);
    expect(contract.workflows.regions).toEqual(["bom1"]);
    expect(contract.workflows.queueNamespace).toBeNull();
  });

  it("routes the two SPAs without swallowing API or workflow traffic", async () => {
    const contract = await json("deploy/vercel-build-contract.json") as {
      routes: Array<{ src?: string; dest?: string; handle?: string }>;
    };
    expect(contract.routes).toEqual(expect.arrayContaining([
      { handle: "filesystem" },
      { src: "^/api(?:/.*)?$", dest: "/api" },
      { src: "^/admin(?:/.*)?$", dest: "/admin/index.html" },
      { src: "^/(?!api(?:/|$)|\\.well-known/workflow(?:/|$)).*$", dest: "/index.html" }
    ]));
    expect(contract.routes[0]).toEqual({ handle: "filesystem" });
  });

  it("lists all required environment variables as empty placeholders", async () => {
    const content = await readFile(".env.example", "utf8");
    const entries = new Map(
      content.split(/\r?\n/)
        .filter(line => line && !line.startsWith("#"))
        .map(line => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)] as const;
        })
    );
    const required = [
      "APP_ORIGIN", "NEXT_PUBLIC_APP_URL", "HOUSEHOLD_ID",
      "FIRESTORE_PROJECT_ID", "FIRESTORE_DATABASE_ID", "FIRESTORE_EMULATOR_HOST",
      "GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_SERVICE_ACCOUNT_EMAIL",
      "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ONEDRIVE_CLIENT_ID",
      "ONEDRIVE_CLIENT_SECRET", "ONEDRIVE_TENANT", "ADMIN_INITIAL_PASSPHRASE",
      "ADMIN_PASSPHRASE_PEPPER", "CSRF_SECRET", "BROWSE_CURSOR_SECRET",
      "PROVIDER_TOKEN_KEY_VERSION", "PROVIDER_TOKEN_KEY_V1", "CRON_SECRET",
    ];
    expect([...entries.keys()]).toEqual(expect.arrayContaining(required));
    required.forEach(name => expect(entries.get(name), name).toBe(""));
    expect(content).not.toMatch(/KV_REST|ACCESS_CODE|NEXT_PUBLIC_GOOGLE|NEXT_PUBLIC_ONEDRIVE/);
  });

  it("configures only Firestore and never Firebase browser products", async () => {
    const firebase = await json("firebase.json") as Record<string, unknown>;
    expect(firebase).toHaveProperty("firestore");
    expect(firebase).not.toHaveProperty("hosting");
    expect(firebase).not.toHaveProperty("functions");
    expect(firebase).not.toHaveProperty("storage");
    expect(firebase).not.toHaveProperty("auth");
  });

  it("provides the custom Vercel build assembler", async () => {
    await expect(access("scripts/build-vercel.mjs")).resolves.toBeUndefined();
    await expect(access("deploy/api-entry.ts")).resolves.toBeUndefined();
    await expect(access("api/[...route].ts")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access("api")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("assembles static SPAs, the API function, and private durable workflow functions", async () => {
    await exec(process.execPath, ["scripts/build-vercel.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, WORKFLOW_PUBLIC_MANIFEST: "0" },
      maxBuffer: 20 * 1024 * 1024
    });

    const output = await json(".vercel/output/config.json") as {
      version: number;
      routes: Array<{ src: string; dest: string }>;
    };
    expect(output.version).toBe(3);
    expect(output.routes).toContainEqual({ src: "^/api(?:/.*)?$", dest: "/api" });
    await Promise.all([
      access(".vercel/output/static/index.html"),
      access(".vercel/output/static/admin/index.html"),
      access(".vercel/output/functions/api.func/index.js"),
      access(".vercel/output/functions/api.func/node_modules/@node-rs/argon2/index.js"),
      access(".vercel/output/functions/api.func/node_modules/@node-rs/argon2-linux-x64-gnu/argon2.linux-x64-gnu.node"),
      access(".vercel/output/functions/.well-known/workflow/v1/flow.func/index.js"),
      access(".vercel/output/functions/.well-known/workflow/v1/step.func/index.js"),
      access(".vercel/output/functions/.well-known/workflow/v1/step.func/node_modules/@node-rs/argon2-linux-x64-gnu/argon2.linux-x64-gnu.node"),
      access(".vercel/output/functions/.well-known/workflow/v1/webhook/[token].func/index.js")
    ]);

    const manifest = await json(
      ".vercel/output/functions/.well-known/workflow/v1/manifest.json"
    ) as { workflows: Record<string, Record<string, { workflowId: string }>> };
    const workflows = Object.values(manifest.workflows).flatMap(value => Object.values(value));
    const workflow = workflows.find(value => value.workflowId.includes("syncSourceWorkflow"));
    expect(workflow).toBeDefined();
    const apiBundle = await readFile(".vercel/output/functions/api.func/index.js", "utf8");
    expect(apiBundle).toContain(workflow!.workflowId);

    const flowConfig = await json(
      ".vercel/output/functions/.well-known/workflow/v1/flow.func/.vc-config.json"
    ) as { architecture: string; regions: string[]; experimentalTriggers: Array<{ topic: string }> };
    const stepConfig = await json(
      ".vercel/output/functions/.well-known/workflow/v1/step.func/.vc-config.json"
    ) as { architecture: string; regions: string[]; experimentalTriggers: Array<{ topic: string }> };
    expect(flowConfig).toMatchObject({
      architecture: "x86_64",
      regions: ["bom1"],
      experimentalTriggers: [{ topic: "__wkf_workflow_*" }]
    });
    expect(stepConfig).toMatchObject({
      architecture: "x86_64",
      regions: ["bom1"],
      experimentalTriggers: [{ topic: "__wkf_step_*" }]
    });
    const flowBundle = await readFile(
      ".vercel/output/functions/.well-known/workflow/v1/flow.func/index.js",
      "utf8"
    );
    expect(flowBundle).toContain("__wkf_step_");
    const apiConfig = await json(
      ".vercel/output/functions/api.func/.vc-config.json"
    ) as { architecture: string; useWebApi: boolean; regions: string[] };
    expect(apiConfig).toMatchObject({ architecture: "x86_64", useWebApi: true, regions: ["bom1"] });
    const functionDirectories = (await readdir(".vercel/output/functions", { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith(".func"))
      .map(entry => entry.parentPath.replaceAll("\\", "/") + "/" + entry.name);
    expect(functionDirectories.filter(path => path.endsWith("/api.func"))).toHaveLength(1);
    expect(functionDirectories.some(path => /api\/\[\.\.\.route\].func$/.test(path))).toBe(false);
    await expect(access(".vercel/output/static/.well-known/workflow/v1/manifest.json"))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
