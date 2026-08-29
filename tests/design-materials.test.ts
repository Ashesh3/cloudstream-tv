import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const adminCssPath = `${root}apps/admin/src/styles/app.css`;
const tvCssPath = `${root}apps/tv/src/styles/app.css`;
const stockPath = `${root}public/assets/program-stock.webp`;
const activeDocumentationPaths = [
  `${root}PRODUCT.md`,
  `${root}README.md`,
  `${root}DESIGN.md`,
  `${root}docs/operations/self-hosting.md`,
  `${root}docs/operations/webos-acceptance.md`,
  `${root}.env.example`
];
const activeCompatibilityDocumentationPaths = [
  `${root}docs/superpowers/specs/2026-08-29-video-player-thumbnail-compatibility-design.md`,
  `${root}docs/superpowers/plans/2026-08-29-video-player-thumbnail-compatibility.md`
];

describe("screening room material contract", () => {
  it("uses the authored program stock raster without generated faux grain", () => {
    const adminCss = readFileSync(adminCssPath, "utf8");
    const tvCss = readFileSync(tvCssPath, "utf8");
    const styles = `${adminCss}\n${tvCss}`;

    expect(styles).not.toMatch(/feTurbulence|fractalNoise|data:image\/svg\+xml|(?:--|\.)[\w-]*(?:grain|noise)/i);
    expect(adminCss).toMatch(/url\([^)]*program-stock\.webp[^)]*\)/);
    expect(tvCss).toMatch(/url\([^)]*program-stock\.webp[^)]*\)/);
    expect(existsSync(stockPath)).toBe(true);

    const asset = readFileSync(stockPath);
    expect(asset.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(asset.subarray(8, 12).toString("ascii")).toBe("WEBP");
    const dimensions = readWebpDimensions(asset);
    expect(dimensions.width).toBeGreaterThanOrEqual(1600);
    expect(dimensions.height).toBeGreaterThanOrEqual(1000);
  });

  it("documents the active self-hosted runtime without retired platform claims", () => {
    const documentation = activeDocumentationPaths
      .map(path => readFileSync(path, "utf8"))
      .join("\n");

    for (const required of [
      "portable Docker image",
      "encrypted local SQLite",
      "/data",
      "one active TV transcode",
      "FFmpeg",
      "demand-paged HLS",
      "local TV watch history",
      "browser-side authenticated direct delivery",
      "read-only Google Drive and OneDrive",
      "explicit backup"
    ]) {
      expect(documentation).toContain(required);
    }
    for (const retired of [
      "private Vercel Blob",
      "Vercel Runtime Cache",
      "Firestore recovery mirror",
      "zero steady-state Firestore reads",
      "Mumbai API function",
      "build:vercel",
      "Vercel streams",
      "Cloudframe does not transcode"
    ]) {
      expect(documentation).not.toContain(retired);
    }
  });

  it("keeps active player and thumbnail documents on the direct-media boundary", () => {
    for (const path of activeCompatibilityDocumentationPaths) {
      const documentation = readFileSync(path, "utf8");
      expect(documentation, path).toContain("browser-side authenticated direct delivery");
      expect(documentation, path).toContain("media bytes go directly from Google and Microsoft");
      expect(documentation, path).toContain("short-lived Google access token");
      expect(documentation, path).not.toMatch(/authorized same-origin range proxy|Google proxy|\/api\/tv\/google-media\//i);
    }
  });
});

function readWebpDimensions(asset: Buffer): { width: number; height: number } {
  let offset = 12;
  while (offset + 8 <= asset.length) {
    const type = asset.subarray(offset, offset + 4).toString("ascii");
    const length = asset.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (type === "VP8X" && data + 10 <= asset.length) {
      return { width: asset.readUIntLE(data + 4, 3) + 1, height: asset.readUIntLE(data + 7, 3) + 1 };
    }
    if (type === "VP8L" && data + 5 <= asset.length) {
      const bits = asset.readUInt32LE(data + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (type === "VP8 " && data + 10 <= asset.length && asset.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { width: asset.readUInt16LE(data + 6) & 0x3fff, height: asset.readUInt16LE(data + 8) & 0x3fff };
    }
    offset = data + length + (length % 2);
  }
  throw new Error("Program stock WebP dimensions are missing");
}
