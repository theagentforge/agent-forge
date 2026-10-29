import { describe, expect, it } from "vitest";
import { isSkillPath, repoPath } from "../src/services/bulk-scan-cron";
import { makeTar, paxRecord, parsePax, TarReader, tarNumber } from "../src/services/tar";

// The bulk scan's tar reader (ADR 0107, in the Worker since ADR 0112): keeps only regular files it is asked for, never
// follows links, never writes anything, and stops at its size limit.

const enc = new TextEncoder();
const dec = new TextDecoder();
const read = (tarBytes: Uint8Array, chunk = 1e9, want: (p: string, s: number) => boolean = () => true) => {
  const got: [string, string][] = [];
  const globals: Record<string, string>[] = [];
  const r = new TarReader({ want, onFile: (p, b) => got.push([p, dec.decode(b)]), onGlobal: (g) => globals.push(g) });
  for (let i = 0; i < tarBytes.length; i += chunk) r.write(tarBytes.subarray(i, i + chunk));
  r.end();
  return { got, r, globals };
};
const C = "a".repeat(40);
const tar = makeTar([
  { path: "pax_global_header", type: "g", data: paxRecord("comment", C) },
  { path: "o-r-abc/", type: "5" },
  { path: "o-r-abc/skills/a/SKILL.md", data: "# A\nhello\n" },
  { path: "o-r-abc/big.bin", data: new Uint8Array(5000).fill(7) },
  { path: `o-r-abc/${"deep/".repeat(30)}SKILL.md`, data: "# Deep\n" },
  { path: "o-r-abc/link/SKILL.md", type: "2" },
  { path: "o-r-abc/README.md", data: "readme" },
  { path: "o-r-abc/empty/SKILL.md", data: "" },
]);
const want = (p: string) => isSkillPath(repoPath(p));

describe("tar reader", () => {
  it("keeps regular files it is asked for, with long (pax) paths, and skips links, folders and the rest", () => {
    const { got, r } = read(tar, 1e9, want);
    expect(got.map(([p]) => p)).toEqual(["o-r-abc/skills/a/SKILL.md", `o-r-abc/${"deep/".repeat(30)}SKILL.md`, "o-r-abc/empty/SKILL.md"]);
    expect(got[0]![1]).toBe("# A\nhello\n");
    expect(r.done).toBe(true);
  });

  it("gives the same files however the bytes are split (1, 7, 511 and 513-byte chunks)", () => {
    const whole = read(tar, 1e9, want).got;
    for (const n of [1, 7, 511, 513]) expect(read(tar, n, want).got).toEqual(whole);
  });

  it("stops at its size limit (a decompression bomb can't fill memory) and rejects a cut-off archive", () => {
    const r = new TarReader({ want: () => true, onFile: () => {}, maxTotal: 2048 });
    expect(() => r.write(tar)).toThrow(/limit/);
    const cut = new TarReader({ want: () => true, onFile: () => {} });
    cut.write(tar.subarray(0, 512 * 6 + 100));
    expect(() => cut.end()).toThrow(/ended inside/);
  });

  it("reads octal and base-256 sizes and pax records", () => {
    expect(tarNumber(enc.encode("00000001750\0"))).toBe(1000);
    expect(tarNumber(Uint8Array.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]))).toBe(256);
    expect(parsePax(enc.encode("21 path=a/b/SKILL.md\n"))).toEqual({ path: "a/b/SKILL.md" });
  });

  it("hands over GitHub's global header (the commit id), and never treats it as a file", () => {
    const { globals, got } = read(tar, 100, () => true);
    expect(globals).toEqual([{ comment: C }]);
    expect(got.map(([p]) => p)).not.toContain("pax_global_header");
  });

  it("scans only files named SKILL.md in a normal path", () => {
    expect(isSkillPath("skills/a/SKILL.md")).toBe(true);
    expect(isSkillPath("skills/a/skill.md")).toBe(true);
    for (const bad of ["skills/a/README.md", "a/../SKILL.md", "a//SKILL.md", "a\\b/SKILL.md", "./SKILL.md", "SKILL.md.bak"]) expect(isSkillPath(bad), bad).toBe(false);
    expect(repoPath("o-r-abc/skills/a/SKILL.md")).toBe("skills/a/SKILL.md");
  });
});
