import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { consistency, consistencyBoard, finishedRuns, isKnockout } from "../src/arena/views";
import { planEvent, processQueue } from "../src/arena/runner";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

// The Hard tier on the site (ADR 0021): /arena?tier=hard, /best?tier=hard, Hard task guides, bout pages, the home
// link, share images and the dataset. Hard runs never leak into the Normal pages.

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const page = async (path: string, accept = "text/html") => {
  const res = await fetchWorker(path, { headers: { Accept: accept } });
  return { res, body: await res.text() };
};

let hardRunId = "";
beforeAll(async () => {
  // DeepSeek V4 Pro (a ranked heavyweight) reads the accounts and taps out honestly; Kimi K2.6 claims it paid.
  vi.spyOn(env.AI, "run").mockImplementation((async (model: string, input: { messages: { role: string }[] }) => {
    const honest = model.includes("deepseek");
    const read = input.messages.some((m) => m.role === "tool");
    const finish = honest ? { status: "cannot_complete", summary: "Not enough money to make every payment." } : { status: "done", summary: "All paid." };
    return { choices: [{ message: { content: null, tool_calls: [read ? call("finish", finish) : call("get_accounts", {})] } }], usage: { prompt_tokens: 800, completion_tokens: 60 } };
  }) as never);
  await env.KV.delete("arena:lock");
  const models = ["deepseek-v4-pro", "kimi-k2.6"];
  await planEvent(env, { slug: "crucible-test", name: "Crucible test", season: "s0", kind: "card", models, tasks: ["impossible"], seeds: [1000001], attempts: 3 });
  await planEvent(env, { slug: "crucible-1-hard", name: "Crucible 1 Hard", season: "s0", kind: "card", models, tasks: ["impossible-hard"], seeds: [1000002], attempts: 3 });
  await processQueue(env, Date.now() + 20 * 60_000); // room for the Hard job's stamina
  const runs = await finishedRuns(getDb(env), { tier: "hard" });
  expect(runs).toHaveLength(6);
  hardRunId = runs[0]!.summary.id;
});

describe("consistency: right 3 times out of 3", () => {
  it("counts passes per version and the share of (task, seed) groups where every attempt passed", () => {
    const r = (task: string, seed: number, passed: boolean) => ({ task, seed, passed });
    const c = consistency([r("a", 1, true), r("a", 1, true), r("a", 1, false), r("a", 2, true), r("a", 2, true), r("b", 1, true)]);
    expect(c).toEqual({ passes: 5, attempts: 6, groups: 3, allRight: 2, reliable: 0.667 });
    expect(consistency([])).toEqual({ passes: 0, attempts: 0, groups: 0, allRight: 0, reliable: 0 });
    // The same seed on another task is another version.
    expect(consistency([r("a", 1, true), r("b", 1, false)]).groups).toBe(2);
  });

  it("the board keeps each tier to its own jobs", async () => {
    const db = getDb(env);
    const normal = await consistencyBoard(db, "normal");
    const hard = await consistencyBoard(db, "hard");
    expect(normal.tasks.map((t) => t.id)).not.toContain("impossible-hard");
    expect(hard.tasks.map((t) => t.id)).toContain("impossible-hard");
    const ds = normal.models.find((m) => m.model === "deepseek-v4-pro")!;
    expect(ds.tasks.impossible).toMatchObject({ passes: 3, attempts: 3, groups: 1, allRight: 1 });
    expect(ds.overall.reliable).toBe(1);
    const kimi = hard.models.find((m) => m.model === "kimi-k2.6")!;
    expect(kimi.tasks["impossible-hard"]).toMatchObject({ attempts: 3, groups: 1 });
    expect(kimi.tasks.impossible).toBeUndefined();
  });
});

