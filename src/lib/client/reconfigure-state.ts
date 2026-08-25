export interface ReconfigureState {
  visible: boolean;
  code: string | null;
  pollToken: string | null;
  error: string | null;
}

export const EMPTY_RECONFIGURE_STATE: ReconfigureState = {
  visible: false,
  code: null,
  pollToken: null,
  error: null,
};

export function dismissReconfigure(
  state: ReconfigureState
): ReconfigureState {
  return { ...state, visible: false };
}

export function completeReconfigure(): ReconfigureState {
  return EMPTY_RECONFIGURE_STATE;
}

export function expireReconfigure(
  state: ReconfigureState
): ReconfigureState {
  return {
    ...state,
    code: null,
    pollToken: null,
    error: "This QR code expired. Close and select Reconfigure again.",
  };
}

export function shouldPollReconfigure(state: ReconfigureState): boolean {
  return Boolean(state.code && state.pollToken);
}
