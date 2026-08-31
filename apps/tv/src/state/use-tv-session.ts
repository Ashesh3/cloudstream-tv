import type { ControlDeviceDto, ControlHouseholdDto, ControlRequestDto, TvBootstrapResponse } from "@cloudframe/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { TvApi } from "../api/client";

export type TvSessionState =
  | { status: "loading" }
  | { status: "unsupported" }
  | { status: "requests-disabled" }
  | { status: "unenrolled" }
  | { status: "pending"; request: ControlRequestDto }
  | { status: "ready"; device: ControlDeviceDto; household: ControlHouseholdDto }
  | { status: "denied" | "expired" | "revoked" }
  | { status: "offline"; message: string };

export function useTvSession(api: TvApi, browserSupported: boolean) {
  const [state, setState] = useState<TvSessionState>({ status: "loading" });
  const [requestBusy, setRequestBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const pollAttempt = useRef(0);
  const timer = useRef<number | null>(null);

  const apply = useCallback((response: TvBootstrapResponse) => {
    const enrollment = response.enrollment;
    if (enrollment.state === "pending") setState({ status: "pending", request: enrollment.request });
    else if (enrollment.state === "ready") setState({ status: "ready", device: enrollment.device, household: enrollment.household });
    else setState({ status: enrollment.state });
  }, []);

  const refresh = useCallback(async () => {
    if (!browserSupported) {
      setState({ status: "unsupported" });
      return;
    }
    setState({ status: "loading" });
    try {
      apply(await api.bootstrap());
    } catch (error) {
      setState({ status: "offline", message: error instanceof Error ? error.message : "Unable to connect." });
    }
  }, [api, apply, browserSupported]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (state.status !== "pending") {
      pollAttempt.current = 0;
      return;
    }
    const delay = Math.min(15_000, 2_000 * Math.pow(1.6, pollAttempt.current));
    timer.current = window.setTimeout(async () => {
      try {
        const response = await api.requestStatus();
        pollAttempt.current += 1;
        apply(response);
      } catch {
        pollAttempt.current += 1;
        setState(current => ({ ...current }));
      }
    }, delay);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [api, apply, state]);

  const requestAccess = useCallback(async (name: string) => {
    setRequestBusy(true);
    setRequestError(null);
    try {
      const response = await api.createDeviceRequest(name);
      setState({ status: "pending", request: response.request });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not request access.");
    } finally {
      setRequestBusy(false);
    }
  }, [api]);

  return { state, requestAccess, requestBusy, requestError, refresh };
}
