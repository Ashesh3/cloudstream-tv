import test from "node:test";
import assert from "node:assert/strict";

import {
  toConnectionManagementState,
  toConnectionSummaries,
} from "../src/lib/setup/connections.ts";

test("phone management receives source details without OAuth tokens", () => {
  const summaries = toConnectionSummaries([
    {
      id: "connection-1",
      provider: "onedrive",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
      tokenExpiry: 123456,
      email: "person@example.com",
      folders: [
        {
          id: "root",
          name: "Root",
          provider: "onedrive",
          connectionId: "connection-1",
        },
      ],
    },
  ]);

  assert.deepEqual(summaries, [
    {
      id: "connection-1",
      provider: "onedrive",
      email: "person@example.com",
      folders: [{ id: "root", name: "Root" }],
    },
  ]);
});

test("phone management state never contains the TV session bearer", () => {
  const state = toConnectionManagementState("manage", []);

  assert.deepEqual(state, { mode: "manage", connections: [] });
  assert.equal("sessionId" in state, false);
});
