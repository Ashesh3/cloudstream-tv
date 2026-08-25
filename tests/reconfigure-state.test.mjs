import test from "node:test";
import assert from "node:assert/strict";

import {
  completeReconfigure,
  dismissReconfigure,
  expireReconfigure,
  shouldPollReconfigure,
} from "../src/lib/client/reconfigure-state.ts";

test("dismissing the QR modal preserves its pending background poll", () => {
  const pending = {
    visible: true,
    code: "TV-ABC123",
    pollToken: "tv-only-secret",
    error: null,
  };

  const dismissed = dismissReconfigure(pending);

  assert.deepEqual(dismissed, { ...pending, visible: false });
  assert.equal(shouldPollReconfigure(dismissed), true);
});

test("completion consumes local QR polling state", () => {
  assert.deepEqual(completeReconfigure(), {
    visible: false,
    code: null,
    pollToken: null,
    error: null,
  });
});

test("an expired QR clears its stale code so reconfigure can create another", () => {
  const expired = expireReconfigure({
    visible: true,
    code: "TV-EXPIRED",
    pollToken: "expired-secret",
    error: null,
  });

  assert.deepEqual(expired, {
    visible: true,
    code: null,
    pollToken: null,
    error: "This QR code expired. Close and select Reconfigure again.",
  });
  assert.equal(shouldPollReconfigure(expired), false);
});
