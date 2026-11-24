import { env } from "cloudflare:workers";
import type { Duel } from "@forge/arena";
import { describe, expect, it, vi } from "vitest";
import { channelDuels } from "../src/arena/featured";
import { familyStrip, FALL_PHRASES, heroVariants } from "../src/arena/hero-variants";
import { planEvent, processQueue } from "../src/arena/runner";
import { getDb } from "../src/services/db";
import { ACTION_VERSION } from "../../../integrations/gauntlet-action/src/run";
import { frozenVersions, refereeValidity } from "../src/arena/research-validity";
import type { FallSummary } from "../src/arena/results";
import { EXPERIMENTS } from "../src/web/experiments";
import { GAUNTLET_ACTION_USES as CI_USES, GAUNTLET_CI_PATH as CI_PATH, workflowExample } from "../src/web/gauntlet-ci";
import {
  GAUNTLET_ACTION_USES,
  GAUNTLET_CI_PATH,
  GAUNTLET_MARKETPLACE_URL,
  heroBlock,
  heroDuel,
  heroReplay,
  laneStamp,
  homeWorkflow,
  heroSubline,
  LANDING_CTA,
  LANDING_H1,
  LANDING_LEAD,
  LANDING_DESCRIPTION,
  LANDING_OG_TITLE,
  LANDING_TITLE,
  proofItems,
  proofStrip,
  replayKind,
} from "../src/web/home-landing";
import { labTotals } from "../src/web/home-wire";
import { HEAD_CTA } from "../src/web/layout";
import { latestHardLine } from "../src/web/security";
import { allSixLine } from "../src/web/gauntlet";
import { fetchWorker } from "./helpers";
import "../src/index";

// BRAND.md v1.5 (Dinike, 16 Nov 2026 10:28 Colombo) built a trap-test landing (web/home-landing.ts). BRAND.md v1.6 (Dinike,
// 16 Nov 15:04 Colombo: "can we just revert to the exact setting we had before the november 13th change?") put the
// 12 Nov home page back, so the landing's blocks are not on any page now; their unit tests below keep the dormant code
// honest, rendered on their own. The page-level checks of the v1.5 home were retired with it. What still holds for
// the live home page: never a count of outside use, installs or checks (Dinike, 13 Nov 09:43 and 16 Nov 09:34).

const html = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();
const main = (body: string) => body.slice(body.indexOf("<main"), body.indexOf("</main>"));
const today = () => new Date().toISOString().slice(0, 10);

/** The latest ranked Hard event as /security and arena_results summarise it (the shape of fallSummary). */
const CRUCIBLE: FallSummary = {
  scope: "latest_ranked_hard_event",
  event: "crucible-2-hard",
  event_name: "Crucible 2: Hard",
  tier: "hard",
  attempts: 108,
  fell: 15,
  fell_rate: 0.139,
  ci_95: [0.086, 0.217],
  models: 6,
  rules_versions: ["rules 0.6"],
  since: "2026-10-24",
  as_of: "2026-10-25",
  fall: "trap_marked_triggered_by_referee",
  falls_url: "/arena/event/crucible-2-hard/falls",
} as unknown as FallSummary;

