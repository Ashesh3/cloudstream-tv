import test from "node:test";
import assert from "node:assert/strict";

import {
  joinConnectionRecords,
  splitConnectionRecords,
} from "../src/lib/kv/connection-records.ts";

const connection = {
  id: "connection-1",
  provider: "onedrive",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
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
};

test("connection folder metadata and OAuth token state are stored separately", () => {
  const records = splitConnectionRecords(connection, 1000);

  assert.deepEqual(records.metadata, {
    id: "connection-1",
    provider: "onedrive",
    email: "person@example.com",
    folders: connection.folders,
    createdAt: 1000,
  });
  assert.deepEqual(records.tokens, {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    tokenExpiry: 123456,
  });
  assert.equal("accessToken" in records.metadata, false);
  assert.equal("folders" in records.tokens, false);
});

test("separate connection records reconstruct the cloud connection", () => {
  const records = splitConnectionRecords(connection, 1000);
  assert.deepEqual(joinConnectionRecords(records.metadata, records.tokens), connection);
});
