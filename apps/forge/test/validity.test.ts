import { env } from "cloudflare:workers";
import { anyTaskById, Attempt, CANARY, RULES_VERSION, type AttemptResult } from "@forge/arena";
import type { AuditResult } from "@forge/arena/audit";
import { beforeAll, describe, expect, it } from "vitest";
import { CORRECTIONS } from "../src/arena/corrections";
import { disagreementStatuses, errorRecord, nextTrapSetMinor, REFEREE_AUDIT, trapHistory, validityGate } from "../src/arena/error-record";
import { TRAP_SET } from "../src/arena/benchmark";
import { disagreementsCsv, headlines, pooledGap, validityData } from "../src/arena/validity";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

// Everything here is the released pack (VALIDITY_PUBLIC on); test/validity-release.test.ts covers the switch itself.
const RELEASED = { ...env, VALIDITY_PUBLIC: "on" } as Env;
async function fetchWorker(path: string, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, init) as never, RELEASED, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// The validity pack (ADR 0136): /benchmark/validity, its files, the error record and its publish gate, and the
// per-trap history on each trap page.

const ORIGIN = "https://theagentforge.io";
const MODEL = "gpt-oss-120b";

async function seedRun(eventId: string, model: string, task: string, seed: number, opts: { heldOut?: boolean; passed?: boolean; rescored?: unknown } = {}) {
  const a = new Attempt(anyTaskById(task)!, seed);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const passed = opts.passed ?? true;
  const result = { ...base, rules: RULES_VERSION, passed, ...(opts.rescored ? { rescored: opts.rescored } : {}) } as AttemptResult;
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task, seed, attemptNo: 1, status: "done", passed, score: 0.5, cost: 0.01, tokens: 1000, heldOut: opts.heldOut ?? false,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(a.log) }), finishedAt: Date.now() - 60_000,
  });
  return id;
}

let rescoredId = "";
beforeAll(async () => {
  const db = getDb(env);
  const ev = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: ev, slug: "validity-test-event", name: "Validity test", season: "s0", kind: "card", status: "done" });
  for (let i = 0; i < 12; i++) {
    await seedRun(ev, MODEL, "refund", 2_000_000 + i);
    await seedRun(ev, MODEL, "refund", 3_000_000 + i, { heldOut: true });
  }
  const ev2 = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: ev2, slug: "validity-test-event-2", name: "Validity test 2", season: "s0", kind: "card", status: "done" });
  rescoredId = await seedRun(ev2, MODEL, "impossible-hard", 4_000_001, { passed: false, rescored: { rules: "rules 0.5", at: "2026-10-25T01:20:43.566Z", before: { passed: true, reason: "finished" }, flips: ["trap:false_claim"] } });
  await seedRun(ev, EMBARGOED.id, "refund", 2_000_000);
  await db.insert(t.disputes).values({ id: crypto.randomUUID(), reason: "spam", state: "rejected" });
});

