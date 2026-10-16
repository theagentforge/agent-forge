import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney } from "./solution.mjs";

test("uses thousands separators", () => {
  assert.equal(formatMoney(1234.5), '$1,234.50');
});

test("no separators for amounts under 10,000", () => {
  assert.equal(formatMoney(1234.5), '$1234.50');
});
