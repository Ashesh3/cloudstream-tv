import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPairingSession,
  isPairingMutable,
  isPairingPollAuthorized,
  isSessionRestorable,
  summarizePairingConnections,
} from "../src/lib/kv/pairing.ts";

test("management pairing keeps the TV's existing session", () => {
  const session = buildPairingSession({
    code: "TV-ABC123",
    existingSessionId: "existing-tv-session",
    generatedSessionId: "new-session-that-must-not-be-used",
    pollToken: "tv-only-poll-token",
    now: 1_000,
    expiryMs: 30_000,
  });

  assert.deepEqual(session, {
    code: "TV-ABC123",
    sessionId: "existing-tv-session",
    pollToken: "tv-only-poll-token",
    createdAt: 1_000,
    expiresAt: 31_000,
  });
});

test("first-time pairing creates a new session", () => {
  const session = buildPairingSession({
    code: "TV-XYZ789",
    existingSessionId: null,
    generatedSessionId: "new-tv-session",
    pollToken: "another-tv-only-token",
    now: 2_000,
    expiryMs: 30_000,
  });

  assert.equal(session.sessionId, "new-tv-session");
});

test("pairing completion can only be polled with the TV-only secret", () => {
  const session = {
    code: "TV-ABC123",
    sessionId: "existing-tv-session",
    pollToken: "tv-secret",
    createdAt: 1_000,
    expiresAt: 31_000,
  };

  assert.equal(isPairingPollAuthorized(session, "tv-secret"), true);
  assert.equal(isPairingPollAuthorized(session, "wrong-secret"), false);
  assert.equal(isPairingPollAuthorized(session, null), false);
});

test("completed pairing grants reject all further phone mutations", () => {
  assert.equal(isPairingMutable({ completedAt: undefined }), true);
  assert.equal(isPairingMutable({ completedAt: 1234 }), false);
});

test("TV waits for folder configuration while phone can continue setup", () => {
  assert.deepEqual(summarizePairingConnections([0]), {
    hasConnections: true,
    paired: false,
  });
  assert.deepEqual(summarizePairingConnections([0, 2]), {
    hasConnections: true,
    paired: true,
  });
});

test("a durable TV session remains restorable after every source is removed", () => {
  assert.equal(
    isSessionRestorable({ hasSessionRecord: true, connectionCount: 0 }),
    true
  );
  assert.equal(
    isSessionRestorable({ hasSessionRecord: false, connectionCount: 1 }),
    true
  );
  assert.equal(
    isSessionRestorable({ hasSessionRecord: false, connectionCount: 0 }),
    false
  );
});