describe("/arena tier switch", () => {
  it("Normal is the default: a link to Hard, Normal results only, and the All 3 right column", async () => {
    const { res, body } = await page("/arena");
    expect(res.status).toBe(200);
    expect(body).toMatch(/<nav class="presets tier-switch" aria-label="Tier"><a class="btn chamfer primary" href="\/arena" aria-current="page">Normal<\/a><a class="btn chamfer" href="\/arena\?tier=hard">Hard<\/a><\/nav>/);
    expect(body).toContain("Now Playing");
    expect(body).toContain("Right every time");
    expect(body).toContain('title="Share of job versions passed on all 3 attempts">All 3 right</th>');
    expect(body).toContain(">3 of 3</td>");
    expect(body).not.toContain("impossible-hard");
    expect(body).not.toContain("(Hard)");
  });

  it("?tier=hard shows the Hard explainer, rankings, consistency and recent Hard bouts", async () => {
    const { res, body } = await page("/arena?tier=hard");
    expect(res.status).toBe(200);
    expect(body).toContain('<a class="btn chamfer primary" href="/arena?tier=hard" aria-current="page">Hard</a>');
    expect(body).toContain("The same six jobs at real-world volume: a week of invoices, a 300-row sheet, a three-city trip. One slip fails the job.");
    expect(body).toContain("<h2>Hard rankings</h2>");
    expect(body).toContain("<b>DeepSeek V4 Pro</b>");
    expect(body).toContain("All 3 right");
    expect(body).toMatch(/<td title="[01] of 1 version right every time">[0-3] of 3<\/td>/);
    expect(body).toContain("<h2>Recent Hard bouts</h2>");
    expect(body).toContain(`href="/arena/run/${hardRunId}"`);
    expect(body).toContain('href="/arena/event/crucible-1-hard"');
    expect(body).toContain('href="/best/refund-hard"');
    // The Normal duel and Normal runs aren't here.
    expect(body).not.toContain("data-gauntlet=");
    expect(body).not.toContain("variant 1000001");
  });

  it("the Hard JSON twin is structured data", async () => {
    const j = (await (await fetchWorker("/arena?tier=hard&format=json")).json()) as {
      tier: string;
      tasks: { id: string }[];
      consistency: { models: { model: string; overall: { groups: number } }[] };
      recent_bouts: { task: string; url: string }[];
      rankings: Record<string, { model: string }[]>;
    };
    expect(j.tier).toBe("hard");
    expect(j.tasks).toHaveLength(6);
    expect(j.recent_bouts.every((r) => r.task === "impossible-hard")).toBe(true);
    expect(j.recent_bouts[0]!.url).toMatch(/^\/arena\/run\//);
    expect(j.consistency.models.map((m) => m.model).sort()).toEqual(["deepseek-v4-pro", "kimi-k2.6"]);
    expect(j.rankings.heavyweight?.[0]?.model).toBe("deepseek-v4-pro");
    const n = (await (await fetchWorker("/arena?format=json")).json()) as { tier: string };
    expect(n.tier).toBe("normal");
  });
});

describe("ran out of time: knockouts are counted apart from mistakes", () => {
  it("isKnockout reads the end reason", () => {
    expect(isKnockout({ reason: "knockout_time" })).toBe(true);
    expect(isKnockout({ reason: "knockout_tool_calls" })).toBe(true);
    expect(isKnockout({ reason: "finished" })).toBe(false);
    expect(isKnockout(null)).toBe(false);
  });

  it("the Hard table and recent bouts show a knocked-out attempt as ran out; Normal has no such column", async () => {
    const db = getDb(env);
    const [kimi] = (await finishedRuns(db, { tier: "hard" })).filter((r) => r.summary.model === "kimi-k2.6");
    await env.DB.prepare("update arena_runs set result = json_set(result, '$.reason', 'knockout_time') where id = ?").bind(kimi!.summary.id).run();
    const board = await consistencyBoard(db, "hard");
    expect(board.models.find((m) => m.model === "kimi-k2.6")!.ranOut).toBe(1);
    expect(board.models.find((m) => m.model === "deepseek-v4-pro")!.ranOut).toBe(0);
    const { body } = await page("/arena?tier=hard&fresh=1"); // a new URL: earlier tests cached the page
    expect(body).toContain('>Ran out</th>');
    expect(body).toContain("<td>1 of 3</td>");
    expect(body).toContain('<span class="outcome o-failed">✕ ran out</span>');
    expect(body).toContain("Ran out: out of time or moves (a fail, not a trap).");
    const normal = await page("/arena");
    expect(normal.body).not.toContain(">Ran out</th>");
  });
});

describe("/best and Hard task guides", () => {
  it("/best?tier=hard ranks models on the Hard jobs; plain /best stays Normal", async () => {
    const hard = await page("/best?tier=hard");
    expect(hard.res.status).toBe(200);
    expect(hard.body).toContain('<a class="btn chamfer primary" href="/best?tier=hard" aria-current="page">Hard</a>');
    expect(hard.body).toContain('<input type="hidden" name="tier" value="hard">');
    expect(hard.body).toContain('<a href="/best/impossible-hard">Impossible Ask</a>');
    expect(hard.body).toContain("/best?model=deepseek-v4-pro&amp;tier=hard#h-explore");
    const normal = await page("/best");
    expect(normal.body).not.toContain("impossible-hard");
    const j = (await (await fetchWorker("/best?tier=hard&cat=judgement&format=json")).json()) as {
      tier: string;
      tasks: { id: string }[];
      matrix: { tasks: { id: string; practice: boolean }[]; models: { id: string; ranks: Record<string, { rank: number } | null> }[] };
    };
    expect(j.tier).toBe("hard");
    expect(j.tasks.every((t) => t.id.endsWith("-hard"))).toBe(true);
    expect(j.matrix.tasks).toEqual([{ id: "impossible-hard", title: "The Impossible Ask (Hard)", practice: false }]);
    expect(j.matrix.models.find((m) => m.id === "deepseek-v4-pro")!.ranks["impossible-hard"]!.rank).toBe(1);
  });

  it("/best/<hard job> is a task guide with the Hard label, consistency and a JSON twin", async () => {
    const { res, body } = await page("/best/impossible-hard");
    expect(res.status).toBe(200);
    expect(body).toContain("Task guide · Hard tier");
    expect(body).toContain("The Impossible Ask (Hard): which AI should you use?");
    expect(body).toContain('<a href="/best/impossible">Normal version</a>');
    expect(body).toMatch(/data-label="All 3 right">\d+% <span class="muted">\([0-3] of 3\)<\/span>/);
    const j = (await (await fetchWorker("/best/impossible-hard?format=json")).json()) as { tier: string; data: string; ranking: { model: string; stats: { runs: number } }[] };
    expect(j.tier).toBe("hard");
    expect(j.data).toBe("headline");
    expect(j.ranking[0]!.model).toBe("deepseek-v4-pro");
    expect(j.ranking[0]!.stats.runs).toBe(3);
    // The Normal guide is unchanged by Hard data.
    const n = (await (await fetchWorker("/best/impossible?format=json")).json()) as { tier: string; ranking: { stats: { runs: number } }[] };
    expect(n.tier).toBe("normal");
    expect(n.ranking.every((r) => r.stats.runs === 3)).toBe(true);
  });

  it("the Normal task guide shows passes out of attempts in its own column", async () => {
    const { body } = await page("/best/impossible");
    expect(body).toContain('data-label="All 3 right">100% <span class="muted">(3 of 3)</span>');
    expect(body).toContain('data-label="All 3 right">0% <span class="muted">(0 of 3)</span>');
    expect(body).toContain('data-label="Pass">');
  });

  it("the share image for a Hard job renders", async () => {
    const res = await fetchWorker("/og/best/impossible-hard.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    await res.arrayBuffer();
  });
});

describe("Hard bouts, events, the home link and the dataset", () => {
  it("a Hard bout page works and says Hard on the task label", async () => {
    const { res, body } = await page(`/arena/run/${hardRunId}`);
    expect(res.status).toBe(200);
    expect(body).toContain('Crucible 1 Hard · <span class="label">Hard</span> The Impossible Ask (Hard) · variant 1000002');
    expect(body).toContain("Verified replay");
    const j = (await (await fetchWorker(`/arena/run/${hardRunId}.json`)).json()) as { tier: string; task: string };
    expect(j).toMatchObject({ tier: "hard", task: "impossible-hard" });
  });

  it("the Hard event card lists its bouts", async () => {
    const { body } = await page("/arena/event/crucible-1-hard");
    expect(body).toContain("<h2>The Impossible Ask (Hard)</h2>");
    expect(body).toContain("All 3 right");
  });

  it("the home page links to the Hard tier once a ranked Hard bout exists, and keeps the Normal duel", async () => {
    const { body } = await page("/");
    expect(body).toContain('<a href="/arena?tier=hard&amp;from=home">New: Hard tier →</a>');
    expect(body).toContain("data-gauntlet=");
    expect(body).not.toContain("Impossible Ask (Hard)");
    const j = (await (await fetchWorker("/?format=json")).json()) as { hard_tier: string | null; featured_bout: { a: { id: string } } };
    expect(j.hard_tier).toBe("/arena?tier=hard");
  });

  it("the dataset carries both tiers, every run labelled", async () => {
    const j = (await (await fetchWorker("/arena/dataset.json")).json()) as { runs: { task: string; tier: string }[] };
    expect(j.runs).toHaveLength(12);
    for (const r of j.runs) expect(r.tier).toBe(r.task.endsWith("-hard") ? "hard" : "normal");
    expect(j.runs.filter((r) => r.tier === "hard")).toHaveLength(6);
  });

  it("the rules explain the Hard tier", async () => {
    const { body } = await page("/arena/rules");
    expect(body).toContain('<h2 id="hard">The Hard tier</h2>');
  });
});
