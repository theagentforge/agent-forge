import { RULES_VERSION, TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { claimRun, setClaimHidden } from "../src/arena/gauntlet-claims";
import { gauntletRules, gauntletScore, isExpired, SCORE_BADGE_TTL_DAYS, scoreBadge, TRAP_SET, TRAP_SET_NAME, trapSetVersionOf } from "../src/arena/score";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { connectApprovedAgent, fetchWorker } from "./helpers";
import { VERIFY_CLI_VERSION } from "../src/web/replay-verify";
import "../src/index";

// ADR 0069 (W2.3, W2.4): the Gauntlet score page, its JSON and the score badge exist only for a finished run its
// owner claimed and shows. Unclaimed and hidden runs answer 404 everywhere; the badge greys out after 90 days.

const DAY = 86_400_000;
let ipN = 40;
const nextIp = () => `198.51.100.${ipN++}`;
const startHttp = async (ip: string) =>
  (await (await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: "{}" })).json()) as { gauntlet_id: string; claim_key: string };
const parse = async (res: Response) => {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result.structuredContent;
};
const act = async (id: string, ip: string) =>
  parse(
    await fetchWorker("/mcp/gauntlet", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: new URL(env.PUBLIC_ORIGIN).host, "CF-Connecting-IP": ip },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gauntlet_act", arguments: { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } } } }),
    }),
  );
async function finishedRun() {
  const ip = nextIp();
  const start = await startHttp(ip);
  for (let i = 0; i < TASKS.length; i++) await act(start.gauntlet_id, ip);
  return start;
}
const get = (path: string, accept = "text/html") => fetchWorker(path, { headers: { Accept: accept } });
async function finishedChallenge(of: string) {
  const ip = nextIp();
  const start = (await (
    await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ challenge: of }) })
  ).json()) as { gauntlet_id: string; claim_key: string };
  for (let i = 0; i < TASKS.length; i++) await act(start.gauntlet_id, ip);
  return start;
}

