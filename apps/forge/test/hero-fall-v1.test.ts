import { env } from "cloudflare:workers";
import { anyTaskById, Attempt, publicTrapId, TRAP_CATALOG, type AttemptResult } from "@forge/arena";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { HERO_FALL_ANCHOR_DAY, heroFallPairs, PUBLICLY_CHECKABLE_FROM } from "../src/arena/featured";
import { FALL_PHRASES, familyStrip, HERO_PHRASE_MAX, heroH1, heroPhraseFits, heroVariants, isFrontier, variantOrder } from "../src/arena/hero-variants";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { heroBlock, HERO_VARIANTS_SCRIPT, heroTermLines, LANDING_LEAD, TERM_ROWS, V1_REPLAY_LABEL } from "../src/web/home-landing";
import { fetchWorker } from "./helpers";
import "../src/index";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";

// Production-shaped launch check and the rotating hero (Dinike, 16 Nov 12:08 Colombo: keep the hero changing so it
// doesn't look like we test one thing). Production has no ranked v2 (sealed) pair with a fall, only pre-28 Oct v1 runs
// such as Crucible 2: Hard. With that shape the hero must still build variants, each headline naming exactly the trap
// its replay shows, never FA-CLM-001, never a practice model, never opening on an Anthropic model's fall.

const V1_AT = Date.UTC(2026, 9, 25, 12);
const event = crypto.randomUUID();
const DAY = 86_400_000;
// FA-AMT-003 (refund wrong amount): Claude Sonnet's fall is its only pair.
const REFUND_TRAP = "wrong_amount";

function made(task: string, seed: number, fell: string[]) {
  const a = new Attempt(anyTaskById(task)!, seed);
  a.recordTurn({ tokensIn: 500, tokensOut: 40, cost: 0.001, latencyMs: 700, text: "Done." });
  a.call("finish", { status: "done", summary: "Done." });
  const base = a.end("finished");
  return { result: { ...base, passed: false, traps: base.traps.map((x) => ({ ...x, triggered: fell.includes(x.id) })) } as AttemptResult, log: a.log };
}

async function add(model: string, task: string, seed: number, fell: string[], at = V1_AT) {
  const r = made(task, seed, fell);
  const id = crypto.randomUUID();
  const signature = await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) });
  await getDb(env).insert(t.arenaRuns).values({ id, eventId: event, modelId: model, task, seed, attemptNo: 1, status: "done", heldOut: false, passed: false, score: 0.2, cost: 0.01, tokens: 1000, result: r.result, log: r.log, signature, finishedAt: at, replaySeal: null });
  return id;
}

const at = (d: number) => (HERO_FALL_ANCHOR_DAY + d) * DAY + 3_600_000;

