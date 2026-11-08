import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { FRONTIER_PUBLIC_TASKS, TRAP_CATALOG } from "@forge/arena";
import { inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CORRECTIONS } from "../src/arena/corrections";
import { errorRecord, fullRescoreText, publicUnfaithfulRuns, REFEREE_AUDIT, REFEREE_AUDIT_2 } from "../src/arena/error-record";
import { entriesFor, parseFailTier } from "../src/arena/failures";
import { FRONTIER_LABEL } from "../src/arena/terms";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import worker from "../src/index";

// Scope addition to the 7 Nov diligence fixes (Dinike, 20:23 Colombo): the Frontier task guides, one name for the
// Frontier jobs, the error record tied to referee audit 2, the 10 unfaithful runs named, and (edge-cache.test.ts) a
// release that never serves the previous release's pages.

const RELEASED = { ...env, VALIDITY_PUBLIC: "on" } as Env;
let ip = 0;
async function get(path: string) {
  const ctx = createExecutionContext();
  const sep = path.includes("?") ? "&" : "?";
  const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}${sep}nc=${Date.now()}-${ip}`, { headers: { Accept: "text/html", "CF-Connecting-IP": `198.51.100.${(ip++ % 200) + 1}` } }) as never, RELEASED, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const text = async (path: string) => (await (await get(path)).text()).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const FRONTIER_TRAPS = TRAP_CATALOG.filter((e) => e.since === "Frontier 1.0");
const UNFAITHFUL = CORRECTIONS.find((c) => c.id === "2026-11-rules-0.7-payee-claims")!.unfaithfulRuns!;

describe("A: the three Frontier task guides", () => {
  it("say what the Frontier jobs are, that they're ranked since Trap Set 1.3, with no boilerplate, self-link, 'vacant' or 'round 3'", async () => {
    expect(FRONTIER_PUBLIC_TASKS.map((x) => x.id).sort()).toEqual(["data-request-frontier", "payroll-change-frontier", "procurement-frontier"].sort());
    for (const task of FRONTIER_PUBLIC_TASKS) {
      expect(task.summary, task.id).not.toContain("round 3");
      const page = await text(`/best/${task.id}`);
      expect(page, task.id).toContain(`Task guide · ${FRONTIER_LABEL}`);
      // Boardy, 7 Nov: no Frontier run of any kind is published in this file's database, so none is promised.
      expect(page).toContain("ranked since Trap Set 1.3; no ranked or practice runs published yet");
      expect(page).not.toContain("so practice runs are shown");
      expect(page).toContain("Three long desk jobs (data requests, payroll changes, purchasing approvals)");
      expect(page).toContain('href="/arena/failures?tier=frontier"');
      for (const gone of ["The same six jobs at real-world volume", "Normal version", ">vacant<", "(round 3)", "practice data only (not ranked)", `href="/best/${task.id}">`])
        expect(page, `${task.id}: ${gone}`).not.toContain(gone);
      expect(page).toContain("no title holder yet");
    }
  });

  it("a Hard job that scales up a Normal one keeps its Normal version link", async () => {
    const page = await text("/best/refund-hard3");
    expect(page).toContain("The same six jobs at real-world volume");
    expect(page).toContain('<a href="/best/refund">Normal version</a>');
  });
});

describe("B: one name for the Frontier jobs, and a way to reach them from the trap pages", () => {
  it("a Frontier filter under the trap board, listing only the Frontier traps", async () => {
    expect(parseFailTier("frontier")).toBe("frontier");
    expect(entriesFor("frontier").map((e) => e.id).sort()).toEqual(FRONTIER_TRAPS.map((e) => e.id).sort());
    const board = await text("/arena/failures");
    expect(board).toContain(`href="/arena/failures?tier=frontier"`);
    expect(board).toContain(FRONTIER_LABEL);
    const f = await text("/arena/failures?tier=frontier");
    for (const e of FRONTIER_TRAPS.slice(0, 3)) expect(f).toContain(`id="${e.id}"`);
    expect(f).not.toContain(`id="${TRAP_CATALOG.find((e) => e.since === "Normal 1.0")!.id}"`);
  });

  it("a Frontier trap's 'Since Frontier 1.0' links to the Frontier filter, named the same way", async () => {
    const page = await text(`/arena/failures/${FRONTIER_TRAPS[0]!.id}`);
    expect(page).toContain(`<dt>Since</dt><dd><a href="/arena/failures?tier=frontier">Frontier 1.0</a> <span class="muted">(${FRONTIER_LABEL})</span></dd>`);
  });

  it("the methodology and /best?tier=hard use the same name", async () => {
    expect(await text("/arena/methodology")).toContain(`<b>${FRONTIER_LABEL} (task version Frontier 1.0).</b>`);
    expect(await text("/best?tier=hard")).toContain(`<h2 id="h-frontier">${FRONTIER_LABEL} (task version Frontier 1.0)</h2>`);
  });
});

describe("C: the error record and trap lines read from referee audit 2", () => {
  it("section 3 opens with audit 2's own counts, computed from its file", async () => {
    const page = await text("/benchmark/validity");
    const o = REFEREE_AUDIT_2.overall;
    expect(page).toContain(`It is shown only together with referee audit 2 above (${REFEREE_AUDIT_2.date}: ${o.agree.toLocaleString("en-US")} of ${o.n.toLocaleString("en-US")} verdicts agreed, every one of the ${REFEREE_AUDIT_2.sample.runs.toLocaleString("en-US")} public ranked replays checked)`);
    expect(page).not.toContain(`${REFEREE_AUDIT.sample.runs} replays sampled), so it reads as a measured error rate`);
  });

  it("a trap with no ranked public run is described against audit 2's frame (every ranked public replay)", async () => {
    const trap = FRONTIER_TRAPS[0]!.id;
    expect(REFEREE_AUDIT_2.per_public_trap.some((r) => r.public_trap_id === trap)).toBe(false);
    const page = await text(`/arena/failures/${trap}`);
    expect(page).toContain(`Not in referee audit 2 (${REFEREE_AUDIT_2.date}), which checked every ranked public replay: no ranked public run of its job versions had been played by then.`);
    expect(page).not.toContain("Not in referee audit 1's sample");
  });

  it("a trap in audit 2 shows audit 2's line, not a sample's", async () => {
    const row = REFEREE_AUDIT_2.per_public_trap.find((r) => r.n > 0)!;
    const page = await text(`/arena/failures/${row.public_trap_id}`);
    expect(page).toContain(`Referee audit 2 (${REFEREE_AUDIT_2.date}): an independent checker agreed with the published verdict on ${row.agree} of ${row.n} verdicts for this trap, every ranked public replay`);
  });
});

describe("D: the 10 runs the rules 0.7 re-score couldn't replay are named", () => {
  it("the correction holds the apply report's 10, matching its count", () => {
    const c = CORRECTIONS.find((x) => x.id === "2026-11-rules-0.7-payee-claims")!;
    expect(UNFAITHFUL).toHaveLength(c.counts!.unfaithful);
    expect(UNFAITHFUL.map((u) => u.id.slice(0, 8))).toEqual(["1ca16364", "3f74cdce", "5fdfdd15", "6fe0be15", "80223f1c", "d3b3d2b8", "d4663bd4", "d4d5682b", "ecb6eaca", "ee1456ed"]);
  });

  it("names each public one with model, job and why; a run that isn't public is counted, not named", async () => {
    const c = CORRECTIONS.find((x) => x.id === "2026-11-rules-0.7-payee-claims")!;
    const db = getDb(env);
    const ev = { id: "ev-unfaithful", slug: "unfaithful-test", name: "Unfaithful", season: "test", kind: "card", status: "done", createdAt: Date.now() };
    const held = { ...ev, id: "ev-unfaithful-held", slug: "unfaithful-held", status: "planned" };
    await db.insert(t.arenaEvents).values([ev, held] as never).onConflictDoNothing();
    // One at a time: D1 allows 100 bound parameters a statement.
    for (const [i, u] of UNFAITHFUL.entries())
      await db.insert(t.arenaRuns).values({ id: u.id, eventId: i === 9 ? held.id : ev.id, modelId: u.model, task: u.task, seed: 10 + i, attemptNo: 1, status: "done", cost: 0.01, tokens: 1, finishedAt: Date.UTC(2026, 9, 20) } as never).onConflictDoNothing();
    const pub = await publicUnfaithfulRuns(db, c);
    expect(pub.map((u) => u.id)).toEqual(UNFAITHFUL.slice(0, 9).map((u) => u.id));
    const line = fullRescoreText(c, pub);
    expect(line).toContain("10 more couldn't be replayed exactly (the job changed since they ran) and weren't re-scored: Mistral Large 4 on ");
    expect(line).toContain("(1ca16364)");
    expect(line).toContain("; 1 more is not a public run. Each keeps the verdict it was played with.");
    expect(line).not.toContain("ee1456ed");
    const { entries } = await errorRecord(db, env.PUBLIC_ORIGIN);
    const e = entries.find((x) => x.kind === "rescore_applied" && x.title.includes("rules 0.7"))!;
    expect(e.what).toContain("(d4d5682b)");
    for (const u of pub) expect(e.runs).toContain(`${env.PUBLIC_ORIGIN}/arena/run/${u.id}`);
    expect(e.runs).not.toContain(`${env.PUBLIC_ORIGIN}/arena/run/${UNFAITHFUL[9]!.id}`);
    // Leave no seeded run behind for other tests in this file's isolate.
    await db.delete(t.arenaRuns).where(inArray(t.arenaRuns.id, UNFAITHFUL.map((u) => u.id)));
  });
});
