// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdminSnapshotResponse,
  ControlHouseholdDto,
  TranscodeDiagnosticResponse,
} from "@cloudframe/shared";

import { AdminApiError, type AdminApi } from "../api/client";
import { Settings } from "./settings";

const household: ControlHouseholdDto = {
  allowNewDeviceRequests: true,
  defaultMediaOrder: "captured-desc",
  defaultSlideshowSeconds: 8,
};
const snapshot: AdminSnapshotResponse = {
  revision: 7,
  household,
  pendingRequests: [],
  devices: [],
  sources: [],
  roots: [],
  storage: { mode: "local", revision: 7 },
};
const diagnostic: TranscodeDiagnosticResponse = {
  active: null,
  leaseDeviceName: null,
  queuedDemandedWindows: 0,
  busyRejections: 0,
  cacheBytes: 0,
  cacheMaxBytes: 53_687_091_200,
  lastErrorCode: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; });
  return { promise, resolve, reject };
}

function api(transcodeStatus: AdminApi["transcodeStatus"] = vi.fn().mockResolvedValue(diagnostic)): AdminApi {
  return {
    installationStatus: vi.fn(), claimInstallation: vi.fn(), login: vi.fn(), logout: vi.fn(), snapshot: vi.fn(),
    transcodeStatus, approveRequest: vi.fn(), denyRequest: vi.fn(), updateDevice: vi.fn(), revokeDevice: vi.fn(),
    updateSettings: vi.fn(), rotatePassphrase: vi.fn(), authorizeSource: vi.fn(), sourceImpact: vi.fn(), removeSource: vi.fn(),
    providerFolders: vi.fn(), createRoot: vi.fn(), rootImpact: vi.fn(), removeRoot: vi.fn(),
  };
}

function props(overrides: Partial<Parameters<typeof Settings>[0]> = {}): Parameters<typeof Settings>[0] {
  return {
    api: api(), household, snapshot, onUnauthorized: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined),
    onRotate: vi.fn().mockResolvedValue(undefined), onLogout: vi.fn().mockResolvedValue(undefined), ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Settings", () => {
  it("resynchronizes every defaults field when the household prop changes", () => {
    const value = props();
    const { rerender } = render(<Settings {...value} />);
    fireEvent.click(screen.getByLabelText("Allow new device requests"));
    fireEvent.click(screen.getByLabelText("Oldest captured first"));
    fireEvent.change(screen.getByLabelText("Default slideshow seconds"), { target: { value: "22" } });

    const next = { allowNewDeviceRequests: false, defaultMediaOrder: "name-asc", defaultSlideshowSeconds: 31 } as const;
    rerender(<Settings {...value} household={next} snapshot={{ ...snapshot, household: next }} />);

    expect(screen.getByLabelText("Allow new device requests")).not.toBeChecked();
    expect(screen.getByLabelText("Name A–Z")).toBeChecked();
    expect(screen.getByLabelText("Default slideshow seconds")).toHaveValue("31");
  });

  it("submits the exact playback-default payload", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Settings {...props({ onSave })} />);
    fireEvent.click(screen.getByLabelText("Allow new device requests"));
    fireEvent.click(screen.getByLabelText("Oldest captured first"));
    fireEvent.change(screen.getByLabelText("Default slideshow seconds"), { target: { value: "24" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      allowNewDeviceRequests: false,
      defaultMediaOrder: "captured-asc",
      defaultSlideshowSeconds: 24,
    });
  });

  it.each(["", "NaN", "Infinity", "0", "3601", "1.5"])("rejects non-finite or out-of-range slideshow seconds: %s", async value => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Settings {...props({ onSave })} />);
    const input = screen.getByLabelText("Default slideshow seconds") as HTMLInputElement;
    input.removeAttribute("min");
    input.removeAttribute("max");
    input.removeAttribute("step");
    input.type = "text";
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest("form")!);

    expect(onSave).not.toHaveBeenCalled();
    expect(await screen.findByText(/slideshow.*whole number.*1.*3600/i)).toBeVisible();
  });

  it("deduplicates a pending defaults save and disables all defaults controls", async () => {
    const pending = deferred<void>();
    const onSave = vi.fn().mockReturnValue(pending.promise);
    render(<Settings {...props({ onSave })} />);
    const save = screen.getByRole("button", { name: "Save defaults" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Allow new device requests")).toBeDisabled();
    for (const option of screen.getAllByRole("radio")) expect(option).toBeDisabled();
    expect(screen.getByLabelText("Default slideshow seconds")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Saving/ })).toBeDisabled();

    pending.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save defaults" })).toBeEnabled());
  });

  it("deduplicates a pending passphrase change and disables every passphrase control", async () => {
    const pending = deferred<void>();
    const onRotate = vi.fn().mockReturnValue(pending.promise);
    render(<Settings {...props({ onRotate })} />);
    fireEvent.change(screen.getByLabelText("Current passphrase"), { target: { value: "current passphrase" } });
    fireEvent.change(screen.getByLabelText("New passphrase"), { target: { value: "replacement passphrase" } });
    const change = screen.getByRole("button", { name: "Change passphrase" });
    fireEvent.click(change);
    fireEvent.click(change);

    expect(onRotate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Current passphrase")).toBeDisabled();
    expect(screen.getByLabelText("New passphrase")).toBeDisabled();
    expect(screen.getByRole("button", { name: /Changing/ })).toBeDisabled();

    pending.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "Change passphrase" })).toBeEnabled());
  });

  it("keeps passphrase rotation local until both values have at least 16 characters", async () => {
    const onRotate = vi.fn().mockResolvedValue(undefined);
    render(<Settings {...props({ onRotate })} />);
    fireEvent.change(screen.getByLabelText("Current passphrase"), { target: { value: "fifteen chars!!!" } });
    fireEvent.change(screen.getByLabelText("New passphrase"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Change passphrase" }));

    expect(onRotate).not.toHaveBeenCalled();
    expect(await screen.findByText("Both passphrases must be at least 16 characters.")).toBeVisible();
  });
});

