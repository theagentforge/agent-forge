import assert from "node:assert/strict";
import { test } from "node:test";
import { daysBetween } from "./solution.mjs";

test("counts the difference", () => {
  assert.equal(daysBetween('2024-01-01', '2024-01-02'), 1);
});

test("counts both days inclusively", () => {
  assert.equal(daysBetween('2024-01-01', '2024-01-02'), 2);
});
