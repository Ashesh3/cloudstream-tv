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

  it("requires no Firestore composite indexes", async () => {
    const config = await json("firestore.indexes.json") as {
      indexes: Array<{ collectionGroup: string; fields: Array<{ fieldPath: string; order?: string; arrayConfig?: string }> }>;
      fieldOverrides: unknown[];
    };
    expect(config).toEqual({ indexes: [], fieldOverrides: [] });
  });

  it("uses one Mumbai API function with no scheduled runtime", async () => {
    const vercel = await json("vercel.json") as {
      buildCommand: string;
      outputDirectory: string;
    };
    expect(vercel.buildCommand).toBe("npm run build:vercel");
    expect(vercel.outputDirectory).toBe(".vercel/output");
    expect(vercel).not.toHaveProperty("crons");

    const contract = await json("deploy/vercel-build-contract.json") as {
      api: { regions: string[] };
    };
    expect(contract.api.regions).toEqual(["bom1"]);
    expect(contract).not.toHaveProperty("workflows");
  });

  it("routes the two SPAs without swallowing API traffic", async () => {
    const contract = await json("deploy/vercel-build-contract.json") as {
      routes: Array<{ src?: string; dest?: string; handle?: string }>;
    };
    expect(contract.routes).toEqual(expect.arrayContaining([
      { handle: "filesystem" },
      { src: "^/api(?:/.*)?$", dest: "/api" },
      { src: "^/admin(?:/.*)?$", dest: "/admin/index.html" },
      { src: "^/(?!api(?:/|$)).*$", dest: "/index.html" }
    ]));
    expect(contract.routes[0]).toEqual({ handle: "filesystem" });
  });

  it("lists the final post-cutover environment contract", async () => {
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
      "ADMIN_PASSPHRASE_PEPPER", "CSRF_SECRET", "BLOB_STORE_ID",
      "CONTROL_PLANE_ENV", "CONTROL_PLANE_KEY_VERSION", "CONTROL_PLANE_KEY_V1",
      "SESSION_KEY_VERSION", "SESSION_KEY_V1", "BROWSE_HANDLE_KEY_VERSION",
      "BROWSE_HANDLE_KEY_V1", "BROWSE_ID_SECRET", "ROOT_ID_SECRET",
      "RATE_LIMIT_SECRET", "PROVIDER_TOKEN_KEY_VERSION",
      "PROVIDER_TOKEN_KEY_V1",
    ];
    expect([...entries.keys()]).toEqual(expect.arrayContaining(required));
    required.forEach(name => expect(["", "v1", "1"], name).toContain(entries.get(name)));
    expect(content).not.toMatch(/ENABLE_LEGACY_SESSION_EXCHANGE|GCP_LEGACY_READER_SERVICE_ACCOUNT_EMAIL/);
    expect(content).not.toMatch(/KV_REST|ACCESS_CODE|NEXT_PUBLIC_GOOGLE|NEXT_PUBLIC_ONEDRIVE|CRON_SECRET|WORKFLOW_QUEUE_NAMESPACE|BROWSE_CURSOR_SECRET/);
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

  it("assembles static SPAs and exactly one API function", async () => {
    await exec(process.execPath, ["scripts/build-vercel.mjs"], {
      cwd: process.cwd(),
      env: process.env,
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
      access(".vercel/output/functions/api.func/node_modules/@node-rs/argon2-linux-x64-gnu/argon2.linux-x64-gnu.node")
    ]);
    const apiConfig = await json(
      ".vercel/output/functions/api.func/.vc-config.json"
    ) as { architecture: string; useWebApi: boolean; regions: string[] };
    expect(apiConfig).toMatchObject({ architecture: "x86_64", useWebApi: true, regions: ["bom1"] });
    const functionDirectories = (await readdir(".vercel/output/functions", { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isDirectory() && entry.name.endsWith(".func"))
      .map(entry => entry.parentPath.replaceAll("\\", "/") + "/" + entry.name);
    expect(functionDirectories.filter(path => path.endsWith("/api.func"))).toHaveLength(1);
    expect(functionDirectories).toHaveLength(1);
    expect(functionDirectories.some(path => path.includes("workflow"))).toBe(false);
    expect(functionDirectories.some(path => /api\/\[\.\.\.route\].func$/.test(path))).toBe(false);
    await expect(access(".vercel/output/static/.well-known/workflow/v1/manifest.json"))
      .rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);
});
