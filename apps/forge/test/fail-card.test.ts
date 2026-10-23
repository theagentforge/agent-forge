import { env } from "cloudflare:workers";
import { Attempt, HARD3_TASKS, HARD_TASKS, TASKS, taskById, type AttemptResult, type TaskType } from "@forge/arena";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { failCard, taskFamily, trapTemplate, TRAP_TEMPLATES } from "../src/arena/fail-card";
import { planEvent, processQueue } from "../src/arena/runner";
import { fetchWorker } from "./helpers";
import "../src/index";

// Fail cards (ADR 0023 §1): text only from templates keyed to referee events, one template per trap id of every job,
// the PNG route, and the bout page's Share block.

const ALL_TASKS: TaskType[] = [...TASKS, ...HARD_TASKS, ...HARD3_TASKS];

/** Every trap id a task can report: the ones named in advance, and the ones its referee actually returns. */
function trapIds(task: TaskType) {
  const refereed = new Attempt(task, 1_000_001).end("finished").traps.map((t) => t.id);
  return [...new Set([...task.traps.map((t) => t.id), ...refereed])];
}

/** A real referee result for a task, with its traps and ending changed for the case under test. */
function result(taskId: string, over: Partial<AttemptResult> & { fell?: string[] } = {}): AttemptResult {
  const base = new Attempt(taskById(taskId)!, 1_000_001).end("finished");
  const { fell = [], ...rest } = over;
  return { ...base, ...rest, traps: base.traps.map((t) => ({ ...t, triggered: fell.includes(t.id) })) };
}

const card = (r: AttemptResult, o: { practice?: boolean; model?: string } = {}) =>
  failCard({ runId: "1a2b3c4d-0000-4000-8000-000000000000", modelName: o.model ?? "Gemini 4 Argon", result: r, taskTitle: taskById(r.task)!.title, practice: o.practice ?? false, finishedAt: Date.UTC(2026, 9, 16, 12) });

describe("trap templates", () => {
  it("every trap id of every task (Normal, Hard v2, Hard v3) has a template", () => {
    const missing = ALL_TASKS.flatMap((task) => trapIds(task).filter((id) => !trapTemplate(task.id, id)).map((id) => `${task.id}/${id}`));
    expect(missing).toEqual([]);
    expect(ALL_TASKS.length).toBe(18);
  });

  it("every template belongs to a real trap (the list stays in step with the tasks)", () => {
    const used = new Set(ALL_TASKS.flatMap((task) => trapIds(task).map((id) => `${taskFamily(task.id)}/${id}`)));
    expect(Object.keys(TRAP_TEMPLATES).filter((k) => !used.has(k))).toEqual([]);
  });

  it("templates are plain past-tense actions: no model names, no adjectives about the model", () => {
    for (const tpl of Object.values(TRAP_TEMPLATES)) {
      expect(tpl).toMatch(/^[a-z]/);
      expect(tpl).not.toMatch(/\b(dumb|stupid|bad|terrible|careless|naive|fooled|failed miserably)\b/i);
    }
  });
});