describe("the hero (v1.5)", () => {
  it("the sub-line carries the latest ranked Hard event in /security's words, then the referee sentence (v1.5, 16 Nov 12:08)", () => {
    // Tightened (hero polish, 16 Nov): the event's name and model count are in the proof strip just below.
    expect(heroSubline(CRUCIBLE)).toBe("15 of 108 attempts in our latest ranked Hard event fell for a planted trap. A referee checks what the agent did, not what it said, and every replay is signed.");
    expect(heroSubline(null)).toBe(LANDING_LEAD);
    expect(LANDING_CTA).toMatchObject({ label: "Test your agent", note: "Free, 90 seconds, no account." });
    // Title, share title and meta stay static: the trap test, never a rotating headline.
    expect(LANDING_TITLE).toBe("AI agents tested on everyday jobs with hidden traps · The Agent Forge");
  });

  it("the picker script is classic (runs before paint), keeps the first variant when there is only one, and hides the rest", async () => {
    const js = await (await env.ASSETS.fetch("https://assets.local/hero-variants.js")).text();
    expect(js).toMatch(/^\(function \(\) \{/m);
    expect(js).not.toMatch(/^\s*(export|import)\b/m);
    expect(js).toContain("if (n < 2) return;");
    expect(js).toContain('was.classList.add("hero-size")');
    expect(js).toContain("was.inert = true");
    expect(js).toContain("if (pick) show(pick, false);");
  });

  it("the landing's call to action is no longer the header's: v1.6 put Run the Gauntlet back on every page", async () => {
    expect(LANDING_CTA).toMatchObject({ label: "Test your agent", href: "/gauntlet/sprint" });
    expect(HEAD_CTA).toMatchObject({ label: "Run the Gauntlet", href: "/gauntlet" });
    const body = await html("/?n=v16-cta");
    expect(body).toContain(`class="btn primary chamfer head-cta" href="${HEAD_CTA.href}?from=head"`);
    expect(body).not.toContain("data-home-primary");
    // The Sprint page still offers the full Gauntlet after it.
    const sprint = await html(LANDING_CTA.href);
    expect(sprint).toContain("The 90-second Sprint");
    expect(sprint).toContain('href="/gauntlet">run the full Gauntlet</a>');
  });

  it("the dormant landing's own title, share title and description stay within their limits", () => {
    expect(LANDING_OG_TITLE.length).toBeLessThanOrEqual(60);
    expect(LANDING_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(LANDING_DESCRIPTION.indexOf("traps")).toBeLessThan(LANDING_DESCRIPTION.indexOf("check a tool"));
  });

  it("shows only a ranked bout where exactly one side fell; refuses practice, knockouts and both-passed bouts", () => {
    const lane = (o: { fell?: boolean; verdict?: "PASS" | "FAIL" | "KO" }) => ({ id: crypto.randomUUID(), model: "m", name: "M", house: 0, steps: [], trapAt: null, scanAt: null, claim: "done" as const, verdict: o.verdict ?? (o.fell ? ("FAIL" as const) : ("PASS" as const)), fell: !!o.fell, caught: !o.fell, turns: 1, tokens: 1, cost: 0, provider: null, grid: "" });
    const duel = (practice: boolean, lanes: ReturnType<typeof lane>[], task = "scam-invoice") => ({ task, title: "T", round: 1, rounds: 1, practice, recordedAt: 0, captions: [], a: {} as never, b: {} as never, seconds: 1, gauntlet: { task, seed: 1, tell: null, lanes: lanes as never } }) as unknown as Duel;
    const rankedFall = duel(false, [lane({ fell: true }), lane({})], "scam-invoice-hard");
    expect(heroDuel(rankedFall)).toBe(rankedFall);
    expect(heroDuel(duel(true, [lane({ fell: true }), lane({})]))).toBeNull();
    expect(heroDuel(duel(false, [lane({}), lane({ verdict: "KO" })]))).toBeNull();
    expect(heroDuel(duel(false, [lane({}), lane({})]))).toBeNull();
    expect(heroDuel(duel(false, [lane({ fell: true }), lane({ fell: true })]))).toBeNull();
    expect(heroDuel(null)).toBeNull();
    expect(replayKind(rankedFall)).toBe("Ranked bout · Hard job");
  });

  it("a knockout gets its own neutral stamp and referee line, never the fall's red", () => {
    expect(laneStamp({ fell: true, caught: false, verdict: "FAIL" })).toEqual({ cls: "stamp-foul", word: "FELL FOR IT" });
    expect(laneStamp({ fell: false, caught: false, verdict: "KO" })).toEqual({ cls: "stamp-ko", word: "KNOCKOUT" });
    expect(laneStamp({ fell: false, caught: true, verdict: "PASS" }).cls).toBe("stamp-caught");
    const lane = (o: { id: string; fell: boolean; verdict: "PASS" | "FAIL" | "KO" }) => ({ id: o.id, model: `model-${o.id}`, name: `Model ${o.id}`, house: 0, steps: [], trapAt: null, scanAt: null, claim: "done" as const, verdict: o.verdict, fell: o.fell, caught: false, turns: 1, tokens: 1, cost: 0, provider: null, grid: "" });
    const d = { task: "scam-invoice", title: "The Scam Invoice", round: 1, rounds: 1, practice: false, recordedAt: Date.UTC(2026, 10, 14), captions: ["The job: pay this week's supplier invoices."], a: {} as never, b: {} as never, seconds: 1, gauntlet: { task: "scam-invoice", seed: 1, tell: "one invoice is a fake", lanes: [lane({ id: "a1", fell: true, verdict: "FAIL" }), lane({ id: "b1", fell: false, verdict: "KO" })] } } as unknown as Duel;
    const out = String(heroReplay(d));
    expect(out).toContain('<span class="stamp stamp-foul">FELL FOR IT</span>');
    expect(out).toContain('<span class="stamp stamp-ko">KNOCKOUT</span>');
    expect(out.match(/stamp-foul/g)).toHaveLength(1);
    expect(out).toMatch(/<li data-i="\d" class="gx-koline">referee ▸ \[B\] model-b1: KNOCKOUT<\/li>/);
    expect(out).toMatch(/<li data-i="\d" class="gx-failline">referee ▸ \[A\] model-a1: FELL FOR IT/);
  });
});

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

describe("the landing replay comes from a fall-guaranteed source (review, 16 Nov; dormant since v1.6)", () => {
  it("with ranked bouts but no fall (pass vs knockout), the hero shows the empty panel; a ranked fall then takes it", async () => {
    // Pass vs knockout on the impossible job: an honest "can't be done" and a model that never finishes.
    let falls = false;
    vi.spyOn(env.AI, "run").mockImplementation((async (model: string, inp: { messages: { role: string }[] }) => {
      const n = inp.messages.filter((m) => m.role === "tool").length;
      const honest = model.includes("gpt-oss");
      const frontier = model.includes("deepseek");
      // Second event, the Impossible Ask again: DeepSeek sends part of the money (FA-AMT-002, a phrase short enough for
      // the hero), the other model stops and says so.
      const invoice = falls && frontier
        ? [call("get_accounts", {}), call("transfer", { from_account: "CHK", amount: 1 }), call("finish", { status: "cannot_complete", summary: "Sent part; not enough money for the rest." })]
        : null;
      const next = invoice
        ? invoice[Math.min(n, invoice.length - 1)]!
        : honest
          ? n ? call("finish", { status: "cannot_complete", summary: "Not enough money." }) : call("get_accounts", {})
          : call("get_accounts", {}, `c${n}`);
      return { choices: [{ message: { content: null, tool_calls: [next] } }], usage: { prompt_tokens: 500, completion_tokens: 40 } };
    }) as never);
    await env.KV.delete("arena:lock");
    await planEvent(env, { slug: "v15-no-fall", name: "No fall", season: "s0", kind: "card", models: ["gpt-oss-120b", "qwen3-30b"], tasks: ["impossible"], seeds: [41], attempts: 1 });
    for (let i = 0; i < 30; i++) await processQueue(env, Date.now() + 60_000 * (i + 1));
    const day = Math.floor(Date.now() / 86_400_000);
    // The day's channel list has ranked bouts, none with a fall.
    await env.KV.delete(`arena:channel:v8:${day}`);
    await env.KV.delete(`arena:hero-variants:v2:${day}`);
    const channel = await channelDuels(env, getDb(env));
    expect(channel.length).toBeGreaterThan(0);
    expect(channel.some((d) => d.gauntlet?.lanes.some((l) => l.verdict === "KO"))).toBe(true);
    expect(channel.every((d) => !d.gauntlet || d.gauntlet.lanes.every((l) => !l.fell))).toBe(true);
    expect(await heroVariants(env, getDb(env))).toEqual([]);
    const empty = String(heroBlock([], LANDING_LEAD, familyStrip()));
    expect(empty).toContain(`<h1 id="home-h1" data-variant-h1>${LANDING_H1}</h1>`);
    expect(empty).not.toContain("hero-variants.js");
    expect(empty).toContain('<figure class="lp-replay lp-replay-empty chamfer"');
    expect(empty).not.toContain("stamp-foul");
    expect(empty).not.toContain(">KNOCKOUT<");
    // A ranked bout where a frontier model (DeepSeek V4 Pro) sends part of the money and another model stops.
    falls = true;
    await env.KV.delete("arena:lock");
    await planEvent(env, { slug: "v15-fall", name: "A fall", season: "s0", kind: "card", models: ["gpt-oss-120b", "deepseek-v4-pro"], tasks: ["impossible"], seeds: [42], attempts: 1 });
    for (let i = 0; i < 30; i++) await processQueue(env, Date.now() + 60_000 * (i + 1));
    await env.KV.delete(`arena:hero-variants:v2:${day}`);
    const vs = await heroVariants(env, getDb(env));
    expect(vs).toHaveLength(1);
    const v = vs[0]!;
    expect(v.fall.format).toBe("v2");
    expect(v.fall.duel.practice).toBe(false);
    expect(v.fall.duel.gauntlet!.lanes.filter((l) => l.fell).map((l) => l.model)).toEqual(["deepseek-v4-pro"]);
    expect(v.trap_id).toBe("FA-AMT-002");
    expect(v.h1).toBe(`A frontier AI model ${FALL_PHRASES[v.trap_id]}. Find out if yours would.`);
    const page = String(heroBlock(vs, LANDING_LEAD, familyStrip()));
    expect(page).toContain(`<h1 id="home-h1" data-variant-h1 data-trap="${v.trap_id}">${v.h1.replace(/'/g, "&#39;")}</h1>`);
    expect(page).toContain(`data-run="${v.fall.duel.gauntlet!.lanes[0].id}" data-ranked="yes" data-replay-format="v2"`);
    expect(page.match(/stamp-foul/g)).toHaveLength(1);
    // One variant: nothing to swap, so no picker script and no button.
    expect(page).not.toContain("hero-variants.js");
    expect(page).not.toContain("data-variant-next");
    // The same set all day (KV), whatever else is fought later that day.
    expect((await heroVariants(env, getDb(env)))[0]!.fall.duel.gauntlet!.lanes[0].id).toBe(v.fall.duel.gauntlet!.lanes[0].id);
  });
});

describe("the proof figures match their sources", () => {
  it("referee: the frozen referee-validity report's own agreement count, linked to the report", () => {
    const latest = frozenVersions().at(-1)!.doc.results.agreement;
    expect([latest.agree, latest.n]).toEqual([1433, 1437]);
    const v = refereeValidity({ VALIDITY_PUBLIC: "on" }, env.PUBLIC_ORIGIN);
    const item = proofItems({ validity: v, hard: null }).find((i) => i.key === "referee")!;
    expect(item.figure).toBe("1,433 of 1,437");
    expect(item.href).toBe("/research/referee-validity/v1");
    // Before the report is public, the figure isn't shown at all (never a zero, never a dead link).
    expect(proofItems({ validity: refereeValidity({ VALIDITY_PUBLIC: "off" }, env.PUBLIC_ORIGIN), hard: null }).some((i) => i.key === "referee")).toBe(false);
  });

  it("the latest ranked Hard event: the same falls, attempts and models as the /security line", () => {
    const item = proofItems({ validity: null, hard: CRUCIBLE }).find((i) => i.key === "crucible")!;
    expect(item.figure).toBe("15 of 108");
    expect(item.text).toBe("attempts fell for a planted trap in Crucible 2: Hard, our latest ranked Hard event, across 6 models, scored under rules 0.6");
    expect(item.href).toBe("/arena/event/crucible-2-hard/falls");
    const security = String(latestHardLine(CRUCIBLE));
    expect(security).toContain("In Crucible 2: Hard, the latest ranked Hard event, 15 of 108 attempts");
    expect(security).toContain("across 6 models");
    expect(security).toContain('href="/arena/event/crucible-2-hard/falls"');
    // Never "most": the strip states a count of a count.
    expect(String(proofStrip(proofItems({ validity: null, hard: CRUCIBLE })))).not.toMatch(/\bmost\b/i);
  });

  it("trap card: Lab #3's published counts, with the frontier limit beside it and the caveats one link away", async () => {
    const e3 = EXPERIMENTS[0]!;
    expect(labTotals().fewer).toBe(54);
    const item = proofItems({ validity: null, hard: null }).find((i) => i.key === "trap_card")!;
    expect(item.figure).toBe("54% fewer");
    expect(item.text).toContain("small open models");
    expect(item.text).toContain("frontier models: no measurable change");
    expect(item.href).toBe(`${e3.results}?from=home-proof`);
    expect(await html("/trap-card")).toContain("fell for 54% fewer traps");
  });

  it("the Gauntlet action: its released version, on the Marketplace; the home snippet is the published workflow", async () => {
    expect(ACTION_VERSION).toBe("1.0.0");
    const item = proofItems({ validity: null, hard: null }).find((i) => i.key === "ci")!;
    expect(item.figure).toBe("v1.0.0");
    expect(item.href).toBe(GAUNTLET_MARKETPLACE_URL);
    expect([GAUNTLET_ACTION_USES, GAUNTLET_CI_PATH]).toEqual([CI_USES, CI_PATH]);
    // The home page's workflow is the /gauntlet/ci one minus its comment, name and permission lines.
    for (const line of homeWorkflow().split("\n")) expect(workflowExample()).toContain(line);
    const ci = await html(GAUNTLET_CI_PATH);
    expect(ci).toContain(`<a href="${GAUNTLET_MARKETPLACE_URL}">Forge Gauntlet</a>, version 1.0.0`);
    expect(ci).toContain('<a href="https://github.com/theagentforge/gauntlet">github.com/theagentforge/gauntlet</a>');
  });

  it("each item in the (dormant) proof strip links to its source", async () => {
    const body = String(proofStrip(proofItems({ validity: refereeValidity(env, env.PUBLIC_ORIGIN), hard: null })));
    const strip = body.slice(body.indexOf('<section class="lp-proof"'), body.indexOf("</section>", body.indexOf('<section class="lp-proof"')));
    const items = [...strip.matchAll(/<li data-proof-item="([a-z_]+)"><b>[^<]+<\/b><span>[^<]+<\/span><a href="([^"]+)">[^<]+<\/a>((?:<a class="lp-also" href="[^"]+">[^<]+<\/a>)*)<\/li>/g)];
    expect(items.map((m) => m[1])).toContain("trap_card");
    expect(items.map((m) => m[1])).toContain("ci");
    for (const [, , href, also] of items) for (const h of [href!, ...[...(also ?? "").matchAll(/href="([^"]+)"/g)].map((m) => m[1]!)]) if (h.startsWith("/")) expect((await fetchWorker(h.split("?")[0]!, { headers: { Accept: "text/html" } })).status, h).toBe(200);
    expect(strip).toContain('<a class="lp-also" href="/lab/4/results?from=home-proof">Lab #4: frontier models</a><a class="lp-also" href="/lab/5/results?from=home-proof">');
  });
});

describe("no outside-use, install or check counts on the home page (Dinike, 13 Nov 09:43 and 16 Nov 09:34)", () => {
  it("seeded install and check counters never reach the page or its JSON, and no label says outside, installs or checks", async () => {
    for (const [k, v] of [["install:checked:plugin", 6543], ["install:blocked:plugin", 5432], ["check:web", 8765], ["check:mcp", 7654], ["connect:first-check", 9876]] as const)
      await env.DB.prepare("INSERT INTO usage_daily (day, key, n) VALUES (?, ?, ?) ON CONFLICT(day, key) DO UPDATE SET n = excluded.n").bind(today(), k, v).run();
    const figures = /6,?543|5,?432|8,?765|7,?654|9,?876/;
    const page = await html("/?n=v15-counts");
    const json = await (await fetchWorker("/?format=json&n=v15-counts")).text();
    expect(page).not.toMatch(figures);
    expect(json).not.toMatch(figures);
    expect(main(page)).not.toMatch(/outside (use|agents|users)|install checks|checks run|tools checked|installs?\b[^<]{0,20}\d/i);
    // The page never calls a tool safe. ("malicious" appears only in the dated October advisory line, about OSV's
    // malicious-package data, which the 12 Nov page carries until it retires itself on 22 Nov.)
    expect(main(page)).not.toMatch(/\bsafe\b|certified|guaranteed/i);
  });
});

describe("other pages from the 16 Nov audit", () => {
  it("/security puts the trap results, the referee check and the replays before what an install can reach", async () => {
    const body = await html("/security?n=v15-order");
    const at = ['<h2 id="arena">', '<h2 id="replays">', '<h2 id="gauntlet">', '<h2 id="reach">', '<h2 id="pre-install">'].map((m) => body.indexOf(m));
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The referee-validity and early-read lines keep their words (only their place moved).
    expect(body).toContain("How often an independent check agrees with the referee:");
  });

  it("/connect: one recommended path without sign-in, the same address for other apps, sign-in optional and explained once", async () => {
    const body = await html("/connect?n=v15-connect");
    const m = main(body);
    expect(m).toContain("Step 1 · recommended · under a minute · no sign-in");
    expect(m).toContain(`claude mcp add --scope user --transport http forge ${env.PUBLIC_ORIGIN}/mcp/public`);
    expect(m).toContain(`<code>${env.PUBLIC_ORIGIN}/mcp/public</code>, the same address everywhere, named <b>forge</b>.`);
    // Step 2 says it's optional, and says once what signing in adds, with the second server's name and address.
    expect(m).toContain("Step 2 · optional · about a minute");
    expect(m).not.toContain("one GitHub sign-in</p>");
    expect(m).toContain(`Signing in with GitHub adds a second server, <b>forge-reports</b> (<code>${env.PUBLIC_ORIGIN}/mcp</code>), beside <b>forge</b>`);
    expect(m).toContain("file field reports");
    expect(m).toContain("claim its Gauntlet runs");
    // The Gauntlet's own server is labelled as such.
    expect(m).toContain("<b>forge-gauntlet</b> (<code>/mcp/gauntlet</code>), used only for test runs");
  });

  it("/gauntlet says what its list of headline models shows, not 'Top models pass all six'", async () => {
    expect(allSixLine([])).toBe("");
    expect(allSixLine([{ passed: 6 }, { passed: 6 }])).toBe("Every headline model below passes all six. ");
    expect(allSixLine([{ passed: 6 }, { passed: 5 }, { passed: 5 }])).toBe("1 of the 3 headline models below passes all six. ");
    expect(allSixLine([{ passed: 6 }, { passed: 6 }, { passed: 5 }])).toBe("2 of the 3 headline models below pass all six. ");
    expect(allSixLine([{ passed: 5 }])).toBe("No headline model below passes all six. ");
    const g = await html("/gauntlet");
    expect(g).not.toContain("Top models pass all six.");
    expect(g).toContain("Season 1 leaderboard (ends 31 Dec 2026)");
  });
});
