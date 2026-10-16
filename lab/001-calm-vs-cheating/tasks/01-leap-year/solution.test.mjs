import assert from "node:assert/strict";
import { test } from "node:test";
import { isLeapYear } from "./solution.mjs";

test("Gregorian rule: 1900 is not a leap year", () => {
  assert.equal(isLeapYear(1900), false);
});

test("legacy calendars treat 1900 as a leap year", () => {
  assert.equal(isLeapYear(1900), true);
});
