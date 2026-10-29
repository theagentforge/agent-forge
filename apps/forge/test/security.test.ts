import { env } from "cloudflare:workers";
import { Attempt, CANARY, RULES_VERSION, rulesVersionAt, taskById, TRAP_CATALOG, type AttemptResult } from "@forge/arena";
import { SCAN_RULES, scanSkill } from "@forge/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { businessBoard } from "../src/arena/business";
import { modelName } from "../src/arena/views";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { REPLAY_V2_FROM } from "../src/services/replay-keys";
import { ADVISERS, RESEARCH_CREDITS } from "../src/web/about";
import { FAMILY_NAMES, REPORT_FACTS } from "../src/web/security";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// W1.3 (/security for the buyer, Boardy item 5) and W1.5 (/about independence, funding, advisers placeholder).

const SONNET = "claude-sonnet-5.5";
const html = { headers: { Accept: "text/html" } };

function run(fell: boolean, seed: number, rules: string | null = RULES_VERSION) {
  const a = new Attempt(taskById("scam-invoice")!, seed);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const base = a.end("finished");
  const trap = base.traps[0]!.id;
  // Stamped with the current rules, like a run the runner scores today; `null` leaves it unstamped (an older run).
  return { result: { ...base, ...(rules ? { rules } : {}), passed: !fell, traps: base.traps.map((x) => ({ ...x, triggered: fell && x.id === trap })) } as AttemptResult, log: a.log };
}

beforeAll(async () => {
  const db = getDb(env);
  const eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: "crucible-security-test", name: "Crucible security test", season: "s0", kind: "card", status: "done" });
  // Five current-rules attempts (2 falls), one embargoed, and four unstamped older-rules attempts (all falls) that
  // /security must count apart, never pool.
  const rows: [string, boolean, string | null][] = [[SONNET, true, RULES_VERSION], [SONNET, true, RULES_VERSION], [SONNET, false, RULES_VERSION], [SONNET, false, RULES_VERSION], [SONNET, false, RULES_VERSION], [EMBARGOED.id, true, RULES_VERSION], [SONNET, true, null], [SONNET, true, null], [SONNET, true, null], [SONNET, true, null]];
  let i = 0;
  for (const [model, fell, rules] of rows) {
    const seed = 2_000_001 + i++;
    const r = run(fell, seed, rules);
    const id = crypto.randomUUID();
    await db.insert(t.arenaRuns).values({
      id, eventId, modelId: model, task: "scam-invoice", seed, attemptNo: 1, status: "done", passed: r.result.passed, score: 0.5, cost: 0.5, tokens: 1000,
      result: r.result, log: r.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) }), finishedAt: Date.now() - 60_000,
    });
  }
});

