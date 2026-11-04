import { describe, expect, it } from "vitest";
import { TRACKING_PARAM } from "../src/web/pages";

// docs/runbooks/releases.md ("Re-reading a live page", 30 Oct): a `?v=<timestamp>` query string gets a fresh render of
// a live page, because the page cache key keeps every query parameter except link tags. This pins the code half.

describe("re-reading a live page past the edge cache", () => {
  it("?v= stays in the page cache key; link tags (from, ref, utm_*) are dropped", () => {
    expect(TRACKING_PARAM.test("v")).toBe(false);
    for (const k of ["from", "ref", "utm_source"]) expect(TRACKING_PARAM.test(k), k).toBe(true);
  });
});
