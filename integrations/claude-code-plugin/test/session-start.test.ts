import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkKey, checkMemo, emptyMemory, trapCardText } from "@forge/shared/light";
import { sha256Hex } from "../src/hooks/common";
import { findSkills, sessionContext, weeklyPass } from "../src/hooks/session-start";
import { AGENT_DIRECTED } from "../../../apps/forge/test/wording";

describe("SessionStart trap card (ADR 0017)", () => {
  it("adds the same generic card as the website, labelled as the user's own checks", () => {
    const ctx = sessionContext();
    expect(ctx).toContain(trapCardText());
    expect(ctx).toMatch(/^The Agent Forge plugin: the user's trap card \(v\d+\.\d+\)/);
    expect(ctx).not.toMatch(/https?:\/\//);
  });
});

const ORIGIN = "https://theagentforge.io";
const NOW = Date.parse("2026-10-26T09:00:00Z");
const SKILL = "---\nname: pdf\n---\nRead PDFs.\n";
const FP = `sha256:${sha256Hex(SKILL)}`;

function forge(opts: { watch?: unknown; check?: unknown; down?: boolean } = {}) {
  const calls: { url: string; body?: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (opts.down) throw new Error("offline");
    if (url.endsWith("/api/v1/watch")) return Response.json(opts.watch);
    return Response.json(opts.check);
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("weekly check (forge_watch's REST twin, plus re-checks)", () => {
  const watch = {
    rules_version: "2026-10-23.1",
    items: [{ fingerprint: FP, known: true, verdict: "caution", rules_version: "2026-10-20.1", rescan_needed: true, versions_with_reports: 1 }],
  };

  it("sends only fingerprints and tool ids, and says what changed since last week", async () => {
    const memory = emptyMemory();
    memory.rules = "2026-10-20.1";
    memory.weekly_at = "2026-10-18T09:00:00Z";
    memory.watch[FP] = { at: "2026-10-18T09:00:00Z", verdict: "clear", rules: "2026-10-20.1", rescan: false, versions_with_reports: 0 };
    memory.checks[checkKey("npm:x", "1.0.0")] = checkMemo({ version: "1.0.0", forge_score: null, security_status: "clear", reports_for_this_version: 1, outcome_breakdown: { worked: 1, partial: 0, failed: 0 } }, "2026-10-18T09:00:00Z");
    const check = { known: true, tool: { id: "npm:x" }, version: "1.0.0", forge_score: null, security_status: "clear", reports_for_this_version: 3, outcome_breakdown: { worked: 2, partial: 0, failed: 1 }, share: { receipt_url: `${ORIGIN}/r/tok.sig` } };
    const { f, calls } = forge({ watch, check });
    const lines = (await weeklyPass({ origin: ORIGIN, fetch: f, now: NOW, memory, skills: [{ label: "pdf", text: SKILL }] }))!;
    expect(calls[0]).toEqual({ url: `${ORIGIN}/api/v1/watch`, body: JSON.stringify({ fingerprints: [FP] }) });
    expect(calls[1]!.url).toBe(`${ORIGIN}/api/v1/check?id=npm%3Ax&version=1.0.0`);
    expect(calls.map((c) => c.body ?? "").join("")).not.toContain("pdf");
    expect(lines).toEqual([
      "Forge weekly check: 1 skill, 0 flagged, 1 caution, 1 changed, 1 need a fresh scan; scan rules 2026-10-20.1 → 2026-10-23.1",
      `  pdf (${FP.slice(0, 19)}…): scan caution; needs a fresh scan (rules 2026-10-23.1); scan clear → caution since 2026-10-18; 1 new reported version since 2026-10-18`,
      "Forge weekly re-check: 1 recently checked tool, 1 changed",
      "  npm:x@1.0.0: since last check (2026-10-18): 2 new field reports (1 worked, 1 failed)",
      `  receipt: ${ORIGIN}/r/tok.sig`,
    ]);
    expect(lines.join("\n")).not.toMatch(AGENT_DIRECTED);
    expect(memory).toMatchObject({ weekly_at: new Date(NOW).toISOString(), rules: "2026-10-23.1" });
    expect(memory.checks["npm:x@1.0.0"]!.reports).toBe(3);
  });

  it("runs once a week, and tries again next session when the Forge can't be reached", async () => {
    const memory = { ...emptyMemory(), weekly_at: "2026-10-24T09:00:00Z" };
    const { f, calls } = forge({ watch });
    expect(await weeklyPass({ origin: ORIGIN, fetch: f, now: NOW, memory, skills: [{ label: "pdf", text: SKILL }] })).toBeNull();
    expect(calls).toHaveLength(0);
    const due = emptyMemory();
    expect(await weeklyPass({ origin: ORIGIN, fetch: forge({ down: true }).f, now: NOW, memory: due, skills: [{ label: "pdf", text: SKILL }] })).toBeNull();
    expect(due.weekly_at).toBeUndefined();
  });

  it("finds SKILL.md files in skill folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-skills-"));
    mkdirSync(join(dir, "pdf"));
    writeFileSync(join(dir, "pdf", "SKILL.md"), SKILL);
    mkdirSync(join(dir, "empty"));
    expect(findSkills([dir, join(dir, "missing")])).toEqual([{ label: "pdf", text: SKILL }]);
  });
});