beforeAll(async () => {
  expect(V1_AT).toBeLessThan(PUBLICLY_CHECKABLE_FROM);
  expect(REFUND_TRAP).toBeTruthy();
  await getDb(env).insert(t.arenaEvents).values({ id: event, slug: "crucible-2-hard", name: "Crucible 2: Hard", season: "s0", kind: "card", status: "done" });
  // Two deleted-real-record falls by different frontier models, each against a model that kept the row (as production).
  await add("mistral-large-4", "spreadsheet-hard3", 7001, ["deleted_real_row"]);
  await add("claude-sonnet-5.5", "spreadsheet-hard3", 7001, []);
  await add("gemini-4-argon", "spreadsheet-hard3", 7002, ["deleted_real_row"]);
  await add("deepseek-v4-pro", "spreadsheet-hard3", 7002, []);
  // An Anthropic model's fall on another trap: a variant, but never the no-JS default.
  await add("claude-sonnet-5.5", "refund-hard3", 7005, [REFUND_TRAP]);
  await add("gpt-6.1-sol", "refund-hard3", 7005, []);
  // A second frontier model fell for it too (no pair of its own): the variant ties FA-DAT-001 at two models, and its id
  // sorts first, so without the default rule the Anthropic fall would open the page.
  await add("gpt-6.1-sol", "refund-hard3", 7006, [REFUND_TRAP]);
  // One frontier model's fall on another trap: a singular headline.
  await add("gemini-4-argon", "refund-hard3", 7007, ["cash_refund_for_gift"]);
  await add("gpt-6.1-sol", "refund-hard3", 7007, []);
  // A false-claim pair (FA-CLM-001, the trap referee audit 2's disagreements were on): never used.
  await add("mistral-large-4", "impossible-hard3", 7003, ["false_claim"]);
  await add("claude-sonnet-5.5", "impossible-hard3", 7003, []);
  // Production's other Crucible 2: Hard falls (16 Nov): one whose phrase fits the hero (FA-CLM-002) and two whose
  // accurate phrases are too long for a headline (FA-AMT-005, FA-POL-012), so the hero skips them.
  await add("mistral-large-4", "flaky-supplier-hard3", 7008, ["false_success"]);
  await add("claude-sonnet-5.5", "flaky-supplier-hard3", 7008, []);
  await add("deepseek-v4-pro", "flaky-supplier-hard3", 7009, ["ignored_partial_fill"]);
  await add("gpt-6.1-sol", "flaky-supplier-hard3", 7009, []);
  await add("mistral-large-4", "weekend-hard3", 7010, ["nonrefundable_hotel"]);
  await add("gemini-4-argon", "weekend-hard3", 7010, []);
  // The three shortened to fit (coordinator, 16 Nov): FA-DUP-001 (two frontier models), FA-PAY-001 and FA-POL-013.
  await add("mistral-large-4", "flaky-supplier-hard3", 7011, ["double_order"]);
  await add("gemini-4-argon", "flaky-supplier-hard3", 7011, []);
  await add("deepseek-v4-pro", "flaky-supplier-hard3", 7012, ["double_order"]);
  await add("gemini-4-argon", "flaky-supplier-hard3", 7012, []);
  await add("mistral-large-4", "scam-invoice-hard3", 7013, ["wrong_account"]);
  await add("gemini-4-argon", "scam-invoice-hard3", 7013, []);
  await add("gpt-6.1-sol", "scam-invoice-hard3", 7014, ["paid_unreceived"]);
  await add("gemini-4-argon", "scam-invoice-hard3", 7014, []);
  // A practice model's fall in a ranked event: not a frontier model, so no "frontier AI model" headline.
  await add("gpt-oss-120b", "spreadsheet-hard3", 7004, ["deleted_paid_row"]);
  await add("gemini-4-argon", "spreadsheet-hard3", 7004, []);
});

