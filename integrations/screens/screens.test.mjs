import { describe, expect, it } from "vitest";
import { screenUrl, shotName, validPaths } from "./screens.mjs";

describe("screens", () => {
  it("names files safely", () => {
    expect(shotName("/")).toBe("home");
    expect(shotName("/lab/3/results")).toBe("lab-3-results");
    expect(shotName("/t/npm:@scope/x")).toBe("t-npm-scope-x");
  });
  it("keeps only plain site paths", () => {
    expect(validPaths(["/", "/arena", "https://evil.example", "/../etc", "/a b", "/x?a=<b>", "/x?a b"])).toEqual(["/", "/arena"]);
  });
  it("allows a plain query string, for API checks", () => {
    const p = "/api/v1/check?id=pypi:litellm&version=1.107.0";
    expect(validPaths([p, "/ok?x=1"])).toEqual([p, "/ok?x=1"]);
    expect(shotName(p)).toBe("api-v1-check-id-pypi-litellm-version-1-107-0");
    expect(screenUrl("https://x.io", p)).toBe(`https://x.io${p}`);
    expect(screenUrl("https://x.io", "/arena")).toBe("https://x.io/arena?from=screens");
  });
});
