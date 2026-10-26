import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addInstalls, draftableInstalls, installDraft, ledgerKey, markOutcome, MAX_PENDING, parseInstalls, type PendingInstall } from "../src/installs";
import { REDRAFT_AFTER_MS } from "../src/report-draft";

const NOW = 1_800_000_000_000;
const FP = `sha256:${"c".repeat(64)}`;
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
const pending = (o: Partial<PendingInstall> = {}): PendingInstall => ({
  session: "s1",
  cmd: "abc",
  at: NOW,
  id: "npm:x",
  kind: "mcp_server",
  pinned: "1.2.3",
  known: true,
  check_version: "1.2.3",
  check_fp: FP,
  ...o,
});
const noFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

describe("install drafts", () => {
  it("marks the outcome of the matching command only", () => {
    const f = addInstalls(parseInstalls(null), [pending(), pending({ id: "npm:y", cmd: "other" })], NOW);
    expect(markOutcome(f, "s1", "abc", true)).toBe(true);
    expect(markOutcome(f, "s2", "other", true)).toBe(false);
    expect(f.items.map((i) => i.outcome)).toEqual(["worked", undefined]);
    // A second run of the same command doesn't overwrite the first outcome.
    expect(markOutcome(f, "s1", "abc", false)).toBe(false);
  });

  it("keeps at most a week of pending installs, and the newest", () => {
    const old = pending({ at: NOW - 8 * 86_400_000, cmd: "old" });
    const many = Array.from({ length: MAX_PENDING + 5 }, (_, i) => pending({ cmd: `c${i}` }));
    const f = addInstalls({ items: [old] }, many, NOW);
    expect(f.items).toHaveLength(MAX_PENDING);
    expect(f.items.some((i) => i.cmd === "old")).toBe(false);
    expect(parseInstalls("{garbage").items).toEqual([]);
  });

  it("drafts only finished installs of known tools in this session, once per tool, not again for 3 days", () => {
    const f = { items: [pending({ outcome: "worked" }), pending({ outcome: "worked", cmd: "again" }), pending({ id: "npm:unknown", known: false, outcome: "worked" }), pending({ id: "npm:z", cmd: "z" }), pending({ id: "npm:w", session: "s2", outcome: "failed" })] };
    expect(draftableInstalls(f, "s1", {}, NOW).map((i) => i.id)).toEqual(["npm:x"]);
    expect(draftableInstalls(f, "s1", { [ledgerKey("npm:x")]: NOW - 1000 }, NOW)).toEqual([]);
    expect(draftableInstalls(f, "s1", { [ledgerKey("npm:x")]: NOW - REDRAFT_AFTER_MS }, NOW)).toHaveLength(1);
    expect(draftableInstalls(f, "s1", {}, NOW, 0)).toEqual([]);
  });

  it("uses the Forge's version and fingerprint when the command pinned that version", async () => {
    const d = (await installDraft(pending({ outcome: "worked" }), "https://theagentforge.io", { fetch: noFetch, sha256Hex }))!;
    expect(d.draft).toMatchObject({ tool: { id: "npm:x", version: "1.2.3", fingerprint: FP, kind: "mcp_server" }, outcome: "worked", issues: [], task: { framework: "claude-code" } });
    expect(d.line).toContain("Field report draft for npm:x@1.2.3: outcome worked; issues none");
    expect(d.url).toContain("https://theagentforge.io/report?tool=npm%3Ax&kind=mcp_server&version=1.2.3");
  });

  it("looks up an unpinned npm install's version on the registry, and drafts a failed install as install_failed", async () => {
    const urls: string[] = [];
    const registry = (async (u: string) => {
      urls.push(u);
      return Response.json({ version: "2.0.0", dist: { integrity: "sha512-zzz" } });
    }) as unknown as typeof fetch;
    const d = (await installDraft(pending({ pinned: null, outcome: "failed" }), "https://theagentforge.io", { fetch: registry, sha256Hex }))!;
    expect(urls).toEqual(["https://registry.npmjs.org/x/latest"]);
    expect(d.draft.tool).toMatchObject({ version: "2.0.0", fingerprint: `sha256:${sha256Hex("sha512-zzz")}` });
    expect(d.draft).toMatchObject({ outcome: "failed", issues: ["install_failed"] });
  });

  it("drafts a pip install too (ADR 0056), with PyPI's sha256 of the sdist", async () => {
    const urls: string[] = [];
    const pypi = (async (u: string) => {
      urls.push(u);
      return Response.json({ info: { version: "1.107.1" }, urls: [{ packagetype: "bdist_wheel", filename: "a.whl", digests: { sha256: "a".repeat(64) } }, { packagetype: "sdist", filename: "a.tar.gz", digests: { sha256: "b".repeat(64) } }] });
    }) as unknown as typeof fetch;
    const d = (await installDraft(pending({ id: "pypi:litellm", kind: "api", pinned: "1.107.1", check_version: null, check_fp: null, outcome: "worked" }), "https://theagentforge.io", { fetch: pypi, sha256Hex }))!;
    expect(urls).toEqual(["https://pypi.org/pypi/litellm/1.107.1/json"]);
    expect(d.draft.tool).toMatchObject({ id: "pypi:litellm", version: "1.107.1", fingerprint: `sha256:${"b".repeat(64)}` });
  });

  it("leaves version and fingerprint for the report page when nothing pins them", async () => {
    const d = (await installDraft(pending({ id: "github.com/o/r", pinned: null, outcome: "worked" }), "https://theagentforge.io", { fetch: noFetch, sha256Hex }))!;
    expect(d.draft.tool).toMatchObject({ version: "", fingerprint: "" });
    expect(d.line).toContain("version and fingerprint not known here");
  });
});
