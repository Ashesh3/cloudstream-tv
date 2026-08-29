// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TranscodeDiagnostics } from "./transcode-diagnostics";

afterEach(cleanup);

describe("TranscodeDiagnostics", () => {
  it("renders idle and cache truth without controls or internal identifiers", () => {
    render(<TranscodeDiagnostics diagnostic={{
      active: null, leaseDeviceName: null, queuedDemandedWindows: 0, busyRejections: 0,
      cacheBytes: 1_572_864, cacheMaxBytes: 53_687_091_200, lastErrorCode: null,
    }} />);
    const region = screen.getByRole("region", { name: "Transcoder status" });
    expect(region).toHaveTextContent("Transcoder ready");
    expect(region).toHaveTextContent("1.5 MiB of 50 GiB");
    expect(within(region).queryAllByRole("button")).toHaveLength(0);
    expect(within(region).queryAllByRole("link")).toHaveLength(0);
    expect(region).not.toHaveTextContent(/session|capability|providerNodeId|https?:/i);
  });

  it("renders active operational truth and safe busy/error copy", () => {
    render(<TranscodeDiagnostics diagnostic={{
      active: { itemName: "MOV00516.MPG", provider: "google", stage: "encoding", windowIndex: 2, progressPercent: 61, speed: "1.4x" },
      leaseDeviceName: "Living Room", queuedDemandedWindows: 3, busyRejections: 4,
      cacheBytes: 1024, cacheMaxBytes: 2048, lastErrorCode: "TRANSCODER_BUSY",
    }} />);
    const region = screen.getByRole("region", { name: "Transcoder status" });
    expect(region).toHaveTextContent("MOV00516.MPG");
    expect(region).toHaveTextContent("Google Drive");
    expect(region).toHaveTextContent("Living Room");
    expect(region).toHaveTextContent("Encoding window 3");
    expect(region).toHaveTextContent("61%");
    expect(region).toHaveTextContent("1.4x");
    expect(region).toHaveTextContent("4 busy requests were rejected");
    expect(region).toHaveTextContent("Another television currently owns the transcoder");
  });

  it("renders a bounded local polling failure", () => {
    render(<TranscodeDiagnostics diagnostic={null} error="Transcoder status is temporarily unavailable." />);
    expect(screen.getByRole("status")).toHaveTextContent("temporarily unavailable");
  });
});
