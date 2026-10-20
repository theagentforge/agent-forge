import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { duelFromRuns, gauntletClipId } from "../src/arena/featured";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { fetchWorker } from "./helpers";
import "../src/index";
// @ts-expect-error plain browser module, no types
import { renderSound, soundEvents, wavBytes } from "../public/gauntlet-sound.js";

// ADR 0029 §clips and §sound: the 9:16 Gauntlet clip page, the pending list for the clips workflow, and the
// soundtrack (synthesised, deterministic, muted by default on the site).

const MODEL_WORDS = "Paid everything in full, trust me";

function result(fell: string[], passed: boolean) {
  const a = new Attempt(taskById("scam-invoice")!, 2_000_002);
  a.recordTurn({ tokensIn: 800, tokensOut: 60, cost: 0.001, latencyMs: 900, text: MODEL_WORDS });
  a.call("list_emails", {});
  a.call("list_vendors", {});
  a.call("finish", { status: "done", summary: MODEL_WORDS });
  const base = a.end("finished");
  return { result: { ...base, passed, traps: base.traps.map((x) => ({ ...x, triggered: fell.includes(x.id) })) } as AttemptResult, log: a.log };
}

const ids: Record<string, string> = {};
let eventId = "";

async function addRun(key: string, model: string, run: ReturnType<typeof result>, o: { seed?: number; event?: string } = {}) {
  const db = getDb(env);
  const id = crypto.randomUUID();
  const signature = await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(run.log) });
  await db.insert(t.arenaRuns).values({
    id, eventId: o.event ?? eventId, modelId: model, task: "scam-invoice", seed: o.seed ?? 2_000_002, attemptNo: 1, status: "done",
    passed: run.result.passed, score: 0.5, cost: 0.01, tokens: 1000, result: run.result, log: run.log, signature, finishedAt: Date.now() - 60_000,
  });
  ids[key] = id;
}

beforeAll(async () => {
  const db = getDb(env);
  eventId = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: eventId, slug: `gxclip-${eventId.slice(0, 6)}`, name: "Crucible 1", season: "s0", kind: "practice", status: "done" });
  const other = crypto.randomUUID();
  await db.insert(t.arenaEvents).values({ id: other, slug: `gxclip-${other.slice(0, 6)}`, name: "Crucible 2", season: "s0", kind: "practice", status: "done" });
  await addRun("fell", "claude-sonnet-5.5", result(["paid_scam"], false));
  await addRun("caught", "gpt-5.5", result([], true));
  await addRun("otherSeed", "gpt-5.5", result([], true), { seed: 3 });
  await addRun("otherEvent", "gpt-5.5", result([], true), { event: other });
});

describe("pairing two runs into a Gauntlet", () => {
  it("only pairs runs of the same task, seed, attempt and event", async () => {
    const db = getDb(env);
    const d = await duelFromRuns(db, ids.fell!, ids.caught!);
    expect(d?.gauntlet?.lanes).toHaveLength(2);
    expect(await duelFromRuns(db, ids.fell!, ids.fell!)).toBeNull();
    expect(await duelFromRuns(db, ids.fell!, ids.otherSeed!)).toBeNull();
    expect(await duelFromRuns(db, ids.fell!, ids.otherEvent!)).toBeNull();
    expect(await duelFromRuns(db, ids.fell!, crypto.randomUUID())).toBeNull();
  });

  it("names the clip gx-<first 8 of a>-<first 8 of b>, which the clip index accepts", () => {
    const id = gauntletClipId(ids.fell!, ids.caught!);
    expect(id).toBe(`gx-${ids.fell!.slice(0, 8)}-${ids.caught!.slice(0, 8)}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("the Gauntlet clip page", () => {
  it("is a 1080×1920 noindex page in clip mode, with the finished frame drawn and nothing the model wrote", async () => {
    const res = await fetchWorker(`/arena/gauntlet/${ids.fell}/${ids.caught}/clip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");
    const body = await res.text();
    expect(body).toContain('<meta name="viewport" content="width=1080, height=1920, initial-scale=1">');
    expect(body).toContain('data-mode="clip"');
    expect(body).toMatch(/data-clip-seconds="\d+(\.\d+)?"/);
    expect(body).toContain("<svg");
    expect(body).toContain('src="/gauntlet.js"');
    expect(body).not.toContain("trust me");
  });

  it("is 404 for runs that can't be paired", async () => {
    expect((await fetchWorker(`/arena/gauntlet/${ids.fell}/${ids.otherSeed}/clip`)).status).toBe(404);
    expect((await fetchWorker(`/arena/gauntlet/${ids.fell}/nope/clip`)).status).toBe(404);
  });

  it("pending.json lists structured data only, with valid ids", async () => {
    const res = await fetchWorker("/arena/gauntlet/pending.json");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { clip_seconds: number; pending: { id: string; a: string; b: string; clip_page: string }[] };
    expect(data.clip_seconds).toBeGreaterThanOrEqual(15);
    for (const p of data.pending) {
      expect(p.id).toBe(gauntletClipId(p.a, p.b));
      expect(p.clip_page).toBe(`/arena/gauntlet/${p.a}/${p.b}/clip`);
    }
  });
});

describe("the sound", () => {
  it("starts muted on the site, with a button to turn it on", async () => {
    const body = await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();
    if (body.includes('<figure class="gx"')) {
      expect(body).toMatch(/<button[^>]*data-gx-sound[^>]*aria-pressed="false"/);
      expect(body).toContain("Sound off");
    }
  });

  it("is deterministic, cues the trap, the verdict and both lanes, and stays quiet", async () => {
    const d = (await duelFromRuns(getDb(env), ids.fell!, ids.caught!))!;
    const g = d.gauntlet!;
    const kinds = soundEvents(g).map((e: { kind: string }) => e.kind);
    expect(kinds).toContain("step");
    expect(kinds).toContain("checking");
    expect(kinds).toContain("aww"); // the robot that fell
    expect(kinds).toContain("tada"); // the one that caught the trap
    const a = renderSound(g, { sr: 8000 });
    const b = renderSound(g, { sr: 8000 });
    expect(a.length).toBe(b.length);
    let same = true;
    let peak = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) same = false;
      peak = Math.max(peak, Math.abs(a[i]));
    }
    expect(same).toBe(true);
    expect(20 * Math.log10(peak)).toBeCloseTo(-18, 1);
    const wav = wavBytes(renderSound(g, { sr: 8000, peakDb: -3 }), 8000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
  });

  it("uses no randomness and no sample files", async () => {
    const js = (await import("../public/gauntlet-sound.js?raw")).default as string;
    expect(js).not.toContain("Math.random");
    expect(js).not.toMatch(/\.(mp3|wav|ogg)["']/);
  });
});

describe("share cards in the Gauntlet look", () => {
  it("the launch report has its own card with the Skill Watch robot, and its page links it", async () => {
    const res = await fetchWorker("/og/reports/skill-scan-2026-10.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    const page = await (await fetchWorker("/reports/skill-scan-2026-10", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain('<meta property="og:image" content="https://theagentforge.io/og/reports/skill-scan-2026-10.png">');
  });

  it("the robot alone has no text and no randomness, in each mood", async () => {
    const { robotSvg } = await import("../public/gauntlet.js");
    for (const mood of ["pass", "fell", "alert"] as const) {
      const svg = robotSvg(mood, 100) as string;
      expect(svg).toMatch(/^<svg viewBox="0 0 16 16"/);
      expect(svg).not.toContain("<text");
      expect(robotSvg(mood, 100)).toBe(svg);
    }
  });
});
