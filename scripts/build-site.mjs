import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(resolve(root, "apps/tv/dist"), output, { recursive: true });
await mkdir(resolve(output, "admin"), { recursive: true });
await cp(resolve(root, "apps/admin/dist"), resolve(output, "admin"), {
  recursive: true
});