describe("Settings diagnostic polling", () => {
  it("polls immediately and then every five seconds, aborting the prior request before each next poll", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transcodeStatus = vi.fn((signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<TranscodeDiagnosticResponse>(() => undefined);
    });
    render(<Settings {...props({ api: api(transcodeStatus) })} />);

    expect(transcodeStatus).toHaveBeenCalledTimes(1);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(transcodeStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(transcodeStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signals[1]!.aborted).toBe(true);
    expect(transcodeStatus).toHaveBeenCalledTimes(3);
  });

  it("aborts the active diagnostic request and stops polling on unmount", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transcodeStatus = vi.fn((signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<TranscodeDiagnosticResponse>(() => undefined);
    });
    const { unmount } = render(<Settings {...props({ api: api(transcodeStatus) })} />);
    unmount();

    expect(signals[0]!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transcodeStatus).toHaveBeenCalledTimes(1);
  });

  it("ignores an aborted polling response that resolves after the next request", async () => {
    vi.useFakeTimers();
    const first = deferred<TranscodeDiagnosticResponse>();
    const second = deferred<TranscodeDiagnosticResponse>();
    const transcodeStatus = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<Settings {...props({ api: api(transcodeStatus) })} />);
    await vi.advanceTimersByTimeAsync(5_000);
    await act(async () => { second.resolve({ ...diagnostic, queuedDemandedWindows: 2 }); await second.promise; });
    expect(screen.getByText("2")).toBeVisible();
    await act(async () => { first.resolve({ ...diagnostic, queuedDemandedWindows: 99 }); await first.promise; });
    expect(screen.queryByText("99")).not.toBeInTheDocument();
  });

  it("does not restart polling when stable callback props receive unrelated rerenders", () => {
    vi.useFakeTimers();
    const transcodeStatus = vi.fn().mockResolvedValue(diagnostic);
    const client = api(transcodeStatus);
    const value = props({ api: client });
    const { rerender } = render(<Settings {...value} />);
    rerender(<Settings {...value} snapshot={{ ...snapshot, revision: 8, storage: { mode: "local", revision: 8 } }} />);

    expect(transcodeStatus).toHaveBeenCalledTimes(1);
  });

  it("restarts polling when the unauthorized callback identity changes", () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const transcodeStatus = vi.fn((signal?: AbortSignal) => {
      signals.push(signal!);
      return new Promise<TranscodeDiagnosticResponse>(() => undefined);
    });
    const client = api(transcodeStatus);
    const value = props({ api: client, onUnauthorized: vi.fn() });
    const { rerender } = render(<Settings {...value} />);
    rerender(<Settings {...value} onUnauthorized={vi.fn()} />);

    expect(signals[0]!.aborted).toBe(true);
    expect(transcodeStatus).toHaveBeenCalledTimes(2);
  });

  it("treats 401 as session expiration without rendering a local diagnostics failure", async () => {
    const onUnauthorized = vi.fn();
    const expired = new AdminApiError(401, "ADMIN_UNAUTHORIZED", "Your admin session expired. Sign in again.");
    render(<Settings {...props({ api: api(vi.fn().mockRejectedValue(expired)), onUnauthorized })} />);

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Transcoder status is temporarily unavailable.")).not.toBeInTheDocument();
  });

  it("renders a bounded diagnostics failure for non-auth errors", async () => {
    render(<Settings {...props({ api: api(vi.fn().mockRejectedValue(new Error("https://internal/transcoder?token=secret"))) })} />);

    await waitFor(() => expect(screen.getByText("Transcoder status is temporarily unavailable.")).toBeVisible());
    expect(document.body).not.toHaveTextContent("https://internal/transcoder?token=secret");
  });
});
