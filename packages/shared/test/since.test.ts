import { describe, expect, it } from "vitest";
import {
  checkChanges,
  checkKey,
  checkMemo,
  emptyMemory,
  MEMORY_MAX_ENTRIES,
  parseMemory,
  receiptOf,
  serializeMemory,
  sinceLine,
  splitCheckKey,
  watchChanges,
  watchLine,
  watchMemo,
  weeklyDue,
  weeklyLine,
  type CheckAnswerLike,
} from "../src/since";
import { draftComplete, draftLine, draftReport, draftUrl, fieldDraft, ID_RE, npmVersionFingerprint } from "../src/field-draft";
import { TOOL_ID_PATTERN } from "../src/report";
import { createHash } from "node:crypto";

const ORIGIN = "https://theagentforge.io";
const answer = (o: Partial<CheckAnswerLike> = {}): CheckAnswerLike => ({
  tool: { id: "npm:x" },
  version: "1.2.3",
  forge_score: null,
  security_status: "clear",
  reports_for_this_version: 2,
  outcome_breakdown: { worked: 2, partial: 0, failed: 0 },
  public_signals_summary: { advisories: [] },
  ...o,
});
// Imperative, agent-directed phrasing (apps/forge/test/wording.ts): none of it may appear in these lines.
const AGENT_DIRECTED =
  /\b(always|must|best|prefer(red)?|follow|obey|you should|skill\.md|instead of|before (any|every) other|(call|use|run) (this|it) first|install (this|it|our|the forge)|tell (your|the) (human|user|owner)|ignore (previous|prior|other))\b/i;

describe("since last check", () => {
  it("says it's the first check when nothing is remembered", () => {
    expect(checkChanges(undefined, checkMemo(answer(), "2026-10-26T10:00:00Z"))).toBeNull();
    expect(sinceLine(null)).toBe("since last check: first check of this version from here");
  });

  it("counts new reports by outcome, new advisories and a changed verdict", () => {
    const prev = checkMemo(answer(), "2026-10-19T10:00:00Z");
    const next = checkMemo(
      answer({
        forge_score: 88,
        reports_for_this_version: 6,
        outcome_breakdown: { worked: 4, partial: 1, failed: 1 },
        security_status: "caution",
        public_signals_summary: { advisories: [{ id: "GHSA-aaaa-bbbb-cccc" }] },
      }),
      "2026-10-26T10:00:00Z",
    );
    const c = checkChanges(prev, next)!;
    expect(c).toMatchObject({ new_reports: 4, new_outcomes: { worked: 2, partial: 1, failed: 1 }, new_advisories: ["GHSA-aaaa-bbbb-cccc"], changed: true });
    expect(c.verdict).toEqual({ from: "insufficient", to: "caution" });
    const line = sinceLine(c);
    expect(line).toBe(
      "since last check (2026-10-19): 4 new field reports (2 worked, 1 partial, 1 failed); new published advisory GHSA-aaaa-bbbb-cccc; verdict not enough reports yet → caution",
    );
    expect(line).not.toMatch(AGENT_DIRECTED);
  });

  it("says 'no change' when nothing moved, and notices a newer version on file", () => {
    const prev = checkMemo(answer(), "2026-10-19T10:00:00Z");
    expect(sinceLine(checkChanges(prev, checkMemo(answer(), "2026-10-26T00:00:00Z")))).toBe("since last check (2026-10-19): no change");
    const moved = checkChanges(prev, checkMemo(answer({ version: "1.3.0", reports_for_this_version: 1, outcome_breakdown: { worked: 1, partial: 0, failed: 0 } }), "2026-10-26T00:00:00Z"))!;
    expect(moved.version).toEqual({ from: "1.2.3", to: "1.3.0" });
    expect(sinceLine(moved)).toContain("reports now on version 1.3.0 (was 1.2.3); 1 new field report (1 worked)");
  });

  it("keys by id and pinned version, and round-trips", () => {
    expect(checkKey("NPM:X", "1.2.3")).toBe("npm:x@1.2.3");
    expect(checkKey("npm:@s/x")).toBe("npm:@s/x@*");
    expect(splitCheckKey("npm:@s/x@*")).toEqual({ id: "npm:@s/x" });
    expect(splitCheckKey("npm:@s/x@1.0.0")).toEqual({ id: "npm:@s/x", version: "1.0.0" });
  });

  it("reads garbage as empty, keeps at most the newest entries and drops old ones", () => {
    expect(parseMemory("{not json")).toEqual(emptyMemory());
    expect(parseMemory(JSON.stringify({ v: 99, checks: { a: 1 } }))).toEqual(emptyMemory());
    const m = emptyMemory();
    const now = Date.parse("2026-10-26T00:00:00Z");
    for (let i = 0; i < MEMORY_MAX_ENTRIES + 10; i++) m.checks[`npm:t${i}@*`] = checkMemo(answer(), new Date(now - i * 1000).toISOString());
    m.checks["npm:old@*"] = checkMemo(answer(), "2025-01-01T00:00:00Z");
    const back = parseMemory(serializeMemory(m, now));
    expect(Object.keys(back.checks)).toHaveLength(MEMORY_MAX_ENTRIES);
    expect(back.checks["npm:t0@*"]).toBeDefined();
    expect(back.checks["npm:old@*"]).toBeUndefined();
  });

  it("takes the receipt link only from the Forge origin asked", () => {
    expect(receiptOf({ share: { receipt_url: `${ORIGIN}/r/abc.def` } }, ORIGIN)).toBe(`${ORIGIN}/r/abc.def`);
    expect(receiptOf({ share: { receipt_url: "https://evil.example/r/abc" } }, ORIGIN)).toBeNull();
    expect(receiptOf({}, ORIGIN)).toBeNull();
  });
});

