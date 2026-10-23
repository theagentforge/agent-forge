import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { clipFileUrl, clipIndex, CLIPS_INDEX_URL, parseClipIndex, pendingClips, refreshClipIndex } from "../src/arena/clips";
import { TRAP_TEMPLATES } from "../src/arena/fail-card";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import "../src/index";

// Vertical clips (ADR 0023 §1, amendment 1): the clip page, the pending list for the workflow, the clip index the
// cron keeps in KV, and the Share block's clip link.

/** Free text a model might write. It must never reach a clip. */
const MODEL_WORDS = "Paid everything in full, trust me";

/** A real referee log and result (the model says it's done in its own words), with traps and ending set for the case. */
function result(taskId: string, over: Partial<AttemptResult> & { fell?: string[] } = {}) {
  const a = new Attempt(taskById(taskId)!, 1_000_001);
  a.recordTurn({ tokensIn: 800, tokensOut: 60, cost: 0.001, latencyMs: 900, text: MODEL_WORDS });
  a.call("finish", { status: "done", summary: MODEL_WORDS });
  const base = a.end("finished");
  const { fell = [], ...rest } = over;
  return { result: { ...base, ...rest, traps: base.traps.map((x) => ({ ...x, triggered: fell.includes(x.id) })) } as AttemptResult, log: a.log };
}

const ids: Record<string, string> = {};
const DAY = 86_400_000;

async function addRun(key: string, o: { kind: "card" | "guest" | "practice"; task: string; run: ReturnType<typeof result>; ageMs?: number; badSignature?: boolean }) {
  const { result: res, log } = o.run;
  const db = getDb(env);
  const eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: `clips-${key}-${eventId.slice(0, 6)}`, name: "Crucible 1", season: "s0", kind: o.kind, status: "done" });
  const id = crypto.randomUUID();
  const signature = o.badSignature ? "not-a-signature" : await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(log) });
  await db.insert(t.arenaRuns).values({
    id, eventId, modelId: "claude-sonnet-5.5", task: o.task, seed: 1_000_001, attemptNo: 1, status: "done",
    passed: res.passed, score: 0.5, cost: 0.01, tokens: 1000, result: res, log, signature, finishedAt: Date.now() - (o.ageMs ?? 60_000),
  });
  ids[key] = id;
}

beforeAll(async () => {
  await addRun("trap", { kind: "card", task: "scam-invoice", run: result("scam-invoice", { passed: false, fell: ["paid_scam"] }) });
  await addRun("caught", { kind: "guest", task: "refund-hard", run: result("refund-hard", { passed: true }), ageMs: 120_000 });
  await addRun("clipped", { kind: "card", task: "scam-invoice", run: result("scam-invoice", { passed: false, fell: ["paid_scam"] }) });
  await addRun("removed", { kind: "card", task: "scam-invoice", run: result("scam-invoice", { passed: false, fell: ["wrong_account"] }) });
  await addRun("practice", { kind: "practice", task: "scam-invoice", run: result("scam-invoice", { passed: false, fell: ["paid_scam"] }) });
  await addRun("knockout", { kind: "card", task: "refund", run: result("refund", { passed: false, reason: "knockout_time" }) });
  await addRun("unsigned", { kind: "card", task: "scam-invoice", run: result("scam-invoice", { passed: false, fell: ["paid_scam"] }), badSignature: true });
  await addRun("old", { kind: "card", task: "scam-invoice", run: result("scam-invoice", { passed: false, fell: ["paid_scam"] }), ageMs: 30 * DAY });
  await env.KV.put("arena:clips", JSON.stringify({ clips: [ids.clipped], removed: [ids.removed], fetchedAt: Date.now() }));
});

describe("the clip page", () => {
  it("is a 1080×1920, noindex page whose captions come only from the fail-card templates", async () => {
    const res = await fetchWorker(`/arena/run/${ids.trap}/clip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const body = await res.text();
    expect(body).toContain('<meta name="viewport" content="width=1080, height=1920, initial-scale=1">');
    expect(body).toContain('<meta name="clip-size" content="1080x1920">');
    expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    // The trap moment is the template sentence, word for word.
    const sentence = `Claude Sonnet 5.5 ${TRAP_TEMPLATES["scam-invoice/paid_scam"]}`;
    expect(body).toContain(`<p class="clip-sentence">${sentence}</p>`);
    // Model name and exact version, the task, the dated line, Verified replay and the short link.
    expect(body).toContain('<h1 class="clip-model">Claude Sonnet 5.5</h1>');
    expect(body).toContain('<p class="clip-exact">anthropic/claude-sonnet-5.5</p>');
    expect(body).toContain('<p class="clip-task">The Scam Invoice</p>');
    expect(body).toMatch(/<p class="clip-dated">In our test on \d{4}-\d{2}-\d{2}<\/p>/);
    expect(body).toContain('<p class="clip-verified ok">Verified replay</p>');
    expect(body).toContain(`theagentforge.io/arena/run/${ids.trap!.slice(0, 8)}`);
    expect(body).toContain('<p class="clip-verdict v-fail">FAIL</p>');
    // Nothing the model wrote.
    expect(body).not.toContain("trust me");
  });

  it("a clean catch says so; an unverified replay says that too", async () => {
    const caught = await (await fetchWorker(`/arena/run/${ids.caught}/clip`)).text();
    expect(caught).toContain('<p class="clip-sentence">Claude Sonnet 5.5 caught every trap in The Refund (Hard)</p>');
    expect(caught).toContain('<p class="clip-verdict v-pass">PASS</p>');
    const unsigned = await (await fetchWorker(`/arena/run/${ids.unsigned}/clip`)).text();
    expect(unsigned).toContain("Replay not verified");
    expect(unsigned).not.toContain(">Verified replay<");
  });

  it("the server renders the finished, static frame; motion is added by script and skipped for reduced motion", async () => {
    const body = await (await fetchWorker(`/arena/run/${ids.trap}/clip`)).text();
    for (const n of [1, 2, 3, 4]) expect(body).toContain(`class="beat beat-${n}`);
    expect(body).not.toMatch(/\shidden[\s>]|style="/);
    expect(body).not.toContain("clip-play");
    expect(body).toContain('<script src="/clip.js" defer></script>');
    const clipJs = (await import("../public/clip.js?raw")).default as string;
    const clipCss = (await import("../public/clip.css?raw")).default as string;
    expect(clipJs).toContain("prefers-reduced-motion: reduce");
    // Every rule that hides or animates a beat is scoped to .clip-play, so without it everything is visible.
    const css = clipCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1]!.trim(), body: m[2]! }));
    const moving = rules.filter((r) => /animation|opacity:0/.test(r.body));
    expect(moving.length).toBeGreaterThan(3);
    for (const r of moving) expect(r.sel, r.sel).toContain(".clip-play");
    expect(clipCss).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\s*\.clip-play \.beat[^{]*\{animation:none;opacity:1/);
  });

  it("is 404 for an unknown run", async () => {
    expect((await fetchWorker("/arena/run/no-such-run/clip")).status).toBe(404);
  });
});