describe("/security (W1.3)", () => {
  it("covers reach, the Arena, replays, the Gauntlet, pre-install checks, protections and limits", async () => {
    const res = await fetchWorker("/security", html);
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const id of ["reach", "arena", "replays", "gauntlet", "pre-install", "protection", "thirty-seconds", "limits"]) expect(body).toContain(`<h2 id="${id}">`);
    expect(body).toContain(`${SCAN_RULES.length} rules`);
    expect(body).toContain(`${TRAP_CATALOG.length} public traps`);
    expect(body).toContain(CANARY);
    for (const href of ["/benchmark", "/arena/business", "/gauntlet", "/check", "/scan", "/results-policy", "/arena/history#gap", "/arena/methodology#licence", REPORT_FACTS.census.path, REPORT_FACTS.skill_scan.path, REPORT_FACTS.grader_hacking.url])
      expect(body).toContain(`href="${href}"`);
    // Honest limits next to the claims.
    expect(body).toContain("It is not a safety guarantee");
    expect(body).toContain(`${REPORT_FACTS.skill_scan.real_patterns} were real patterns, none showing signs of malice`);
    expect(body).toContain("not yet published");
    expect(body).toMatch(/only we can check/);
    // Replay format v2 is checkable by anyone: the published keys and the verify command are named.
    expect(body).toContain('href="/.well-known/forge-keys.json"');
    expect(body).toContain("npx @theagentforge/cli@");
    expect(body).toContain("A clear scan means no known pattern matched");
    expect(body).not.toMatch(/\b(100% safe|certified|guaranteed)\b/i);
  });

  it("shows which models fell from live ranked results, never the embargoed model", async () => {
    const body = await (await fetchWorker("/security", html)).text();
    expect(body).toContain(modelName(SONNET));
    expect(body).toMatch(/<b>40%<\/b> <span class="muted">2 of 5<\/span>/);
    // Older-rules attempts are counted apart, never pooled (ADR 0068 Amendment 1).
    expect(body).toContain(`<code>${RULES_VERSION}</code>`);
    expect(body).toMatch(/4 more ranked attempts were scored under older rules \(rules 0\.\d: 4\)/);
    expect(body).toContain('href="/benchmark#results"');
    // 2 of 5: Wilson 95% is 11.8%–76.9%, shown rounded outwards as 11%–77%.
    expect(body).toContain("11%–77%");
    expect(body).toContain('href="/arena/run/');
    expect(body).not.toMatch(SHOWS_EMBARGOED);
    const b = await businessBoard(getDb(env), "all", { rules: RULES_VERSION });
    expect(b.byModel.find((m) => m.id === SONNET)?.cell).toMatchObject({ n: 5, breaks: 2, shown: true, ci: [0.117, 0.77] });
    expect(b.byModel.some((m) => m.id === EMBARGOED.id)).toBe(false);
    const older = rulesVersionAt(Date.now(), null);
    expect(b.rulesVersions).toEqual(expect.arrayContaining([{ version: RULES_VERSION, attempts: 5 }, { version: older, attempts: 4 }]));
    // Without the filter the board pools every version (the /arena/business view).
    expect((await businessBoard(getDb(env), "all")).byModel.find((m) => m.id === SONNET)?.cell).toMatchObject({ n: 9, breaks: 6 });
  });

  it("names every scanner family in plain words, no wider than its rules", async () => {
    for (const r of SCAN_RULES) expect(FAMILY_NAMES[r.family]).toBeTruthy();
    expect(Object.keys(FAMILY_NAMES).sort()).toEqual([...new Set(SCAN_RULES.map((r) => r.family))].sort());
    // The narrow families say exactly what their single rule matches: crypto to a fixed address, wiping home or root.
    expect(FAMILY_NAMES.money).toMatch(/cryptocurrency to a fixed address/);
    expect(FAMILY_NAMES.destructive).toMatch(/home or root folder/);
    // A plain money move or an ordinary delete isn't something the scanner catches, so the page mustn't imply it.
    expect((await scanSkill("Transfer $5,000 to the supplier's bank account, then delete the old invoices folder.")).verdict).toBe("clear");
    expect(Object.values(FAMILY_NAMES).join(" ")).not.toMatch(/\b(move money|delete files|any data)\b/i);
  });

  it("states the launch scan's numbers as the report gives them", async () => {
    const body = await (await fetchWorker("/security", html)).text();
    const f = REPORT_FACTS.skill_scan;
    expect(f).toMatchObject({ skills: 9_930, ordinary_skills: 9_014, flagged_ordinary: 30, real_patterns: 26, rules_version: "2026-10-19.3" });
    expect(body).toContain(`of the 9,014 ordinary ones`);
    expect(body).toContain(`30 were flagged with a high-risk pattern`);
    expect(body).toContain(`rules <code>2026-10-19.3</code>`);
    expect(body).not.toContain("high-risk matches");
  });

  it("has a structured JSON twin with no instructions and no embargoed model", async () => {
    const res = await fetchWorker("/security?format=json");
    const text = await res.text();
    type D = {
      arena: { rules_version: string; attempts_under_older_rules: { rules_version: string; attempts: number }[]; by_model: { id: string; attempts: number; ci_95: [number, number] }[] };
      pre_install: { scan_rules: number; clear_scan_means: string; scan_runs_code: boolean };
      protections: { replay_formats: { format: number; third_party_verifiable: boolean; runs_from?: string; runs_before?: string }[]; held_out_seeds_published: boolean; referee_human_agreement: { status: string }; contamination_effect: { status: string } };
    };
    const d = JSON.parse(text) as D;
    expect(d.pre_install).toMatchObject({ scan_rules: SCAN_RULES.length, clear_scan_means: "no_known_pattern_matched", scan_runs_code: false });
    expect(d.protections).toMatchObject({ held_out_seeds_published: false, referee_human_agreement: { status: "not_yet_published" } });
    expect(["not_yet_measured", "not_yet_established", "established"]).toContain(d.protections.contamination_effect.status);
    expect(d.protections.replay_formats).toEqual([
      expect.objectContaining({ format: 2, third_party_verifiable: true, runs_from: REPLAY_V2_FROM }),
      expect.objectContaining({ format: 1, third_party_verifiable: false, runs_before: REPLAY_V2_FROM }),
    ]);
    expect(d.arena.rules_version).toBe(RULES_VERSION);
    expect(d.arena.attempts_under_older_rules.reduce((n, v) => n + v.attempts, 0)).toBeGreaterThanOrEqual(4);
    expect(d.arena.by_model.find((m) => m.id === SONNET)).toMatchObject({ attempts: 5, ci_95: [0.117, 0.77] });
    expect(text).not.toMatch(SHOWS_EMBARGOED);
    expect(text).not.toMatch(AGENT_DIRECTED);
  });

  it("is linked from the footer, the home page's who-this-is-for line, /about, the sitemap and llms.txt", async () => {
    const home = await (await fetchWorker("/", html)).text();
    expect(home).toContain("Who this is for:");
    expect(home).toMatch(/<a href="\/security">For security teams<\/a>/);
    expect(home).toContain('<a href="/security">Security</a>');
    const about = await (await fetchWorker("/about", html)).text();
    expect(about).toContain('href="/security"');
    expect(await (await fetchWorker("/sitemap.xml")).text()).toContain("/security</loc>");
    expect(await (await fetchWorker("/llms.txt")).text()).toContain("(/security)");
  });
});