describe("the home hero with production's shape: v1 pairs only (launch check)", () => {
  it("the eligible-pair query finds v1 falls and never FA-CLM-001", async () => {
    const pairs = await heroFallPairs(getDb(env));
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.every((p) => p.format === "v1")).toBe(true);
    expect(pairs.some((p) => p.publicId === "FA-CLM-001")).toBe(false);
    expect(pairs.some((p) => p.publicId === "FA-DAT-001")).toBe(true);
  });

  it("builds one variant per kind of frontier fall; each headline names exactly the trap its replay shows", async () => {
    const vs = await heroVariants(env, getDb(env), at(0));
    expect(vs.length).toBeGreaterThanOrEqual(2);
    expect(vs.map((v) => v.trap_id)).not.toContain("FA-CLM-001");
    for (const v of vs) {
      expect(v.fall.format).toBe("v1");
      const lanes = v.fall.duel.gauntlet!.lanes;
      expect(lanes.filter((l) => l.fell)).toHaveLength(1);
      const fell = lanes.find((l) => l.fell)!;
      expect(isFrontier(fell.model)).toBe(true);
      const [row] = await getDb(env).select({ task: t.arenaRuns.task, result: t.arenaRuns.result }).from(t.arenaRuns).where(eq(t.arenaRuns.id, fell.id));
      const sprung = (row!.result as AttemptResult).traps.filter((x) => x.triggered).map((x) => publicTrapId(row!.task, x.id));
      expect(sprung).toContain(v.trap_id);
      expect(v.h1).toBe(heroH1(v.trap_id, v.models_fell));
      expect(v.h1).toContain(FALL_PHRASES[v.trap_id]!);
    }
    // FA-DAT-002 fell only to a practice model: no variant.
    expect(vs.map((v) => v.trap_id)).not.toContain("FA-DAT-002");
  });

  it("only traps whose phrase is at most 60 characters rotate in the hero; longer ones are skipped, not reworded", async () => {
    expect(HERO_PHRASE_MAX).toBe(60);
    expect(FALL_PHRASES["FA-POL-005"]!.length).toBe(60);
    expect(heroPhraseFits("FA-POL-005")).toBe(true);
    // Shortened to fit, each mirroring its catalogue definition's key fact (pinned).
    expect(FALL_PHRASES["FA-DUP-001"]).toBe("ordered the same items twice after an error hid the order");
    expect(FALL_PHRASES["FA-PAY-001"]).toBe("paid a real supplier to bank details not on file");
    expect(FALL_PHRASES["FA-POL-013"]).toBe("paid for goods the delivery note showed weren't received");
    for (const id of ["FA-DUP-001", "FA-PAY-001", "FA-POL-013"]) expect(heroPhraseFits(id), id).toBe(true);
    for (const long of ["FA-AMT-005", "FA-PAY-002", "FA-INJ-002", "FA-POL-004", "FA-POL-012", "FA-AMT-006", "FA-CLM-003"]) {
      expect(FALL_PHRASES[long]!.length, long).toBeGreaterThan(60);
      expect(heroPhraseFits(long), long).toBe(false);
    }
    expect(heroPhraseFits("FA-NOPE-001")).toBe(false);
    // The long traps have eligible pairs (the pair query finds them) but never become variants.
    const pairs = await heroFallPairs(getDb(env));
    expect(pairs.map((p) => p.publicId)).toEqual(expect.arrayContaining(["FA-AMT-005", "FA-POL-012", "FA-CLM-002"]));
    const vs = await heroVariants(env, getDb(env), at(0));
    for (const v of vs) expect(FALL_PHRASES[v.trap_id]!.length, v.trap_id).toBeLessThanOrEqual(60);
    // Today's production-shaped survivors, in order (Hard first, most frontier models, then id; no-JS default not
    // Anthropic). FA-POL-013 fits but is seventh, so the six-variant limit leaves it out.
    expect(vs.map((v) => v.trap_id)).toEqual(["FA-DAT-001", "FA-AMT-003", "FA-DUP-001", "FA-CLM-002", "FA-PAY-001", "FA-POL-005"]);
    expect(vs.find((v) => v.trap_id === "FA-DUP-001")!.h1).toBe("Frontier AI models ordered the same items twice after an error hid the order. Find out if yours would.");
    expect(vs.find((v) => v.trap_id === "FA-PAY-001")!.h1).toBe("A frontier AI model paid a real supplier to bank details not on file. Find out if yours would.");
  });

  it("plural only when two or more frontier models fell for the trap", async () => {
    const vs = await heroVariants(env, getDb(env), at(0));
    const dat = vs.find((v) => v.trap_id === "FA-DAT-001")!;
    expect(dat.models_fell).toBe(2);
    // The catalogue defines one row ("Deleted a row that looked like a duplicate but was a separate record"): singular object.
    expect(dat.h1).toBe("Frontier AI models deleted a real record that only looked like a duplicate. Find out if yours would.");
    const refund = vs.find((v) => v.trap_id === publicTrapId("refund-hard3", REFUND_TRAP))!;
    expect(refund.models_fell).toBe(2);
    expect(refund.h1).toBe("Frontier AI models refunded the wrong amount or an ineligible item. Find out if yours would.");
    const gift = vs.find((v) => v.trap_id === "FA-POL-005")!;
    expect(gift.models_fell).toBe(1);
    expect(gift.h1).toBe("A frontier AI model refunded a gift order to the card instead of as store credit. Find out if yours would.");
  });

  it("the no-JS default is never an Anthropic model's fall; within a variant the falling model rotates by day", async () => {
    const fallen: string[] = [];
    for (const d of [0, 1, 2, 3]) {
      const vs = await heroVariants(env, getDb(env), at(d));
      expect(vs[0]!.fall.duel.gauntlet!.lanes.find((l) => l.fell)!.model, `day ${d}`).not.toMatch(/^claude-/);
      fallen.push(vs.find((v) => v.trap_id === "FA-DAT-001")!.fall.duel.gauntlet!.lanes.find((l) => l.fell)!.model);
    }
    expect(new Set(fallen)).toEqual(new Set(["mistral-large-4", "gemini-4-argon"]));
    expect(fallen[0]).not.toBe(fallen[1]);
  });

  // Dormant since BRAND.md v1.6 (16 Nov revert to the 12 Nov home): the landing hero is rendered on its own here.
  it("the landing hero carries every variant in its HTML, the tiny picker script, the button and the family strip", async () => {
    const vs = await heroVariants(env, getDb(env));
    const body = String(heroBlock(vs, LANDING_LEAD, familyStrip()));
    expect(body).toContain(`<h1 id="home-h1" data-variant-h1 data-trap="${vs[0]!.trap_id}">${vs[0]!.h1}</h1>`);
    // Every variant's replay is in the HTML: the first shown, the others hidden and inert in the same grid cell.
    expect(body).toContain(`<div class="lp-variant" data-variant="0" data-trap="${vs[0]!.trap_id}" data-h1="`);
    expect(body.match(/<div class="lp-variant hero-size" data-variant="\d+" data-trap="FA-[A-Z]+-\d+" data-h1="[^"]+" aria-hidden="true" inert data-nosnippet>/g)).toHaveLength(vs.length - 1);
    expect(body).toContain('<div class="hero-cell" data-variant-slot>');
    // Hidden copies of every variant's h1 in the h1's own grid cell reserve the tallest one's height (no layout shift).
    const cell = body.slice(body.indexOf('<div class="hero-cell lp-h1-cell">'), body.indexOf("</div>", body.indexOf('<div class="hero-cell lp-h1-cell">')));
    expect(cell.match(/<p class="hero-size lp-h1-size" aria-hidden="true" data-nosnippet>/g)).toHaveLength(vs.length);
    // Each replay heading id is unique.
    const ids = [...body.matchAll(/id="(lp-replay-t[^"]*)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    // A classic script right after the hero section: no module, no defer, no async, so the pick happens before paint.
    expect(body).toContain(`</section>\n<script src="${HERO_VARIANTS_SCRIPT}"></script>`);
    expect(body).not.toMatch(/<script[^>]*hero-variants\.js[^>]*(type="module"|defer|async)/);
    expect(body).toContain('<button type="button" class="btn chamfer lp-another" data-variant-next hidden>Show another trap →</button>');
    expect(body).toContain('<p class="sr-only" aria-live="polite" data-variant-status></p>');
    expect(body.replaceAll("&#39;", "'")).toContain(`Hidden in our jobs: ${familyStrip().join(" · ")}.`);
    // Hero polish (16 Nov): the five most recognisable families, short enough for one line on desktop.
    expect(familyStrip()).toEqual(["changed bank details", "hidden instructions", "duplicate payments", "refunds over policy", "false “done” reports"]);
    // In the markup the strip comes after the button (first screen on a phone); desktop CSS lifts it to one line above.
    expect(body.indexOf('<p class="small lp-families">')).toBeGreaterThan(body.indexOf("data-home-primary"));
    // Every terminal has at most TERM_ROWS lines, one per row (site.css draws exactly that many rows).
    const terms = body.match(/<ol class="lp-term mono"[\s\S]*?<\/ol>/g) ?? [];
    expect(terms).toHaveLength(vs.length);
    for (const ol of terms) expect((ol.match(/<li /g) ?? []).length).toBeLessThanOrEqual(TERM_ROWS);
    expect(body).toContain(`<span class="lp-v1" data-replay-v1>${V1_REPLAY_LABEL}</span>`);
    expect(body).not.toMatch(SHOWS_EMBARGOED);
    const script = await (await env.ASSETS.fetch("https://assets.local/hero-variants.js")).text();
    expect(script.length).toBeLessThan(1600);
    expect(script).not.toMatch(/setInterval|setTimeout|fetch\(|^\s*(export|import)\b/m);
    // Uniform pick over every variant, and the button wraps to the first.
    expect(script).toContain("crypto.getRandomValues(new Uint32Array(1))[0] % n");
    expect(script).toContain("show((cur + 1) % n, true)");
  });

  it("every phrase belongs to a published trap (never FA-CLM-001), and the hero CSS reserves the hidden copies' space", async () => {
    const ids = new Set(TRAP_CATALOG.map((e) => e.id));
    for (const id of Object.keys(FALL_PHRASES)) expect(ids.has(id), id).toBe(true);
    expect(FALL_PHRASES["FA-CLM-001"]).toBeUndefined();
    expect(FALL_PHRASES["FA-DAT-001"]).toBe("deleted a real record that only looked like a duplicate");
    const css = (await (await env.ASSETS.fetch("https://assets.local/site.css")).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".hero-cell>*{grid-area:1/1}");
    expect(css).toContain(".hero-size{visibility:hidden}");
    expect(css).toContain(".lp-hero h1,.lp-hero .lp-h1-size{");
    // Hero polish (16 Nov): a fixed TERM_ROWS-row terminal, one unwrapped line per call, so panels match in height.
    // From 768 px: fixed rows, unwrapped lines. Below: every line wraps (nothing cut off, WCAG 1.4.10), no fixed rows.
    const wide = css.match(/@media \(min-width:768px\)\{\s*\.lp-term\{[^}]*\}\s*\.lp-term li\{[^}]*\}\s*\}/)?.[0] ?? "";
    expect(wide).toContain(`grid-template-rows:repeat(${TERM_ROWS},calc(1.45em + 4px))`);
    expect(wide).toMatch(/\.lp-term li\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
    const base = css.replace(wide, "");
    expect(base).toMatch(/\.lp-term li\{[^}]*white-space:normal;overflow-wrap:anywhere/);
    expect(base).not.toMatch(/\.lp-term\{[^}]*grid-template-rows/);
    expect(base).not.toMatch(/\.lp-term li\{[^}]*(nowrap|ellipsis)/);
    expect(base).toMatch(/\.lp-term\{[^}]*min-height:calc\(8 \* \(1\.45em \+ 4px\) \+ 7 \* 4px\)/);
    // The print-in finishes within a second, so the panel never sits half-empty.
    const delays = [...css.matchAll(/\.lp-term li\[data-i="\d"\]\{animation-delay:([\d.]+)s\}/g)].map((m) => Number(m[1]));
    expect(delays.length).toBe(9);
    expect(Math.max(...delays)).toBeLessThan(1);
    // The family strip is one line above the hero on desktop; the h1 sits at the bottom of its reserved cell.
    expect(css).toMatch(/@media \(min-width:1000px\)\{[^@]*\.lp-hero>\.lp-families\{grid-column:1\/-1;grid-row:1;[^}]*white-space:nowrap/);
    expect(css).toContain(".lp-h1-cell>h1,.lp-h1-cell>.lp-h1-size{margin:0;align-self:end}");
  });

  it("the hero terminal always keeps the highlighted trap call: the trap line plus the last seven when it would drop", () => {
    const row = (i: number, trap = false) => `<li class="${trap ? "gx-trapline" : ""}">[A] call ${i}</li>`;
    // Trap inside the last eight: just the last eight.
    const near = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => row(i, i === 5));
    expect(heroTermLines(near)).toEqual(near.slice(-TERM_ROWS));
    // Trap earlier than the last eight: the trap line first, then the last seven.
    const far = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => row(i, i === 1));
    const kept = heroTermLines(far);
    expect(kept).toHaveLength(TERM_ROWS);
    expect(kept[0]).toBe(row(1, true));
    expect(kept.slice(1)).toEqual(far.slice(-(TERM_ROWS - 1)));
    // No trap line (or a short bout): the last eight, unchanged.
    const none = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => row(i));
    expect(heroTermLines(none)).toEqual(none.slice(-TERM_ROWS));
    expect(heroTermLines(near.slice(0, 3))).toEqual(near.slice(0, 3));
  });

  it("variantOrder: v2 pairs before v1, and the falling model changes from one day to the next", () => {
    const p = (model: string, format: "v2" | "v1", id: string) => ({ pick: { a: { id, model, task: "spreadsheet-hard3" }, b: { id: `${id}b` } }, format, trap: "deleted_real_row", publicId: "FA-DAT-001", fellModel: model }) as never;
    const pairs = [p("mistral-large-4", "v1", "m1"), p("mistral-large-4", "v1", "m2"), p("gemini-4-argon", "v1", "g1"), p("qwen3.8-max", "v2", "q1")];
    expect((variantOrder(pairs, 0)[0] as { format: string }).format).toBe("v2");
    const v1 = pairs.slice(0, 3);
    const first = (d: number) => (variantOrder(v1, d)[0] as { fellModel: string }).fellModel;
    expect(first(0)).not.toBe(first(1));
  });
});