describe("pending.json", () => {
  it("lists recent ranked bouts with a trap or a clean catch and a verified replay, without a clip or a takedown", async () => {
    const res = await fetchWorker("/arena/clips/pending.json");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { cap: number; clip_seconds: number; pending: { id: string; moment: string; clip_page: string; kind: string }[] };
    expect(data.cap).toBe(10);
    expect(data.pending.length).toBeLessThanOrEqual(10);
    const listed = data.pending.map((p) => p.id);
    expect(listed).toContain(ids.trap);
    expect(listed).toContain(ids.caught);
    for (const k of ["clipped", "removed", "practice", "knockout", "unsigned", "old"]) expect(listed, k).not.toContain(ids[k]);
    const trap = data.pending.find((p) => p.id === ids.trap)!;
    expect(trap).toMatchObject({ moment: "trap", kind: "card", clip_page: `/arena/run/${ids.trap}/clip` });
    expect(data.pending.find((p) => p.id === ids.caught)!.moment).toBe("caught");
    // Structured data only: no sentences, nothing the model wrote.
    expect(JSON.stringify(data)).not.toMatch(/trust me|paid the scam invoice/);
  });

  it("respects the cap", async () => {
    expect((await pendingClips(env, Date.now(), 1)).pending).toHaveLength(1);
  });
});

describe("the Share block", () => {
  it("offers the clip only when one exists", async () => {
    const withClip = await (await fetchWorker(`/arena/run/${ids.clipped}`)).text();
    expect(withClip).toContain(`<a class="btn chamfer" href="${clipFileUrl(ids.clipped!)}" data-clip-link>Download clip (MP4)</a>`);
    expect(clipFileUrl(ids.clipped!)).toBe(`https://github.com/theagentforge/agent-forge/releases/download/clips/${ids.clipped}.mp4`);
    const without = await (await fetchWorker(`/arena/run/${ids.trap}`)).text();
    expect(without).toContain('<section class="share"');
    expect(without).not.toMatch(/Download clip|\.mp4/);
    // A takedown hides the link even though the bout once had a clip.
    expect(await (await fetchWorker(`/arena/run/${ids.removed}`)).text()).not.toContain("Download clip");
  });
});

describe("the clip index (cron)", () => {
  const kv = () => {
    const m = new Map<string, string>();
    return { get: async (k: string, type?: string) => (m.has(k) ? (type === "json" ? JSON.parse(m.get(k)!) : m.get(k)) : null), put: async (k: string, v: string) => void m.set(k, v) } as unknown as KVNamespace;
  };
  const reply = (status: number, body: unknown) => (async (url: string | URL | Request) => {
    expect(String(url)).toBe(CLIPS_INDEX_URL);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

  it("stores the published index, keeping only well-formed run ids and dropping takedowns", async () => {
    const e = { KV: kv() };
    await refreshClipIndex(e, reply(200, { version: 1, clips: ["abc-1", "bad id!", "gone"], removed: ["gone"] }), 1234);
    expect(await clipIndex(e)).toEqual({ clips: ["abc-1"], removed: ["gone"], fetchedAt: 1234 });
  });

  it("no release yet means no clips; a GitHub error keeps the last good index", async () => {
    const e = { KV: kv() };
    await refreshClipIndex(e, reply(404, {}), 1);
    expect((await clipIndex(e)).clips).toEqual([]);
    await refreshClipIndex(e, reply(200, { clips: ["abc-1"] }), 2);
    await expect(refreshClipIndex(e, reply(503, {}), 3)).rejects.toThrow(/503/);
    await expect(refreshClipIndex(e, reply(200, { nope: true }), 4)).rejects.toThrow(/shape/);
    expect(await clipIndex(e)).toEqual({ clips: ["abc-1"], removed: [], fetchedAt: 2 });
  });

  it("an empty KV reads as no clips", async () => {
    expect(await clipIndex({ KV: kv() })).toEqual({ clips: [], removed: [], fetchedAt: 0 });
    expect(parseClipIndex("x")).toBeNull();
  });
});
