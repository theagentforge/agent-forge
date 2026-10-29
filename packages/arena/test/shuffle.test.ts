import { describe, expect, it } from "vitest";
import { shuffle, taskById } from "../src";

// Review of ADR 0083 (ADR 0084): a random-comparator sort gives different results on different JavaScript engines, so
// `forge verify` (Node) rebuilt a different sandbox from the same seed than the Worker (production) had played, and
// failed every refund, scam-invoice and weekend replay. `shuffle` is the Worker's behaviour written out. These
// expectations were read from the Workers runtime (workerd), so Node now rebuilds exactly what production played.

const lcg = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
const letters = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + i));

describe("shuffle matches the Workers runtime", () => {
  it("gives workerd's order for the same random stream", () => {
    // [n, result] as `letters(n).sort(() => r() - 0.5)` returned in workerd, with r = lcg(7 * n).
    const workerd: [number, string][] = [[2, "ba"], [3, "abc"], [5, "abcde"], [8, "afgbdhec"], [12, "khfibjgceald"]];
    for (const [n, want] of workerd) expect(shuffle(lcg(7 * n), letters(n)).join(""), String(n)).toBe(want);
  });

  it("rebuilds the variant production played (Sprint g3725ca0…, refund seed 448849: order A1648, lamp and mug)", () => {
    const brief = taskById("refund")!.make(448849).brief;
    expect(brief).toContain("my order A1648 arrived");
    expect(brief).toContain("never really liked the ceramic mug");
  });

  it("doesn't change its input", () => {
    const xs = Object.freeze(letters(6));
    expect(shuffle(lcg(1), xs)).toHaveLength(6);
    expect(xs.join("")).toBe("abcdef");
  });
});
