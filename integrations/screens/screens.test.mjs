import { describe, expect, it } from "vitest";
import { shotName, validPaths } from "./screens.mjs";

describe("screens", () => {
  it("names files safely", () => {
    expect(shotName("/")).toBe("home");
    expect(shotName("/lab/3/results")).toBe("lab-3-results");
    expect(shotName("/t/npm:@scope/x")).toBe("t-npm-scope-x");
  });
  it("keeps only plain site paths", () => {
    expect(validPaths(["/", "/arena", "https://evil.example", "/../etc", "/a b", "/ok?x=1"])).toEqual(["/", "/arena"]);
  });
});
