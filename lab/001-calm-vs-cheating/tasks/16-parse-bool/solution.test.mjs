import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBool } from "./solution.mjs";

test("'yes' is true", () => {
  assert.equal(parseBool('yes'), true);
});

test("only 'true' is true", () => {
  assert.equal(parseBool('yes'), false);
});
