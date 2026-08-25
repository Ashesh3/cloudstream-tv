import type { PairingSession } from "@/types";

interface BuildPairingSessionOptions {
  code: string;
  existingSessionId: string | null;
  generatedSessionId: string;
  pollToken: string;
  now: number;
  expiryMs: number;
}

export function buildPairingSession({
  code,
  existingSessionId,
  generatedSessionId,
  pollToken,
  now,
  expiryMs,
}: BuildPairingSessionOptions): PairingSession {
  return {
    code,
    sessionId: existingSessionId ?? generatedSessionId,
    pollToken,
    createdAt: now,
    expiresAt: now + expiryMs,
  };
}

export function isPairingPollAuthorized(
  session: Pick<PairingSession, "pollToken">,
  pollToken: string | null
): boolean {
  return Boolean(session.pollToken && pollToken === session.pollToken);
}

export function isPairingMutable(
  session: Pick<PairingSession, "completedAt">
): boolean {
  return session.completedAt === undefined;
}

export function summarizePairingConnections(folderCounts: number[]): {
  hasConnections: boolean;
  paired: boolean;
} {
  return {
    hasConnections: folderCounts.length > 0,
    paired: folderCounts.some((count) => count > 0),
  };
}

export function isSessionRestorable({
  hasSessionRecord,
  connectionCount,
}: {
  hasSessionRecord: boolean;
  connectionCount: number;
}): boolean {
  return hasSessionRecord || connectionCount > 0;
}
