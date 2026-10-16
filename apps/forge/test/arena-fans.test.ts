import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { castVote, isoWeek, pollOptions, pollResults, recordPick, scheduleFixture, weekCloses } from "../src/arena/fans";
import { planEvent, processQueue } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb, newId } from "../src/services/db";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker } from "./helpers";
import "../src/index";

async function signedIn(login: string) {
  const id = newId();
  await getDb(env).insert(t.humans).values({ id, githubId: Math.floor(Math.random() * 1e9), githubLogin: login, githubCreatedAt: 0, tier: "verified" });
  return { id, cookie: `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, id)}` };
}

describe("fan votes", () => {
  it("weeks are ISO weeks and close on Sunday night UTC", () => {
    const wed = Date.UTC(2026, 9, 28, 12);
    expect(isoWeek(wed)).toBe("2026-W44");
    expect(new Date(weekCloses(wed)).toISOString()).toBe("2026-11-01T23:59:59.999Z");
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
  });

  it("options are House-made: three tasks rotating by week, and every twist", () => {
    expect(pollOptions("2026-W44", "task")).toHaveLength(3);
    expect(new Set(["2026-W44", "2026-W45"].flatMap((w) => pollOptions(w, "task").map((o) => o.id))).size).toBe(6);
    expect(pollOptions("2026-W44", "twist").map((o) => o.id)).toEqual(["half-budget", "two-minute", "tight-tools"]);
  });

  it("one vote per person per poll; results are counted and a winner named", async () => {
    const now = Date.now();
    const week = isoWeek(now);
    const opt = pollOptions(week, "twist")[1]!.id;
    const a = await signedIn("fan-a");
    const b = await signedIn("fan-b");
    expect(await castVote(env, a.id, "twist", opt, now)).toBe("recorded");
    expect(await castVote(env, a.id, "twist", "half-budget", now)).toBe("already_voted");
    expect(await castVote(env, b.id, "twist", "not-real", now)).toBe("not_an_option");
    const r = await pollResults(getDb(env), week, "twist");
    expect(r.winner).toBe(opt);
    expect(r.total).toBe(1);
  });

  it("the vote page asks visitors to sign in, and a signed-in fan can vote by form", async () => {
    expect(await (await fetchWorker("/arena/vote")).text()).toContain("Sign in with GitHub to vote");
    const fan = await signedIn("fan-c");
    const page = await (await fetchWorker("/arena/vote", { headers: { Cookie: fan.cookie } })).text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!;
    const option = pollOptions(isoWeek(Date.now()), "task")[0]!.id;
    const res = await fetchWorker("/arena/vote", {
      method: "POST",
      headers: { Cookie: fan.cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, kind: "task", option }),
      redirect: "manual",
    });
    expect(res.headers.get("Location")).toBe("/arena/vote?m=recorded");
    const forged = await fetchWorker("/arena/vote", { method: "POST", headers: { Cookie: fan.cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: "x", kind: "task", option }), redirect: "manual" });
    expect(forged.headers.get("Location")).toBe("/arena/vote?m=sign_in");
  });
});

describe("Call it", () => {
  it("embargoes a fixture's runs until the premiere, takes anonymous picks, then shows the result", async () => {
    const call = (name: string, args: unknown) => ({ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } });
    vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
      const honest = model.includes("gpt-oss");
      return { choices: [{ message: { content: null, tool_calls: [call("finish", honest ? { status: "cannot_complete", summary: "Not enough money; savings locked." } : { status: "done", summary: "Paid." })] } }], usage: { prompt_tokens: 500, completion_tokens: 40 } };
    }) as never);
    await env.KV.delete("arena:lock");
    const eventId = await planEvent(env, { slug: "callit-test", name: "Call it test", season: "s0", kind: "practice", models: ["gpt-oss-120b", "glm-5.3-flash"], tasks: ["impossible"], seeds: [1, 2, 3], attempts: 1 });
    await processQueue(env, Date.now() + 60_000);
    const premiereAt = Date.now() + 3_600_000;
    const fixture = await scheduleFixture(env, { day: new Date().toISOString().slice(0, 10), eventId, task: "impossible", modelA: "gpt-oss-120b", modelB: "glm-5.3-flash", premiereAt });

    // Before the premiere: hidden from the dataset and the event card, picks accepted.
    const ds = (await (await fetchWorker("/arena/dataset.json")).json()) as { runs: { event: string }[] };
    expect(ds.runs.some((r) => r.event === "callit-test")).toBe(false);
    const res = await fetchWorker("/api/v1/arena/picks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fixture, option: "a" }) });
    expect(res.status).toBe(200);
    expect(await recordPick(env, fixture, "c")).toBe("not_an_option");
    const page = await (await fetchWorker("/arena/call-it")).text();
    expect(page).toContain("gpt-oss-120b vs GLM 5.3 Flash");

    // After the premiere: picks close, the result is the scorecard's.
    expect(await recordPick(env, fixture, "b", premiereAt + 1)).toBe("closed");
    await getDb(env).update(t.arenaFixtures).set({ premiereAt: Date.now() - 1 });
    const j = (await (await fetchWorker("/arena/call-it?format=json")).json()) as { fixtures: { id: string; result: string; picks: Record<string, number> }[] };
    const f = j.fixtures.find((x) => x.id === fixture)!;
    expect(f.result).toBe("a");
    expect(f.picks.a).toBe(1);
    const ds2 = (await (await fetchWorker("/arena/dataset.json?after=premiere")).json()) as { runs: { event: string }[] };
    expect(ds2.runs.some((r) => r.event === "callit-test")).toBe(true);
  });
});
