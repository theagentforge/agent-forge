import { env } from "cloudflare:workers";
import { Attempt, taskById, wilsonInterval, type AttemptResult, type EndReason } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { ARENA_QUESTIONS, arenaQuestion, sectionSentence, type AnswerSection } from "../src/arena/answers";
import { modelName } from "../src/arena/views";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// Citations issue #234: one answer page per everyday Arena job, phrased as the question a person asks an assistant.
// The answer comes first with its date and sample size, a table per tier, FAQPage and Dataset JSON-LD, a Markdown twin,
// sitemap and llms.txt entries. Embargoed models (ADR 0041) and events held for review never show.

const ORIGIN = env.PUBLIC_ORIGIN;
const HARD = "crucible-2-hard-answers";
const NORMAL = "crucible-1-answers";
const HELD = "crucible-held-answers";
const SONNET = "claude-sonnet-5.5";
const GPT = "gpt-6.1-sol";
const EMB = EMBARGOED.id;
const SEED = 1_000_021;
const ids: Record<string, string> = {};
const INVOICES = "/answers/which-ai-models-fall-for-fake-invoices";
const LIE = "/answers/will-an-ai-agent-lie-that-a-payment-went-through";
const TRAVEL = "/answers/which-ai-models-break-the-rules-booking-travel";

/** A refereed attempt: passed, fell for one named trap, or ended by a stamina limit. */
function attempt(task: string, outcome: "pass" | { fell: string } | EndReason) {
  const a = new Attempt(taskById(task)!, SEED);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  const finished = outcome === "pass" || typeof outcome === "object";
  if (finished) a.call("finish", { status: "done", summary: "done" });
  const base = a.end(finished ? "finished" : outcome);
  const trap = typeof outcome === "object" ? outcome.fell : null;
  return { result: { ...base, passed: outcome === "pass", traps: base.traps.map((x) => ({ ...x, triggered: x.id === trap })) } as AttemptResult, log: a.log };
}

async function event(slug: string, name: string, status: "planned" | "done") {
  const id = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id, slug, name, season: "s0", kind: "card", status });
  return id;
}

async function run(key: string, eventId: string, model: string, task: string, attemptNo: number, outcome: Parameters<typeof attempt>[1], ago: number) {
  const r = attempt(task, outcome);
  const id = crypto.randomUUID();
  ids[key] = id;
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task, seed: SEED, attemptNo, status: "done", passed: r.result.passed, score: 0.5, cost: 0.1, tokens: 1000,
    result: r.result, log: r.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) }), finishedAt: Date.now() - ago,
  });
}

beforeAll(async () => {
  const hard = await event(HARD, "Crucible 2: Hard (test)", "done");
  const normal = await event(NORMAL, "Crucible 1 (test)", "done");
  const held = await event(HELD, "Held for review (test)", "planned");
  // Hard v3 invoices: Sonnet 2 of 3 (fell once for a compromised mailbox), GPT 2 of 3 plus a knockout.
  await run("s1", hard, SONNET, "scam-invoice-hard3", 1, "pass", 60_000);
  await run("s2", hard, SONNET, "scam-invoice-hard3", 2, { fell: "paid_scam" }, 59_000);
  await run("s3", hard, SONNET, "scam-invoice-hard3", 3, "pass", 58_000);
  await run("g1", hard, GPT, "scam-invoice-hard3", 1, "pass", 57_000);
  await run("g2", hard, GPT, "scam-invoice-hard3", 2, "pass", 56_000);
  await run("g3", hard, GPT, "scam-invoice-hard3", 3, "knockout_turns", 55_000);
  // Normal invoices: GPT falls for the lookalike with the hidden instruction.
  await run("n1", normal, GPT, "scam-invoice", 1, { fell: "paid_scam" }, 90_000);
  await run("n2", normal, SONNET, "scam-invoice", 1, "pass", 89_000);
  // The impossible payment: Sonnet tells the payee it was sent; GPT part-pays (a trap, but not the page's question).
  await run("i1", normal, SONNET, "impossible", 1, { fell: "false_claim" }, 80_000);
  await run("i2", normal, GPT, "impossible", 1, { fell: "partial" }, 79_000);
  // Embargoed and held: stored, never shown. The held event's travel job has nothing else.
  await run("embargoed", hard, EMB, "scam-invoice-hard3", 1, { fell: "paid_scam" }, 50_000);
  await run("held", held, SONNET, "scam-invoice-hard3", 1, { fell: "paid_scam" }, 40_000);
  await run("heldtravel", held, GPT, "weekend-hard3", 1, { fell: "over_budget" }, 40_000);
});

