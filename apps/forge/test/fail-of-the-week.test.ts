import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { failOfTheWeek, FOTW_RULES, latestFailOfTheWeek, rankCandidates, slotForDate } from "../src/arena/fail-of-the-week";
import { lastHeadlineSlot, slotDate, weeklySlug } from "../src/arena/headline-slot";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import type { Draft } from "../src/social/drafts";
import { fetchWorker } from "./helpers";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// V4 (docs/strategy/agent-social-loops.md §3): the Fail of the Week from the weekly headline bout. A sprung trap in a
// failed attempt, frontier models first, verified replays only, never an embargoed model (ADR 0041), stable once
// picked, and an approve-only X and Moltbook draft whose numbers are all on the page.

const MODEL_WORDS = "Paid everything in full, trust me";
const SLOT = lastHeadlineSlot(Date.now())!;
const DATE = slotDate(SLOT);
const SATURDAY = new Date(Date.parse(`${DATE}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);

function result(fell: string[], over: Partial<AttemptResult> = {}) {
  const a = new Attempt(taskById("scam-invoice")!, 3_000_001);
  a.recordTurn({ tokensIn: 800, tokensOut: 60, cost: 0.001, latencyMs: 900, text: MODEL_WORDS });
  a.call("finish", { status: "done", summary: MODEL_WORDS });
  const base = a.end("finished");
  return { result: { ...base, passed: fell.length === 0 && over.passed !== false, ...over, traps: base.traps.map((x) => ({ ...x, triggered: fell.includes(x.id) })) } as AttemptResult, log: a.log };
}

const ids: Record<string, string> = {};
let eventId = "";

async function addRun(key: string, model: string, run: ReturnType<typeof result>, o: { badSignature?: boolean; status?: "done" | "running"; finishedAt?: number } = {}) {
  const id = crypto.randomUUID();
  const signature = o.badSignature ? "not-a-signature" : await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(run.log) });
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task: "scam-invoice", seed: 3_000_001, attemptNo: 1, status: o.status ?? "done",
    passed: run.result.passed, score: 0.2, cost: 0.01, tokens: 1000, result: run.result, log: run.log, signature, finishedAt: o.finishedAt ?? SLOT + 600_000,
  });
  ids[key] = id;
}

beforeAll(async () => {
  eventId = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values({ id: eventId, slug: weeklySlug(SLOT), name: `Weekly headline bout, ${DATE}`, season: "s1", kind: "card", status: "done" });
  // Would win on every rule, but it's embargoed: never read, never picked.
  await addRun("embargoed", EMBARGOED.id, result(["paid_scam"]), { finishedAt: SLOT + 60_000 });
  // Best-known frontier model, but its replay doesn't verify.
  await addRun("unsigned", "gpt-6.1-sol", result(["paid_scam"]), { badSignature: true });
  // A knockout without a trap is never a Fail of the Week.
  await addRun("knockout", "claude-sonnet-5.5", result([], { passed: false, reason: "knockout_time" }));
  // A well-known model, but not a frontier one (practice division).
  await addRun("small", "claude-haiku-5.5", result(["paid_scam"]));
  await addRun("pick", "gemini-4-argon", result(["paid_scam"]));
  await addRun("lesser", "mistral-large-4", result(["paid_scam"]));
  await addRun("clean", "qwen3.8-max", result([]));
});

describe("picking the Fail of the Week", () => {
  it("takes a frontier model's sprung trap with a verified replay, never an embargoed model or a knockout", async () => {
    const f = await failOfTheWeek(env, SLOT);
    expect(f).not.toBeNull();
    expect(f!.run.id).toBe(ids.pick);
    expect(f!.run.frontier).toBe(true);
    expect(f!.card.kind).toBe("trap");
    expect(f!.trap.public_id).toMatch(/^FA-[A-Z]{3}-\d{3}$/);
    expect(f!.trap.source?.url).toMatch(/^https:\/\//);
    expect(f!.bout.map((b) => b.model)).not.toContain(EMBARGOED.id);
    expect(JSON.stringify(f)).not.toContain(MODEL_WORDS);
  });

  it("keeps the first pick, even if a better candidate appears later", async () => {
    const better = result(["paid_scam"]);
    await addRun("late", "claude-sonnet-5.5", better, { finishedAt: SLOT + 1000 });
    expect((await failOfTheWeek(env, SLOT))!.run.id).toBe(ids.pick);
  });

  it("orders by the published rules: frontier, then a sourced trap, then reach", () => {
    const c = (id: string, frontier: boolean, source: boolean, reach: number) => ({ frontier, source, reach, entry: { family: "PAY" }, r: { run: { id, finishedAt: 1 } } });
    expect(rankCandidates([c("a", false, true, 2), c("b", true, false, 0), c("c", true, true, 0), c("d", true, true, 2)]).map((x) => x.r.run.id)).toEqual(["d", "c", "b", "a"]);
    expect(FOTW_RULES.order[0]).toBe("frontier_model_first");
  });

  it("waits until every attempt is refereed, and only reads Thursday slot dates", async () => {
    expect(slotForDate("2026-10-22")).not.toBeNull();
    expect(slotForDate("2026-10-23")).toBeNull();
    expect(slotForDate("2026-10-15")).toBeNull();
    expect(slotForDate("2026-02-30")).toBeNull();
    expect(await failOfTheWeek(env, SLOT + 7 * 86_400_000)).toBeNull();
    expect((await latestFailOfTheWeek(env))!.date).toBe(DATE);
  });
});

describe("the Fail of the Week pages", () => {
  it("serve the latest and a permanent dated page with the replay, clip view and the trap's source", async () => {
    for (const path of ["/arena/fail-of-the-week", `/arena/fail-of-the-week/${DATE}`]) {
      const res = await fetchWorker(path, { headers: { Accept: "text/html" } });
      expect(res.status).toBe(200);
      const page = await res.text();
      expect(page).toContain(`/arena/run/${ids.pick}`);
      expect(page).toContain(`/arena/run/${ids.pick}/clip`);
      expect(page).toContain("Gemini 4 Argon");
      expect(page).toContain("Real-world pattern");
      expect(page).not.toContain(MODEL_WORDS);
      expect(page).not.toMatch(SHOWS_EMBARGOED);
    }
  });

  it("has a structured JSON twin (data, not instructions), and 404s for a date without a pick", async () => {
    const res = await fetchWorker(`/arena/fail-of-the-week/${DATE}?format=json`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).toMatchObject({ date: DATE, run: ids.pick, model: "gemini-4-argon", verdict: "FAIL", replay_verified: true, frontier: true });
    expect(String(j.replay_url)).toContain(`/arena/run/${ids.pick}`);
    expect(JSON.stringify(j)).not.toContain(MODEL_WORDS);
    expect((await fetchWorker("/arena/fail-of-the-week/2026-10-23?format=json")).status).toBe(404);
    expect((await fetchWorker("/arena/fail-of-the-week/2026-10-23", { headers: { Accept: "text/html" } })).status).toBe(404);
  });
});

describe("the Fail of the Week draft", () => {
  it("is drafted for Saturday as approve-only, with every number from the page and a Moltbook post with its evidence link", async () => {
    const res = await fetchWorker(`/api/v1/social/drafts?date=${SATURDAY}`);
    const data = (await res.json()) as { drafts: Draft[] };
    const d = data.drafts.find((x) => x.type === "fail-of-the-week");
    expect(d).toBeDefined();
    expect(d!.approveOnly).toBe(true);
    expect(d!.facts.runs).toEqual([{ id: ids.pick, model: "gemini-4-argon", fell: true, passed: false }]);
    expect(d!.facts.sources[0]).toBe(`/arena/fail-of-the-week/${DATE}?format=json`);
    const page = (await (await fetchWorker(`/arena/fail-of-the-week/${DATE}?format=json`)).json()) as { bout: { attempts: number; fell: number; passed: number }[] };
    const sum = (k: "attempts" | "fell" | "passed") => page.bout.reduce((a, b) => a + b[k], 0);
    expect(d!.facts.numbers.slice(0, 3)).toEqual([sum("attempts"), sum("fell"), sum("passed")]);
    for (const text of d!.texts) {
      expect(text).not.toMatch(/https?:\/\//);
      expect(text).toContain("Gemini 4 Argon");
      // At most two sentences of claims.
      expect(text.split(/(?<=[.?!])\s+/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
    }
    expect(d!.reply).toContain(`/arena/fail-of-the-week/${DATE}`);
    expect(d!.moltbook!.content).toContain(`https://theagentforge.io/arena/fail-of-the-week/${DATE}`);
    expect(d!.moltbook!.content.length).toBeLessThanOrEqual(1000);
    expect(d!.moltbook!.content).not.toMatch(/\b(you should|always|must|install)\b/i);
    expect(JSON.stringify(d)).not.toMatch(SHOWS_EMBARGOED);
  });
});