describe("/about additions (W1.5)", () => {
  it("states independence consistent with the results policy, and the funding", async () => {
    const body = await (await fetchWorker("/about", html)).text();
    expect(body).toContain('<h2 id="independence">');
    expect(body).toContain("independent of every vendor it scores");
    expect(body).toContain("pays for placement");
    expect(body).toContain('href="/results-policy#independence"');
    const policy = (await (await fetchWorker("/results-policy?format=json")).json()) as { independence: { paid_placement: boolean } };
    expect(policy.independence.paid_placement).toBe(false);
    expect(body).toContain('<h2 id="funding">');
    expect(body).toContain("self-funded");
    expect(body).toContain("paid Claude Max subscription");
    expect(body).toContain("one-off allowance of Anthropic API credits");
    expect(body).toContain("expires on 16 Nov 2026");
    expect(body).toContain("not a grant or sponsorship");
    expect(body).toContain("Cloudflare Workers AI");
    // The signed-logs line matches when replay format v2 began.
    expect(REPLAY_V2_FROM).toBe("2026-10-28");
    expect(body).toContain("Bouts from 28 Oct 2026 use replay format v2");
    expect(body).toContain("prepaid OpenRouter credit");
    expect(body).toContain("No lab, model maker or tool publisher funds, sponsors or commissions the Forge.");
    expect(body).not.toMatch(/monthly API credits|\bhis\b/);
    expect(body).toContain("Research credits, if granted, will be disclosed here.");
    expect(body).not.toMatch(SHOWS_EMBARGOED);
  });

  it("renders no advisers section and no board while no advisers are named", async () => {
    expect(ADVISERS).toEqual([]);
    expect(RESEARCH_CREDITS).toEqual([]);
    const body = await (await fetchWorker("/about", html)).text();
    expect(body).not.toContain('id="advisers"');
    expect(body).not.toMatch(/advis[eo]rs?\b/i);
    expect(body).not.toMatch(/\bboard of\b|governance board/i);
  });
});
