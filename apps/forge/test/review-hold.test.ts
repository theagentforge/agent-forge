import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { arenaStatus } from "../src/arena/status";
import { eventCard, finishedRuns, runWithLog } from "../src/arena/views";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0021 amendment 2: every fail is checked in the log before it's published. A ranked event is created with
// status "planned" (held): its runs are played and stored, but no public surface reads them until the review is done
// and the status becomes "running".

const SLUG = "crucible-hold-test";
let eventId = "";
let runId = "";

beforeAll(async () => {
  const db = getDb(env);
  eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: SLUG, name: "Crucible hold test", season: "s0", kind: "card", status: "planned" });
  const a = new Attempt(taskById("refund-hard3")!, 1_000_009);
  a.recordTurn({ tokensIn: 900, tokensOut: 50, cost: 0.002, latencyMs: 800, text: "done" });
  a.call("finish", { status: "done", summary: "done" });
  const result = a.end("finished") as AttemptResult;
  runId = crypto.randomUUID();
  await db.insert(t.arenaRuns).values({
    id: runId, eventId, modelId: "gpt-6.1-sol", task: "refund-hard3", seed: 1_000_009, attemptNo: 1, status: "done", passed: result.passed, score: 0.4, cost: 0.1, tokens: 1000,
    result, log: a.log, signature: await signReport(env.REPORT_SIGNING_KEY, { id: runId, log: JSON.stringify(a.log) }), finishedAt: Date.now() - 60_000,
  });
});

describe("a ranked event held for review", () => {
  it("stays off every public surface while held", async () => {
    const db = getDb(env);
    expect((await finishedRuns(db, { hard: true })).some((r) => r.summary.id === runId)).toBe(false);
    expect(await runWithLog(db, runId)).toBeNull();
    expect(await eventCard(db, SLUG)).toBeNull();
    expect((await fetchWorker(`/arena/run/${runId}`)).status).toBe(404);
    expect((await fetchWorker(`/arena/event/${SLUG}`)).status).toBe(404);
    expect(JSON.stringify(await arenaStatus(env))).not.toContain(SLUG);
    expect(await (await fetchWorker("/arena?tier=hard")).text()).not.toContain(runId);
    // Business agent reliability (K3) and its report count nothing from a held event.
    const biz = (await (await fetchWorker("/arena/business?tier=hard&format=json")).json()) as { attempts: number; events: { slug: string }[] };
    expect(biz.attempts).toBe(0);
    expect(biz.events.map((e) => e.slug)).not.toContain(SLUG);
    expect(await (await fetchWorker("/arena/business.csv?tier=hard")).text()).not.toContain(runId);
  });

  it("is published by setting its status to running, with no other change", async () => {
    const db = getDb(env);
    await db.update(t.arenaEvents).set({ status: "running" }).where(eq(t.arenaEvents.id, eventId));
    expect((await finishedRuns(db, { hard: true })).some((r) => r.summary.id === runId)).toBe(true);
    expect(await runWithLog(db, runId)).not.toBeNull();
    expect((await eventCard(db, SLUG))?.runs.map((r) => r.id)).toContain(runId);
    expect((await fetchWorker(`/arena/run/${runId}`)).status).toBe(200);
    // A fresh URL: the held-state answer above is edge-cached for a minute.
    const biz = (await (await fetchWorker("/arena/business?tier=all&format=json")).json()) as { attempts: number; events: { slug: string }[] };
    expect(biz.events.map((e) => e.slug)).toContain(SLUG);
  });
});
