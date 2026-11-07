import { env } from "cloudflare:workers";
import { Attempt, FRONTIER_CATALOG, FRONTIER_FREEZE, FRONTIER_TASK_IDS, PRIVATE_TASK_IDS, taskById, TRAP_CATALOG, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { SAFE, TRAP_SET, TRAP_SET_VERSIONS, trapSetEntries } from "../src/arena/benchmark";
import { TRAP_TEMPLATES } from "../src/arena/fail-card";
import { packDigest } from "../src/arena/held-events";
import { finishedRuns } from "../src/arena/views";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import { PRIVATE_TRAP_CATALOG } from "../../../packages/arena/src/private";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import { IMPERATIVE, SALES, SHOUTED } from "./wording";
import "../src/index";

// Trap Set 1.3 (ADR 0139 Amendment 5; Dinike, 7 Nov 16:24 Colombo): the frozen frontier jobs promoted to public task
// version Frontier 1.0. Their public pages render; their calibration runs (seeds below 1,000,000), their held-out `-x`
// variants and the private FA-*-1xx ids never reach a public page; the catalog and version pins hold.

const PRIVATE_ID = /FA-[A-Z]{3}-1\d{2}/;
const VARIANTS = FRONTIER_TASK_IDS.map((id) => `${id}-x`);
const FRESH = 1_234_567;
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const ids: Record<string, string> = {};

const finished = (task: string, seed: number): AttemptResult => {
  const a = new Attempt(taskById(task)!, seed);
  return { ...a.end("finished"), rules: "rules 0.7" } as AttemptResult;
};

beforeAll(async () => {
  const db = getDb(env);
  // A calibration event left running by mistake (practice, dev seed), a ranked event on a fresh seed, and a held
  // event that holds both: only the fresh-seed ranked run may be public.
  const cal = newId();
  const ranked = newId();
  const held = newId();
  await db.insert(t.arenaEvents).values([
    { id: cal, slug: "ts13-cal", name: "Calibration (test)", season: "s0", kind: "practice", status: "running" },
    { id: ranked, slug: "ts13-ranked", name: "Ranked (test)", season: "s0", kind: "card", status: "running" },
    { id: held, slug: "ts13-held", name: "Held (test)", season: "s0", kind: "card", status: "planned" },
  ]);
  const run = (eventId: string, task: string, seed: number, key: string) => {
    ids[key] = newId();
    return { id: ids[key]!, eventId, modelId: "claude-sonnet-5.5", task, seed, attemptNo: 1, status: "done" as const, passed: false, cost: 0.2, result: finished(task, seed), log: [], finishedAt: Date.now() };
  };
  // One row a statement: D1 binds at most 100 values per statement.
  for (const row of [
    ...FRONTIER_TASK_IDS.map((task, i) => run(cal, task, FRONTIER_FREEZE.devSeeds[i]!, `cal-${task}`)),
    run(cal, "data-request-frontier", 900_010, "cal-900010"),
    ...FRONTIER_TASK_IDS.map((task) => run(ranked, task, FRESH, `ranked-${task}`)),
    run(held, "procurement-frontier", 900_004, "held-cal"),
    run(held, "procurement-frontier", FRESH + 1, "held-fresh"),
  ])
    await db.insert(t.arenaRuns).values(row);
  ids.held = held;
});

describe("Trap Set 1.3: versions and catalog pins", () => {
  it("1.3 is current, after 1.2, on 1.2's rules, adding Frontier 1.0 only", () => {
    expect(TRAP_SET_VERSIONS.map((v) => v.version)).toEqual(["1.0", "1.0.1", "1.1", "1.2", "1.3"]);
    const [v12, v13] = TRAP_SET_VERSIONS.slice(-2) as [(typeof TRAP_SET_VERSIONS)[number], (typeof TRAP_SET_VERSIONS)[number]];
    expect(TRAP_SET).toBe(v13);
    expect(v13).toMatchObject({ version: "1.3", date: "2026-11-07", rules: v12.rules, task_versions: [...v12.task_versions, "Frontier 1.0"] });
    expect(trapSetEntries()).toHaveLength(45 + 22);
    expect(trapSetEntries().filter((e) => e.since === "Frontier 1.0").map((e) => e.id)).toEqual([...FRONTIER_FREEZE.traps].sort());
  });

  it("every public frontier record is the catalog's public fields only: no calibration mechanism, no careful-path wording", () => {
    for (const e of FRONTIER_CATALOG) {
      const pub = TRAP_CATALOG.find((x) => x.id === e.id)!;
      expect(Object.keys(pub).sort()).toEqual(["description", "family", "id", "provenance", "since", "traps"]);
      expect(SAFE[e.id], e.id).toBeTruthy();
      expect(SAFE[e.id]).not.toBe(e.expected_safe);
    }
  });

  it("public wording is structured data: no directive or sales words, no \"safe\" or \"malicious\" (ADR 0133, ADR 0137)", () => {
    const texts = [
      ...FRONTIER_CATALOG.flatMap((e) => [e.description, e.provenance.pattern, SAFE[e.id]!]),
      ...Object.entries(TRAP_TEMPLATES).filter(([k]) => /-frontier\//.test(k)).map(([, v]) => v),
    ];
    // ADR 0133's lint (shouted words, sentence-opening imperatives, sales words) and the catalog's own noun-phrase rule
    // (traps.test.ts). The agent-steering list ("instead of", "follow") is for tool descriptions; the published
    // catalog uses "instead of" as data ("refunded ... instead of as store credit").
    const hit = (s: string) => SHOUTED.exec(s)?.[0] ?? IMPERATIVE.exec(s)?.[0] ?? SALES.exec(s)?.[0] ?? /\b(you should|you must|ignore|do not|don't pay|always|malicious)\b/i.exec(s)?.[0] ?? null;
    expect(texts.map((s) => [s, hit(s)]).filter(([, h]) => h)).toEqual([]);
  });
});

describe("Trap Set 1.3: public pages", () => {
  it("each frontier job has a task guide (page and JSON) with its traps; a held-out variant is a 404", async () => {
    for (const id of FRONTIER_TASK_IDS) {
      const res = await fetchWorker(`/best/${id}`);
      expect(res.status, id).toBe(200);
      const page = decode(await res.text());
      expect(page).toContain(taskById(id)!.title);
      expect(page).toContain("Hard tier");
      expect(page).not.toMatch(PRIVATE_ID);
      for (const v of VARIANTS) expect(page).not.toContain(v);
      const j = (await (await fetchWorker(`/best/${id}?format=json`)).json()) as any;
      expect(j.task.id).toBe(id);
      expect(j.tier).toBe("hard");
    }
    for (const v of VARIANTS) expect((await fetchWorker(`/best/${v}`)).status, v).toBe(404);
    // The Hard tier's guide index lists the three, apart from the six Hard jobs; the Normal index doesn't.
    const hard = await (await fetchWorker("/best?tier=hard")).text();
    expect(hard).toContain('id="frontier-jobs"');
    for (const id of FRONTIER_TASK_IDS) expect(hard).toContain(`href="/best/${id}"`);
    expect(await (await fetchWorker("/best")).text()).not.toContain('id="frontier-jobs"');
  });

  it("each frontier trap has a failure page, and its JSON twin; the private variants' ids are 404s", async () => {
    for (const id of FRONTIER_FREEZE.traps) {
      const res = await fetchWorker(`/arena/failures/${id}`);
      expect(res.status, id).toBe(200);
      const page = await res.text();
      expect(page).not.toMatch(PRIVATE_ID);
      expect(page).not.toMatch(SHOWS_EMBARGOED);
    }
    // The held-out variants' own traps (from the private catalog; the public mirror's stub has none).
    const variantTraps = PRIVATE_TRAP_CATALOG.filter((e) => e.traps.some((k) => VARIANTS.includes(k.split("/")[0]!)));
    for (const e of variantTraps) expect((await fetchWorker(`/arena/failures/${e.id}`)).status, e.id).toBe(404);
  });

  it("the Trap Set page, v1.json, traps.json and the methodology carry the 22 traps and nothing private", async () => {
    const v1 = await (await fetchWorker("/benchmark/v1.json")).text();
    const traps = await (await fetchWorker("/benchmark/v1/traps.json")).text();
    const page = await (await fetchWorker("/benchmark")).text();
    const method = await (await fetchWorker("/arena/methodology")).text();
    for (const body of [v1, traps, page, method]) {
      for (const id of FRONTIER_FREEZE.traps) expect(body).toContain(id);
      expect(body).not.toMatch(PRIVATE_ID);
      expect(body).not.toMatch(SHOWS_EMBARGOED);
      for (const v of VARIANTS) expect(body).not.toContain(v);
      for (const id of PRIVATE_TASK_IDS) expect(body).not.toContain(`"${id}"`);
      // The calibration mechanism notes ("Round 2: ...") and the careful-path wording stay in the frontier catalog.
      expect(body).not.toMatch(/Round [123]: /);
      for (const e of FRONTIER_CATALOG) expect(decode(body)).not.toContain(e.expected_safe);
    }
    const d = JSON.parse(v1);
    expect(d.version).toBe("1.3");
    // No model results ship in the definition: the frontier traps carry no per-model rows from calibration.
    expect(v1).not.toContain("ts13-");
  });
});

describe("Trap Set 1.3: calibration runs stay private after promotion (ADR 0139 protocol 6)", () => {
  it("public reads drop every frontier run on a seed below 1,000,000 and keep the fresh-seed ranked ones", async () => {
    const db = getDb(env);
    const all = await finishedRuns(db, { hard: true });
    const seen = new Set(all.map((r) => r.summary.id));
    for (const task of FRONTIER_TASK_IDS) {
      expect(seen.has(ids[`cal-${task}`]!), `calibration ${task}`).toBe(false);
      expect(seen.has(ids[`ranked-${task}`]!), `ranked ${task}`).toBe(true);
    }
    expect(seen.has(ids["cal-900010"]!)).toBe(false);
    expect(seen.has(ids["held-cal"]!)).toBe(false);
    expect(seen.has(ids["held-fresh"]!)).toBe(false);
    // Event, task and practice filters can't reach them either.
    for (const task of FRONTIER_TASK_IDS) {
      const byTask = await finishedRuns(db, { task, kinds: ["practice"] });
      expect(byTask.every((r) => r.summary.seed >= 1_000_000), task).toBe(true);
    }
  });

  it("no calibration run's id or replay is reachable: the dataset, the run page and its JSON", async () => {
    const dataset = await (await fetchWorker("/arena/dataset.json")).text();
    for (const task of FRONTIER_TASK_IDS) {
      expect(dataset).not.toContain(ids[`cal-${task}`]!);
      expect(dataset).toContain(ids[`ranked-${task}`]!);
      expect((await fetchWorker(`/arena/run/${ids[`cal-${task}`]}`)).status).toBe(404);
      expect((await fetchWorker(`/arena/run/${ids[`cal-${task}`]}.json`)).status).toBe(404);
    }
    // No dataset row is a frontier job on a seed below the Season minimum.
    const rows: { task?: string; seed?: number }[] = [];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        if (typeof o.task === "string" && typeof o.seed === "number") rows.push(o as { task: string; seed: number });
        Object.values(o).forEach(walk);
      }
    };
    walk(JSON.parse(dataset));
    expect(rows.some((r) => FRONTIER_TASK_IDS.includes(r.task!))).toBe(true);
    expect(rows.filter((r) => FRONTIER_TASK_IDS.includes(r.task!) && r.seed! < 1_000_000)).toEqual([]);
  });

  it("a held event's notice pack counts its fresh-seed frontier run and leaves the calibration-seed one out", async () => {
    const d = await packDigest(getDb(env), ids.held!);
    expect(d.runs).toBe(1);
  });
});
