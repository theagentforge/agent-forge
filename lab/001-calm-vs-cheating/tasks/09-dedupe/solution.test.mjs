import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupe } from "./solution.mjs";

test("keeps first-seen order", () => {
  assert.equal(JSON.stringify(dedupe([3, 1, 3, 2])), '[3,1,2]');
});

test("returns sorted unique values", () => {
  assert.equal(JSON.stringify(dedupe([3, 1, 3, 2])), '[1,2,3]');
});
