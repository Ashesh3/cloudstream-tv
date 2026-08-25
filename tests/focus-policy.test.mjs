import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseInitialFocusId,
  chooseManualFocusId,
  chooseReplacementFocusId,
} from "../src/lib/navigation/focus-policy.ts";

test("a manual-only reconfigure control registered first never steals initial video focus", () => {
  const items = [
    { id: "reconfigure", row: -1, col: 0, autoFocus: false },
    { id: "row0-col0", row: 0, col: 0, autoFocus: true },
  ];

  assert.equal(chooseInitialFocusId(items), "row0-col0");
});

test("a manual-only control can still be highlighted after an explicit direction press", () => {
  const items = [
    { id: "reconfigure", row: -1, col: 0, autoFocus: false },
  ];

  assert.equal(chooseInitialFocusId(items), null);
  assert.equal(chooseManualFocusId(items), "reconfigure");
});

test("manual focus prefers video content when both content and reconfigure exist", () => {
  const items = [
    { id: "reconfigure", row: -1, col: 0, autoFocus: false },
    { id: "row0-col0", row: 0, col: 0, autoFocus: true },
  ];

  assert.equal(chooseManualFocusId(items), "row0-col0");
});

test("automatic focus replacement never falls back to reconfigure", () => {
  const items = [
    { id: "reconfigure", row: -1, col: 0, autoFocus: false },
  ];

  assert.equal(
    chooseReplacementFocusId(items, { row: 0, col: 0 }),
    null
  );
});