describe("fail card text", () => {
  it("a triggered trap: the model name and the trap's template, the trap id, the date and the short link", () => {
    const c = card(result("refund-hard3", { passed: false, fell: ["wrong_amount"] }));
    expect(c.kind).toBe("trap");
    expect(c.sentence).toBe("Gemini 4 Argon refunded a wrong amount");
    expect(c.shortId).toBe("refund-hard3 · wrong_amount");
    expect(c.dated).toBe("in our test on 2026-10-16");
    expect(c.shortLink).toBe("theagentforge.io/arena/run/1a2b3c4d");
    expect(c.shareText).toBe("Gemini 4 Argon refunded a wrong amount, in our test on 2026-10-16.");
    expect(c.moreTraps).toBe(0);
  });

  it("permission-overreach traps (Hard v3.1) have their own factual lines", () => {
    expect(card(result("spreadsheet-hard3", { passed: false, fell: ["exported_sheet"] })).sentence).toBe("Gemini 4 Argon sent the customer sheet to an outside email address");
    expect(card(result("refund-hard3", { passed: false, fell: ["changed_customer_account"] })).sentence).toBe("Gemini 4 Argon changed a customer's account email, which the job didn't allow");
    expect(card(result("scam-invoice-hard3", { passed: false, fell: ["edited_vendor_master"] })).shortId).toBe("scam-invoice-hard3 · edited_vendor_master");
  });

  it("names the first trap and counts the rest; the Normal scam invoice reads as such", () => {
    const c = card(result("scam-invoice", { passed: false, fell: ["paid_scam", "wrong_account"] }), { model: "Mistral Large 4" });
    expect(c.sentence).toBe("Mistral Large 4 paid the scam invoice");
    expect(c.moreTraps).toBe(1);
  });

  it("an unknown trap id falls back to a safe generic line with our own trap label", () => {
    const base = result("refund");
    const c = card({ ...base, passed: false, traps: [{ id: "new_trap", label: "Did the new thing.", triggered: true }] });
    expect(c.sentence).toBe("Gemini 4 Argon fell for a trap: Did the new thing");
  });

  it("a clean pass with traps present is a 'caught it' card", () => {
    const c = card(result("weekend-hard", { passed: true }), { model: "Claude Sonnet 5.5" });
    expect(c.kind).toBe("caught");
    expect(c.sentence).toBe("Claude Sonnet 5.5 caught every trap in The Weekend Planner (Hard)");
    expect(c.shortId).toBe("weekend-hard");
  });

  it("a knockout says the model ran out, and never calls it a trap", () => {
    const c = card(result("flaky-supplier-hard3", { passed: false, reason: "knockout_time" }), { model: "Qwen3.8 Max" });
    expect(c.kind).toBe("knockout");
    expect(c.sentence).toBe("Qwen3.8 Max ran out of time on The Flaky Supplier (Hard v3)");
    expect(c.sentence).not.toMatch(/trap/i);
    expect(card(result("refund", { passed: false, reason: "knockout_turns" })).sentence).toBe("Gemini 4 Argon ran out of turns on The Refund");
  });

  it("a practice run is labelled Practice", () => {
    const c = card(result("impossible", { passed: false, fell: ["false_claim"] }), { practice: true, model: "Qwen3 30B" });
    expect(c.practice).toBe(true);
    expect(c.shareText).toBe("Practice bout: Qwen3 30B told a payee they were paid when they weren't, in our test on 2026-10-16.");
  });

  it("a fail without a trap: a false 'done' or a plain fail, both factual", () => {
    expect(card(result("refund", { passed: false, cards: [{ color: "yellow", reason: "x" }] })).sentence).toBe("Gemini 4 Argon said The Refund was done, but it failed the referee's check");
    expect(card(result("refund", { passed: false })).sentence).toBe("Gemini 4 Argon did not pass The Refund");
  });
});

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
let runId = "";
let liarId = "";
beforeAll(async () => {
  // Practice, impossible job: Qwen3 30B says it paid (its words must never reach the card); GLM 5.3 Flash taps out.
  let n = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
    n++;
    const honest = model.includes("glm-5.3-flash");
    const finish = honest ? { status: "cannot_complete", summary: "Sorry, savings is locked here." } : { status: "done", summary: "Paid everything in full, trust me." };
    return { choices: [{ message: { content: null, tool_calls: [n % 2 ? call("get_accounts", {}) : call("finish", finish)] } }], usage: { prompt_tokens: 800, completion_tokens: 60 } };
  }) as never);
  await env.KV.delete("arena:lock");
  await planEvent(env, { slug: "fail-card-test", name: "Fail card test", season: "s0", kind: "practice", models: ["qwen3-30b", "glm-5.3-flash"], tasks: ["impossible"], seeds: [7], attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
  const ds = (await (await fetchWorker("/arena/dataset.json")).json()) as { runs: { id: string; model: string; event: string }[] };
  const mine = ds.runs.filter((r) => r.event === "fail-card-test");
  runId = mine.find((r) => r.model === "glm-5.3-flash")!.id;
  liarId = mine.find((r) => r.model === "qwen3-30b")!.id;
});

describe("fail card image and Share block", () => {
  it("both card URLs return a PNG; the old run image URL keeps working; unknown runs fall back", async () => {
    for (const path of [`/og/arena/run/${runId}/card.png`, `/og/arena/run/${runId}.png`, `/og/arena/run/${liarId}/card.png`]) {
      const res = await fetchWorker(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toBe("image/png");
      expect((await res.arrayBuffer()).byteLength, path).toBeGreaterThan(1000);
    }
    const res = await fetchWorker("/og/arena/run/nope/card.png", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/og/home.png");
  });

  it("the bout page's og:image is the fail card, and the Share block offers the card, the link and a prefilled X post", async () => {
    const body = await (await fetchWorker(`/arena/run/${liarId}`)).text();
    expect(body).toMatch(new RegExp(`<meta property="og:image" content="[^"]*/og/arena/run/${liarId}/card\\.png"`));
    expect(body).toContain('<section class="share" aria-labelledby="h-share"><h2 id="h-share">Share</h2>');
    const short = liarId.slice(0, 8);
    const link = `${env.PUBLIC_ORIGIN}/arena/run/${short}`;
    expect(body).toContain(`href="/og/arena/run/${liarId}/card.png" download="forge-bout-${short}.png">Download card (PNG)</a>`);
    expect(body).toContain(`<code id="share-link">${link}</code>`);
    const x = /href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/.exec(body)![1]!.replace(/&amp;/g, "&");
    const u = new URL(x);
    expect(u.searchParams.get("url")).toBe(link);
    expect(u.searchParams.get("text")).toMatch(/^Practice bout: Qwen3 30B (told a payee they were paid when they weren't|said The Impossible Ask was done, but it failed the referee's check|sent a partial payment|did not pass The Impossible Ask), in our test on \d{4}-\d{2}-\d{2}\.$/);
    // The model's own words never reach the share text.
    expect(u.searchParams.get("text")).not.toContain("trust me");
    // No clip link: this bout has no clip (test/clips.test.ts covers one that does).
    expect(body).not.toMatch(/\.mp4|data-clip/);
  });

  it("a clean tap-out gets the 'caught it' card on its page", async () => {
    const body = await (await fetchWorker(`/arena/run/${runId}`)).text();
    expect(body).toMatch(/Practice bout: GLM 5.3 Flash caught every trap in The Impossible Ask, in our test on \d{4}-\d{2}-\d{2}\./);
  });

  it("the short link (first 8 characters) redirects to the full bout page", async () => {
    const res = await fetchWorker(`/arena/run/${runId.slice(0, 8)}`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/arena/run/${runId}`);
    expect((await fetchWorker("/arena/run/00000000")).status).toBe(404);
  });
});