describe("Gauntlet score page and badge (ADR 0069)", () => {
  it("has no score page or badge until the run is claimed, and none again once it's hidden", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const id = run.gauntlet_id;
    for (const p of [`/score/${id}`, `/score/${id}.json`, `/badge/score/${id}.svg`, `/badge/score/${id}.json`]) expect((await get(p)).status).toBe(404);

    const claim = await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    expect(claim.ok).toBe(true);

    const page = await get(`/score/${id}`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain(owner.agent.handle);
    expect(body).toContain(`https://github.com/${owner.human.githubLogin}`);
    expect(body).toContain(`${TRAP_SET_NAME}</a> v${TRAP_SET.version}`);
    expect(body).toContain('href="/benchmark"');
    expect(body).toContain(RULES_VERSION);
    expect(body).toContain("How the score is computed");
    expect(body).toContain('href="/methodology#replays"');
    expect(body).toContain(`/gauntlet/r/${id}`);
    expect(body).not.toMatch(/Forge Score:/);

    const j = (await (await get(`/score/${id}.json`, "application/json")).json()) as any;
    expect(j).toMatchObject({
      gauntlet_id: id,
      agent: { handle: owner.agent.handle },
      owner: { github: owner.human.githubLogin, counts_as: "third_party" },
      model: null,
      model_stated: false,
      benchmark: { name: "The Forge Trap Set", version: TRAP_SET.version },
      task_version: "Normal 1.0",
      rules_version: RULES_VERSION,
      rules_version_from: "stamp",
      gauntlet_score: { jobs_total: 6 },
      expired: false,
      verify: { replays_kept: true, keys_url: expect.stringContaining("/.well-known/forge-keys.json"), forge_verify: { cli_version: VERIFY_CLI_VERSION } },
    });
    // Replay format v2 (ADR 0066): every job of a new run is sealed, with a downloadable JSON and a verify command.
    for (const job of j.jobs) {
      expect(job.replay_format).toBe("v2");
      expect(job.replay_json_url).toMatch(new RegExp(`/gauntlet/r/${id}/${job.job}\\.json$`));
      expect(job.verify_command).toContain(`verify ${job.replay_json_url}`);
    }
    expect(body).toContain("hash-chained and signed");
    expect(body).toContain(`verify ${j.jobs[0].replay_json_url}`);
    const sealed = (await (await get(j.jobs[0].replay_json_url.replace(env.PUBLIC_ORIGIN, ""), "application/json")).json()) as any;
    expect(JSON.stringify(sealed)).toContain("forge-replay/2");
    // Public trap ids only, and the JSON is data: no instruction fields.
    for (const p of j.fell_for) expect(p).toMatch(/^FA-[A-Z]{3}-0\d\d$/);
    expect(j).not.toHaveProperty("next");

    const svg = await get(`/badge/score/${id}.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toContain("image/svg+xml");
    const text = await svg.text();
    expect(text).toContain("Gauntlet score");
    expect(text).toContain(new Date().toISOString().slice(0, 10));
    expect(text).toContain("Trap Set v1.0");
    expect(text).not.toContain("expired");
    const shield = (await (await get(`/badge/score/${id}.json`)).json()) as any;
    expect(shield).toMatchObject({ schemaVersion: 1, label: "Gauntlet score" });

    // /scores/recent.json and /benchmark point at the score page and the submit page.
    const recent = (await (await get("/scores/recent.json", "application/json")).json()) as any;
    expect(recent.runs.find((r: any) => r.gauntlet_id === id)?.score_url).toBe(`${env.PUBLIC_ORIGIN}/score/${id}`);
    expect(await (await get("/benchmark")).text()).toContain('href="/benchmark/submit"');

    // The report page links to the score page while the run is shown.
    expect(await (await get(`/gauntlet/r/${id}`)).text()).toContain(`/score/${id}`);

    await setClaimHidden(env, owner.human.id, id, true);
    for (const p of [`/score/${id}`, `/score/${id}.json`, `/badge/score/${id}.svg`, `/badge/score/${id}.json`]) expect((await get(p)).status).toBe(404);
    expect(await (await get(`/gauntlet/r/${id}`)).text()).not.toContain(`/score/${id}`);
  });

  it("greys the badge out as expired after 90 days; the page stays and says so", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const id = run.gauntlet_id;
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    const old = Date.now() - (SCORE_BADGE_TTL_DAYS + 1) * DAY;
    await getDb(env).update(t.arenaGauntlets).set({ startedAt: old, finishedAt: old }).where(eq(t.arenaGauntlets.id, id));
    const s = (await gauntletScore(env, id))!;
    expect(s.expired).toBe(true);
    expect(s.verify.replays_kept).toBe(false);
    expect(s.jobs.every((j) => j.replay_url === null)).toBe(true);
    const b = scoreBadge(s);
    expect(b.message).toContain("expired");
    expect(b.color).toBe("#5b6573");
    expect(await (await get(`/badge/score/${id}.svg`)).text()).toContain("expired");
    const page = await (await get(`/score/${id}`)).text();
    expect(page).toContain(`more than ${SCORE_BADGE_TTL_DAYS} days old`);
    expect(isExpired(Date.now() - 89 * DAY)).toBe(false);
  });

  it("labels a House owner's run as ours, and a run under older rules as before Trap Set v1.0", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const id = run.gauntlet_id;
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, owner.human.id));
    const s = (await gauntletScore(env, id))!;
    expect(s.owner.counts_as).toBe("ours");
    expect(trapSetVersionOf("rules 0.6", "Normal 1.0")).toBe("1.0.1");
    expect(trapSetVersionOf("rules 0.5", "Normal 1.0")).toBeNull();
    const old = scoreBadge({ ...s, benchmark: { ...s.benchmark, version: null } });
    expect(old.message).toContain("before Trap Set v1.0");
    expect(old.message).not.toContain("Trap Set v1.0 ");
  });

  it("never scores a run of a revoked agent, a bad id or an unfinished run", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    await getDb(env).update(t.agents).set({ status: "revoked" }).where(eq(t.agents.id, owner.agent.id));
    expect(await gauntletScore(env, run.gauntlet_id)).toBeNull();
    expect((await get(`/score/${run.gauntlet_id}`)).status).toBe(404);
    expect((await get("/score/not-an-id")).status).toBe(404);
    expect((await get("/badge/score/../x.svg")).status).toBe(404);
    const open = await startHttp(nextIp());
    expect(await gauntletScore(env, open.gauntlet_id)).toBeNull();
  });

  it("reads the rules from the stamp, or from the finish date for older runs", () => {
    expect(gauntletRules([{ rules: "rules 0.5" }], Date.now())).toEqual({ version: "rules 0.5", from: "stamp" });
    expect(gauntletRules([null, {}], Date.parse("2026-10-20T00:00:00Z"))).toEqual({ version: "rules 0.4", from: "finish_date" });
    // An unstamped (or unknown-stamp) result was scored by pre-0.6 code, so it is never labelled 0.6, whatever the date.
    expect(gauntletRules([{ rules: "made up" }], Date.parse("2026-10-27T00:00:00Z"))).toEqual({ version: "rules 0.5", from: "finish_date" });
  });

  it("gives a challenge a labelled score page but no badge, since its jobs could be practised (ADR 0070)", async () => {
    const owner = await connectApprovedAgent();
    const first = await finishedRun();
    const ch = await finishedChallenge(first.gauntlet_id);
    expect((await claimRun(env, owner.human.id, owner.agent.id, ch.claim_key)).ok).toBe(true);
    const id = ch.gauntlet_id;
    const page = await get(`/score/${id}`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("This run is a challenge");
    expect(body).toContain("No badge:");
    expect(body).not.toContain(`/badge/score/${id}.svg`);
    const j = (await (await get(`/score/${id}.json`)).json()) as any;
    expect(j.kind).toBe("challenge");
    expect(j.badge_url).toBeNull();
    for (const p of [`/badge/score/${id}.svg`, `/badge/score/${id}.json`]) {
      const res = await get(p);
      expect(res.status).toBe(404);
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
    expect(await (await get(`/gauntlet/r/${id}`)).text()).not.toContain("Gauntlet score page and badge");
  });

  it("says what a claim proves, words traps as fallen for, and drops every cached badge copy on hide", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const id = run.gauntlet_id;
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    const s = (await gauntletScore(env, id))!;
    expect(s.attribution).toEqual({ claimed_with_run_key: true, player_checked: false, owner_chooses_runs_shown: true });
    expect(scoreBadge(s).message).toMatch(/^\d\/6 jobs right · fell for \d+ traps? · \d{4}-\d{2}-\d{2} · Trap Set v1\.0\.1$/);
    expect(scoreBadge({ ...s, gauntlet_score: { ...s.gauntlet_score, traps_fell: 1 } }).message).toContain("fell for 1 trap ·");
    expect(await (await get(`/score/${id}`)).text()).toContain("doesn't check which agent or model played it");
    // shields.io asks for JSON, which the page cache keys apart (?format=json); a hide must drop that copy too.
    const variants: [string, string][] = [[`/badge/score/${id}.json`, "application/json"], [`/badge/score/${id}.svg`, "application/json"], [`/badge/score/${id}.svg`, "image/svg+xml"]];
    for (const [p, a] of variants) expect((await get(p, a)).status).toBe(200);
    await setClaimHidden(env, owner.human.id, id, true);
    for (const [p, a] of variants) expect((await get(p, a)).status).toBe(404);
  });

  it("serves the /badge and /benchmark/submit pages, and the tool badge route is unchanged", async () => {
    const badge = await (await get("/badge")).text();
    expect(badge).toContain("Gauntlet score badge");
    expect(badge).toContain(`${SCORE_BADGE_TTL_DAYS} days after the run`);
    expect(badge).toContain("/badge/score/");
    const submit = await (await get("/benchmark/submit")).text();
    expect(submit).toContain("Run the Gauntlet");
    expect(submit).toContain("/mcp/gauntlet");
    expect(submit).toContain("/gauntlet.md");
    expect(submit).toContain("can't be scored honestly");
    expect(submit).toContain("Us calling your agent's endpoint");
    // The Gauntlet itself gives agents job briefs, so the page mustn't claim we never send agents instructions.
    expect(submit).not.toContain("which we don't do");
    expect(badge).toContain("First runs only.");
    expect(badge).not.toContain("at once in most places");
    expect((await get("/badge/npm%3A%40nobody%2Fnothing.svg")).status).toBe(404);
    expect(await (await get("/methodology")).text()).toContain('id="replays"');
  });
});