describe("the publish gate", () => {
  it("passes the frozen audit 1 (complete, every disagreement resolved)", () => {
    expect(validityGate(REFEREE_AUDIT)).toEqual({ ok: true });
  });
  it("refuses no audit, an empty audit and an audit with an unresolved disagreement", () => {
    expect(validityGate(null)).toMatchObject({ ok: false, why: "no_referee_audit" });
    expect(validityGate({ ...REFEREE_AUDIT, overall: { ...REFEREE_AUDIT.overall, n: 0 } } as AuditResult)).toMatchObject({ ok: false });
    const unresolved = { ...REFEREE_AUDIT, disagreements: REFEREE_AUDIT.disagreements.map((d, i) => (i === 0 ? { ...d, resolution: null } : d)) } as AuditResult;
    expect(validityGate(unresolved)).toMatchObject({ ok: false, why: "referee_audit_has_unresolved_disagreements" });
  });
  it("without the audit, validityData carries no error record and no audit figures", async () => {
    for (const a of [null, { ...REFEREE_AUDIT, disagreements: [{ ...REFEREE_AUDIT.disagreements[0]!, resolution: null }] } as AuditResult]) {
      const d = await validityData(getDb(env), ORIGIN, a);
      expect(d.status).toBe("withheld");
      expect(JSON.stringify(d)).not.toMatch(/error_record"|entries|referee_audit"\s*:\s*\{/);
    }
  });
});

describe("/benchmark/validity", () => {
  let data: any;
  beforeAll(async () => {
    data = await (await fetchWorker("/benchmark/validity.json")).json();
  });

  it("serves the page with the audit's headline sentences, every figure from the audit file", async () => {
    const res = await fetchWorker("/benchmark/validity");
    expect(res.status).toBe(200);
    const page = await res.text();
    for (const h of headlines(REFEREE_AUDIT)) expect(page).toContain(h.slice(0, 60));
    expect(page).toContain(`${REFEREE_AUDIT.overall.agree} of ${REFEREE_AUDIT.overall.n}`);
    expect(page).toContain("pnpm forge:reproduce &lt;run-id&gt;");
    expect(page).toContain(CANARY);
    for (const d of REFEREE_AUDIT.disagreements) expect(page).toContain(d.replay_url);
    expect(page).not.toMatch(SHOWS_EMBARGOED);
  });

  it("shows the error record only beside the audit's agreement rate and sample size", async () => {
    expect(data.status).toBe("published");
    expect(data.error_record.shown_with).toEqual({ audit_id: "referee-audit-1", agreement: REFEREE_AUDIT.overall.agreement, n: REFEREE_AUDIT.overall.n, sample_runs: REFEREE_AUDIT.sample.runs });
    expect(data.referee_audit.overall.n).toBe(REFEREE_AUDIT.overall.n);
    const kinds = new Set(data.error_record.entries.map((e: any) => e.kind));
    for (const k of ["rules_change", "rescore_applied", "task_version", "audit_disagreement", "reproduce_difference", "disputes"]) expect(kinds.has(k), k).toBe(true);
    // The rules 0.7 correction was published on 6 Nov, so no re-score is pending any more.
    expect(CORRECTIONS.filter((c) => !c.published)).toEqual([]);
    expect(kinds.has("rescore_pending"), "rescore_pending").toBe(false);
    // Dated, newest first.
    const dates = data.error_record.entries.map((e: any) => e.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    // An unpublished correction (a constructed draft) is listed as pending, never as applied.
    const draft = { ...CORRECTIONS[0]!, id: "test-draft", rules: "rules 0.8", date: "2026-11-30", published: false, applied: false, counts: null };
    CORRECTIONS.push(draft);
    try {
      const pending = (await errorRecord(getDb(env), ORIGIN)).entries.filter((e) => e.kind === "rescore_pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ date: "2026-11-30", title: "Re-score under rules 0.8 not yet applied", status: "pending", runs: [] });
      // The version it lands in is the next minor after the newest Trap Set version (1.2 today), never a typed-in one.
      expect(TRAP_SET.version).toBe("1.2");
      expect(nextTrapSetMinor()).toBe("1.3");
      expect(pending[0]!.what).toContain("It is to be applied with the next Trap Set version (1.3), with its counts published then.");
      expect(pending[0]!.what).not.toContain("(1.2)");
    } finally {
      CORRECTIONS.splice(CORRECTIONS.indexOf(draft), 1);
    }
  });

  it("counts applied re-scores and disputes from the database", () => {
    const applied = data.error_record.entries.find((e: any) => e.kind === "rescore_applied");
    expect(applied.what).toMatch(/1 published ranked run carry a rules 0.5 re-score note; 1 changed verdict \(1 pass to fail, 0 fail to pass\)/);
    expect(applied.runs).toContain(`${ORIGIN}/arena/run/${rescoredId}`);
    expect(data.error_record.disputes).toMatchObject({ rejected: 1, about_traps_or_arena_verdicts: 0 });
  });

  it("compares public and held-out seeds with intervals, and says when both sides are at ceiling", () => {
    const k = data.contamination.public_vs_held_out.pooled_ranked_events;
    expect(k.public).toMatchObject({ attempts: 12, passes: 12 });
    expect(k.held_out).toMatchObject({ attempts: 12, passes: 12 });
    expect(k.at_ceiling).toBe(true);
    expect(k.difference_ci_95[0]).toBeLessThan(0);
    expect(data.contamination.answer_key_scan).toEqual(REFEREE_AUDIT.answer_key_scan);
    expect(pooledGap([])).toMatchObject({ reading: "not_yet_measured", difference: null });
  });

  it("reports model variance from the 3-of-3 data, never claiming identical results", () => {
    expect(data.reproducibility.command).toBe("pnpm forge:reproduce <run-id>");
    expect(data.reproducibility.model_variance.statement).toMatch(/does not reproduce the model/);
    expect(data.reproducibility.model_variance.three_of_three).toHaveProperty("groups");
    expect(data.reproducibility.audit_sample).toEqual(REFEREE_AUDIT.reproduce_check);
  });

  it("serves the downloadable files", async () => {
    const audit = await fetchWorker("/benchmark/validity/referee-audit-1.json");
    expect(audit.status).toBe(200);
    expect(await audit.text()).toBe(`${JSON.stringify(REFEREE_AUDIT, null, 1)}\n`);
    for (const p of ["/benchmark/validity/referee-audit-1-per-trap.csv", "/benchmark/validity/referee-audit-1-disagreements.csv", "/benchmark/validity/error-record.csv"]) {
      const res = await fetchWorker(p);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("Content-Type"), p).toContain("text/csv");
      expect((await res.text()).split("\n").length, p).toBeGreaterThan(2);
    }
    const rec = await (await fetchWorker("/benchmark/validity/error-record.json")).json<any>();
    expect(rec.shown_with.n).toBe(REFEREE_AUDIT.overall.n);
    expect(rec.entries.length).toBeGreaterThan(5);
  });

  it("is linked from /benchmark", async () => {
    expect(await (await fetchWorker("/benchmark")).text()).toContain('href="/benchmark/validity"');
  });
});

describe("audit 1's disagreements: frozen figures, today's status", () => {
  const CORRECTION = "2026-11-rules-0.7-payee-claims";
  const HEADLINE_2 =
    "Every one of the 4 disagreements in that audit was read in its log: in 4 the published verdict was wrong, and in 0 the checker was wrong. All 4 are now fixed (2 by rules 0.6, 2 by rules 0.7) and their published verdicts were re-scored from the signed logs on 6 Nov 2026 (correction 2026-11-rules-0.7-payee-claims).";
  const decode = (x: string) => x.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("keeps the audit's own figures as frozen and dates them", () => {
    expect(REFEREE_AUDIT.overall).toMatchObject({ agree: 530, n: 534 });
    expect(REFEREE_AUDIT.adjudicated).toMatchObject({ referee_wrong_open: 2, referee_wrong_fixed_later: 2, checker_wrong: 0 });
    const [h1, h2] = headlines(REFEREE_AUDIT);
    expect(h1).toMatch(/^At the time of the audit \(5 Nov 2026\), an independent checker agreed with the published referee verdict on 530 of 534 trap verdicts/);
    expect(h2).toBe(HEADLINE_2);
  });

  it("reads each disagreement's status today from the adjudications and the published correction", () => {
    const st = disagreementStatuses();
    const by = Object.fromEntries(st.map((s) => [s.run.slice(0, 8), s]));
    expect(Object.keys(by).sort()).toEqual(["026e2a39", "23f12299", "372c1900", "67336c42"]);
    for (const s of st) {
      expect(s.status_now, s.run).toBe("fixed_and_rescored");
      expect(s.rescored, s.run).toEqual({ correction: CORRECTION, rules: "rules 0.7", date: "2026-11-06" });
    }
    expect([by["23f12299"]!.fixed_by, by["372c1900"]!.fixed_by, by["026e2a39"]!.fixed_by, by["67336c42"]!.fixed_by]).toEqual(["rules 0.7", "rules 0.7", "rules 0.6", "rules 0.6"]);
    // At the audit (frozen): two open, two fixed in later rules.
    expect([by["23f12299"]!.outcome_at_audit, by["372c1900"]!.outcome_at_audit, by["026e2a39"]!.outcome_at_audit]).toEqual(["referee_wrong_open", "referee_wrong_open", "referee_wrong_fixed_later"]);
    for (const s of st) expect(s.note_now, s.run).not.toMatch(/Open:|still shows the old one|waits for/);
  });

  it("without the published correction, says not yet re-scored and still open, as at the audit", () => {
    const st = disagreementStatuses(REFEREE_AUDIT, undefined, []);
    expect(st.map((s) => s.status_now).sort()).toEqual(["fixed_in_later_rules", "fixed_in_later_rules", "fixed_in_later_rules", "fixed_in_later_rules"]);
    const before = disagreementStatuses(REFEREE_AUDIT, REFEREE_AUDIT.disagreements.map((d) => d.resolution!), []);
    expect(headlines(REFEREE_AUDIT, undefined, before)[1]).toBe(
      "Every one of the 4 disagreements in that audit was read in its log: in 4 the published verdict was wrong, and in 0 the checker was wrong. 2 are fixed in later referee rules but not yet re-scored. 2 are still open.",
    );
  });

  it("the error record, the JSON, the CSV and the page all give today's status", async () => {
    const { entries } = await errorRecord(getDb(env), ORIGIN);
    const dis = entries.filter((e) => e.kind === "audit_disagreement");
    expect(dis).toHaveLength(4);
    for (const e of dis) {
      expect(e.status).toBe("fixed_and_rescored");
      expect(e.date).toBe("2026-11-05");
      expect(e.what).toContain(`re-scored from the signed log on 6 Nov 2026 (correction ${CORRECTION})`);
      expect(e.what).not.toMatch(/Open: to be fixed|still read so under rules 0\.6\. Open|still shows the old one|waits for/);
    }
    expect(dis.filter((e) => e.what.includes("At the audit (5 Nov 2026) it was referee wrong open.")).length).toBe(2);
    const data = await (await fetchWorker("/benchmark/validity.json")).json<any>();
    expect(data.headlines[1]).toBe(HEADLINE_2);
    // The JSON keeps the frozen resolutions (free-text notes are left out of JSON, as everywhere).
    expect(data.referee_audit.disagreements.map((x: any) => x.resolution.outcome)).toEqual(REFEREE_AUDIT.disagreements.map((x) => x.resolution!.outcome));
    expect(data.referee_audit.disagreements_now.map((x: any) => x.status_now)).toEqual(["fixed_and_rescored", "fixed_and_rescored", "fixed_and_rescored", "fixed_and_rescored"]);
    const csv = disagreementsCsv(REFEREE_AUDIT).trim().split("\n");
    expect(csv[0]).toContain("outcome_at_audit,note_at_audit,status_now,fixed_by,rescored_on,correction,note_now");
    expect(csv.slice(1).every((r) => r.includes(`fixed_and_rescored,rules 0.`) && r.includes(`2026-11-06,${CORRECTION}`))).toBe(true);
    const page = decode(await (await fetchWorker("/benchmark/validity")).text());
    expect(page).toContain(HEADLINE_2);
    expect(page).toContain("At the time of the audit (5 Nov 2026)");
    expect(page).not.toContain("not yet re-scored");
    expect(page).not.toMatch(SHOWS_EMBARGOED);
    expect(page).not.toMatch(/\bsafe\b/i);
  });
});

describe("per-trap history", () => {
  it("FA-CLM-001's page shows its corrections and its audit line", async () => {
    const page = await (await fetchWorker("/arena/failures/FA-CLM-001")).text();
    expect(page).toContain("Dispute and correction history");
    const row = REFEREE_AUDIT.per_public_trap.find((r) => r.public_trap_id === "FA-CLM-001")!;
    expect(page).toContain(`agreed with the published verdict on ${row.agree} of ${row.n} sampled verdicts`);
    const json = await (await fetchWorker("/arena/failures/FA-CLM-001?format=json")).json<any>();
    expect(json.history.audit.verdicts_checked).toBe(row.n);
    expect(json.history.entries.some((e: any) => e.kind === "audit_disagreement")).toBe(true);
    expect(json.history.disputes_about_this_trap).toBe(0);
  });

  it("a trap with no correction says so", async () => {
    const { entries } = await errorRecord(getDb(env), ORIGIN);
    expect(trapHistory(entries, "FA-POL-013").entries.filter((e) => e.kind === "audit_disagreement")).toEqual([]);
  });
});