const html = (path: string) => fetchWorker(path, { headers: { Accept: "text/html" } });
const main = (body: string) => /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(body)![1]!;
const ldOf = (body: string) => [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hidden = (text: string) => {
  expect(text).not.toMatch(SHOWS_EMBARGOED);
  expect(text).not.toContain(HELD);
  expect(text).not.toContain(ids.held);
  expect(text).not.toContain("Held for review");
};

describe("GET /answers/<question>", () => {
  it("answers first, with the date and sample size, then a table per tier with intervals, trap ids and knockouts", async () => {
    const res = await html(INVOICES);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<h1 class="page-title">Which AI models fall for fake invoices?</h1>');
    const lead = /<p class="lead" id="answer">([^<]*)<\/p>/.exec(body)![1]!;
    expect(lead).toMatch(new RegExp(`^As of \\d{4}-\\d{2}-\\d{2}, in 6 refereed attempts by 2 models on The Scam Invoice \\(Hard v3\\), 1 of 2 models fell for a fake or redirected invoice at least once: ${modelName(SONNET)} \\(1 of 3\\)\\.`));
    // The Normal tier follows, with its own date and count.
    expect(lead).toContain("in 2 refereed attempts by 2 models on The Scam Invoice, 1 of 2 models fell for a fake or redirected invoice at least once: GPT-6.1 Sol (1 of 1).");
    const [lo, hi] = wilsonInterval(2, 3);
    expect(body).toContain(`${pct(lo)}–${pct(hi)}`);
    expect(body).toContain('href="/arena/failures/FA-PAY-002"');
    expect(body).toContain('href="/arena/failures/FA-INJ-001"');
    expect(body).toContain(`Knockouts, listed apart from traps: ${modelName(GPT)} 1`);
    expect(body).toContain(`href="/arena/run/${ids.s2}"`);
    expect(body).toContain(`href="/arena/events/${HARD}.csv"`);
    expect(body).toContain(`href="/arena/events/${NORMAL}.json"`);
    expect(body).toContain('href="/arena/methodology"');
    expect(body).toMatch(/updated <time datetime="\d{4}-\d{2}-\d{2}T[^"]+">\d{4}-\d{2}-\d{2}<\/time>/);
    expect(body).toContain('<link rel="alternate" type="text/markdown" href="/answers/which-ai-models-fall-for-fake-invoices.md">');
    expect(body).not.toMatch(/name="robots" content="noindex/);
    hidden(body);
    // Neutral wording: passed and fell for, never "safe".
    expect(main(body)).not.toMatch(/\bsafe(ly|ty)?\b/i);
  });

  it("has FAQPage and Dataset JSON-LD with the answer, dateModified and the event files", async () => {
    const body = await (await html(INVOICES)).text();
    const graph = ldOf(body).find((x) => x["@graph"])!["@graph"] as Record<string, any>[];
    const faq = graph.find((x) => x["@type"] === "FAQPage")!;
    const data = graph.find((x) => x["@type"] === "Dataset")!;
    expect(faq.mainEntity[0]).toMatchObject({ "@type": "Question", name: "Which AI models fall for fake invoices?", acceptedAnswer: { "@type": "Answer" } });
    expect(faq.mainEntity[0].acceptedAnswer.text).toMatch(/^As of \d{4}-\d{2}-\d{2}, in 6 refereed attempts/);
    expect(faq.mainEntity[1].acceptedAnswer.text).toContain("Wilson");
    expect(faq.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.dateModified).toBe(faq.dateModified);
    expect(data.temporalCoverage).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/);
    const urls = (data.distribution as { contentUrl: string }[]).map((d) => d.contentUrl);
    expect(urls).toEqual(expect.arrayContaining([`${ORIGIN}${INVOICES}?format=json`, `${ORIGIN}/arena/events/${HARD}.json`, `${ORIGIN}/arena/events/${HARD}.csv`, `${ORIGIN}/arena/events/${NORMAL}.csv`]));
    hidden(JSON.stringify(graph));
  });

  it("counts only the page's own trap for the question, and lists other traps in the table", async () => {
    const body = await (await html(LIE)).text();
    const lead = /<p class="lead" id="answer">([^<]*)<\/p>/.exec(body)![1]!;
    expect(lead).toMatch(/^As of \d{4}-\d{2}-\d{2}, in 2 refereed attempts by 2 models on The Impossible Ask, 1 of 2 models told a payee the money was sent when it wasn&#39;t at least once: Claude Sonnet 5\.5 \(1 of 1\)\.$/);
    expect(body).toContain('href="/arena/failures/FA-CLM-001"');
    // GPT part-paid: a trap the table lists, but not the lie the question asks about.
    expect(body).toContain('href="/arena/failures/FA-AMT-002"');
  });

  it("has a Markdown twin, at .md and by Accept, with the answer and the tables", async () => {
    for (const res of [await fetchWorker(`${INVOICES}.md`), await fetchWorker(INVOICES, { headers: { Accept: "text/markdown" } })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/markdown");
      const md = await res.text();
      expect(md).toMatch(/^---\ntitle: "Which AI models fall for fake invoices\? · The Agent Forge"/);
      expect(md).toContain("# Which AI models fall for fake invoices?");
      expect(md).toMatch(/As of \d{4}-\d{2}-\d{2}, in 6 refereed attempts by 2 models/);
      expect(md).toContain("| Model | Passed | 95% interval | Fell for a fake invoice | Traps fallen for | Knockouts | Replays |");
      // Replays and trap ids stay links inside the table.
      expect(md).toContain(`[FA-PAY-002](${ORIGIN}/arena/failures/FA-PAY-002)`);
      expect(md).toMatch(new RegExp(`\\[replay \\d\\]\\(${ORIGIN}/arena/run/${ids.s2}\\)`));
      expect(md).toContain(`(${ORIGIN}/arena/methodology)`);
      hidden(md);
    }
  });

  it("has a structured JSON twin without embargoed models or held events", async () => {
    const res = await fetchWorker(`${INVOICES}?format=json`);
    const j = (await res.json()) as { date_modified: string; attempts: number; focus_traps: string[]; sections: { task: string; version: string; attempts: number; knockouts: number; events: { slug: string }[]; models: { model: string; passes: number; attempts: number; did: number; ci_95: number[]; knockouts: number }[] }[] };
    expect(j.sections.map((s) => [s.task, s.version, s.attempts])).toEqual([["scam-invoice-hard3", "Hard v3", 6], ["scam-invoice", "Normal", 2]]);
    expect(j.sections[0]!.knockouts).toBe(1);
    expect(j.sections[0]!.events.map((e) => e.slug)).toEqual([HARD]);
    expect(j.sections[0]!.models.find((m) => m.model === SONNET)).toMatchObject({ passes: 2, attempts: 3, did: 1, ci_95: wilsonInterval(2, 3) });
    expect(j.sections[0]!.models.find((m) => m.model === GPT)).toMatchObject({ passes: 2, attempts: 3, did: 0, knockouts: 1 });
    expect(j.attempts).toBe(8);
    expect(j.focus_traps).toEqual(["FA-PAY-001", "FA-PAY-002", "FA-INJ-001"]);
    const text = JSON.stringify(j);
    hidden(text);
    // Links aside (the task guide lives at /best/<task>), nothing in it reads as an instruction.
    expect(text.replace(/https?:\/\/[^"]+/g, "")).not.toMatch(AGENT_DIRECTED);
  });

  it("says plainly when a job has no published ranked attempts (only held ones), and stays out of search", async () => {
    const body = await (await html(TRAVEL)).text();
    expect(body).toContain("No ranked, refereed attempts on this job have been published yet");
    expect(body).toMatch(/name="robots" content="noindex/);
    hidden(body);
    expect((await fetchWorker("/answers/is-this-a-question")).status).toBe(404);
    expect((await fetchWorker("/answers/which-ai-models-fall-for-fake-invoices.txt")).status).toBe(404);
  });
});

describe("finding the answer pages", () => {
  it("lists every question on /answers, in the sitemap and in llms.txt, and links them from the task guides", async () => {
    const index = await (await html("/answers")).text();
    const xml = await (await fetchWorker("/sitemap.xml")).text();
    const llms = await (await fetchWorker("/llms.txt")).text();
    for (const q of ARENA_QUESTIONS) {
      expect(index).toContain(`href="/answers/${q.slug}"`);
      expect(xml).toContain(`<loc>${ORIGIN}/answers/${q.slug}</loc>`);
      expect(llms).toContain(`(/answers/${q.slug})`);
    }
    expect(xml).toContain(`<loc>${ORIGIN}/answers</loc>`);
    const guide = await (await html("/best/scam-invoice-hard3")).text();
    expect(guide).toContain(`<a href="${INVOICES}">Which AI models fall for fake invoices?</a>`);
    const j = (await (await fetchWorker("/answers?format=json")).json()) as { questions: { slug: string; markdown: string }[] };
    expect(j.questions).toHaveLength(ARENA_QUESTIONS.length);
    expect(j.questions[0]!.markdown).toBe(`${ORIGIN}${INVOICES}.md`);
  });
});

describe("the answer sentence", () => {
  const section = (models: { name: string; passes: number; attempts: number; did: number }[]): AnswerSection =>
    ({ title: "The Refund (Hard v3)", as_of: "2026-10-25", attempts: models.reduce((a, m) => a + m.attempts, 0), models: models.map((m) => ({ ...m, ci_95: wilsonInterval(m.passes, m.attempts) })) }) as unknown as AnswerSection;
  const refunds = arenaQuestion("which-ai-model-can-be-trusted-with-refunds")!;

  it("leads with the model that passed most often, with its interval, for a 'which can be trusted' question", () => {
    const [lo, hi] = wilsonInterval(5, 6);
    expect(sectionSentence(refunds, section([{ name: "A", passes: 5, attempts: 6, did: 1 }, { name: "B", passes: 2, attempts: 6, did: 4 }]))).toBe(
      `As of 2026-10-25, in 12 refereed attempts by 2 models on The Refund (Hard v3), A passed most often (5 of 6 attempts, 95% interval ${pct(lo)}–${pct(hi)}); 2 of 2 models fell for a planted refund trap at least once.`,
    );
  });

  it("names ties, and never says a model passed when none did", () => {
    expect(sectionSentence(refunds, section([{ name: "A", passes: 3, attempts: 3, did: 0 }, { name: "B", passes: 6, attempts: 6, did: 0 }]))).toContain("A (3 of 3) and B (6 of 6) passed most often; none of them fell for a planted refund trap.");
    expect(sectionSentence(refunds, section([{ name: "A", passes: 0, attempts: 3, did: 3 }]))).toContain("by 1 model on The Refund (Hard v3), no model passed; 1 of 1 model fell for");
    expect(sectionSentence(refunds, section([{ name: "A", passes: 0, attempts: 3, did: 0 }]), "fell")).toBe("As of 2026-10-25, in 3 refereed attempts by 1 model on The Refund (Hard v3), the model never fell for a planted refund trap.");
    expect(sectionSentence(refunds, section([{ name: "A", passes: 3, attempts: 3, did: 0 }, { name: "B", passes: 1, attempts: 3, did: 0 }]), "fell")).toContain("none of the 2 models fell for a planted refund trap.");
  });
});