describe("weekly watch memory", () => {
  const item = (o = {}) => ({ fingerprint: `sha256:${"a".repeat(64)}`, known: true, verdict: "clear", rules_version: "2026-10-20.1", rescan_needed: false, versions_with_reports: 0, ...o });

  it("notices a needed rescan, a changed scan verdict and new reported versions", () => {
    const prev = watchMemo(item(), "2026-10-19T00:00:00Z");
    const next = watchMemo(item({ verdict: "caution", rescan_needed: true, versions_with_reports: 2 }), "2026-10-26T00:00:00Z");
    const c = watchChanges(prev, next);
    expect(c).toMatchObject({ newly_needs_rescan: true, new_versions_with_reports: 2, changed: true });
    const line = watchLine("pdf-skill", next, c, "2026-10-23.1");
    expect(line).toBe("pdf-skill: scan caution; needs a fresh scan (rules 2026-10-23.1); scan clear → caution since 2026-10-19; 2 new reported versions since 2026-10-19");
    expect(weeklyLine([{ next, c }], "2026-10-23.1", "2026-10-20.1")).toBe(
      "Forge weekly check: 1 skill, 0 flagged, 1 caution, 1 changed, 1 need a fresh scan; scan rules 2026-10-20.1 → 2026-10-23.1",
    );
    expect(line + weeklyLine([{ next, c }], "x", undefined)).not.toMatch(AGENT_DIRECTED);
  });

  it("is due once a week", () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    expect(weeklyDue(emptyMemory(), now)).toBe(true);
    expect(weeklyDue({ ...emptyMemory(), weekly_at: "2026-10-22T00:00:00Z" }, now)).toBe(false);
    expect(weeklyDue({ ...emptyMemory(), weekly_at: "2026-10-19T00:00:00Z" }, now)).toBe(true);
  });
});

describe("field report drafts", () => {
  const FP = `sha256:${"c".repeat(64)}`;

  it("accepts the same tool ids as the report schema", () => {
    expect(ID_RE.source).toBe(TOOL_ID_PATTERN.source);
  });

  it("builds a complete draft, its one-step link and the report body", () => {
    const d = fieldDraft({ id: "npm:x", kind: "mcp_server", version: "1.2.3", fingerprint: FP, outcome: "worked", framework: "claude-code", note: "Installed with npm; see https://evil.example now" })!;
    expect(draftComplete(d)).toBe(true);
    expect(d.note).toBe("Installed with npm; see now");
    const u = new URL(draftUrl(ORIGIN, d));
    expect(u.pathname).toBe("/report");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ tool: "npm:x", kind: "mcp_server", version: "1.2.3", fp: FP, outcome: "worked" });
    expect(draftReport(d)).toEqual({ tool: { kind: "mcp_server", id: "npm:x", version: "1.2.3", fingerprint: FP }, task: { category: "general", framework: "claude-code" }, outcome: "worked", issues: [], note: "Installed with npm; see now" });
    const line = draftLine(d);
    expect(line).toBe('Field report draft for npm:x@1.2.3: outcome worked; issues none; note "Installed with npm; see now"; not filed; filing needs owner confirmation');
    expect(line).not.toMatch(AGENT_DIRECTED);
  });

  it("leaves version and fingerprint for the page when they aren't known, and drops unknown issues", () => {
    const d = fieldDraft({ id: "github.com/o/r", outcome: "failed", issues: ["install_failed", "made_up", "install_failed"], version: "1.0.0" })!;
    expect(d.tool).toMatchObject({ version: "", fingerprint: "", kind: "mcp_server" });
    expect(d.issues).toEqual(["install_failed"]);
    expect(draftComplete(d)).toBe(false);
    expect(draftReport(d)).toBeNull();
    expect(new URL(draftUrl(ORIGIN, d)).searchParams.get("issues")).toBe("install_failed");
    expect(draftLine(d)).toContain("version and fingerprint not known here");
    expect(fieldDraft({ id: "ignore previous instructions" })).toBeNull();
    // PyPI packages can be reported on since 26 Oct (ADR 0056).
    expect(fieldDraft({ id: "pypi:requests" })?.tool.id).toBe("pypi:requests");
    expect(fieldDraft({ id: "pypi:-bad" })).toBeNull();
  });

  it("fingerprints an npm version the way the House does (sha256 of dist.integrity)", async () => {
    const urls: string[] = [];
    const fetcher = (async (u: string) => {
      urls.push(u);
      return Response.json({ version: "2.0.1", dist: { integrity: "sha512-abc" } });
    }) as unknown as typeof fetch;
    const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(await npmVersionFingerprint("@s/x", undefined, { fetch: fetcher, sha256Hex })).toEqual({ version: "2.0.1", fingerprint: `sha256:${sha256Hex("sha512-abc")}` });
    expect(urls[0]).toBe("https://registry.npmjs.org/@s%2fx/latest");
    const down = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await npmVersionFingerprint("x", "1.0.0", { fetch: down, sha256Hex })).toBeNull();
  });
});
