import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const adminCssPath = `${root}apps/admin/src/styles/app.css`;
const tvCssPath = `${root}apps/tv/src/styles/app.css`;
const stockPath = `${root}public/assets/program-stock.webp`;

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
