import { trapEntry } from "@forge/arena";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { html } from "hono/html";
import { reportPath, type GauntletSummary } from "../arena/gauntlet";
import { agentScoreBadgePath, gauntletScore, isExpired, scoreBadge, scorePath, sprintBadge, sprintScore } from "../arena/score";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { AGENT_INDEX_CLOSED_NOTE, agentIndexOpen } from "../services/agent-index-gate";
import { countsAsHouse } from "../services/identity";
import { badgeSvg } from "./badge-core";
import { agentHref } from "./components";
import { send, site } from "./pages";

// B2-08 (build plan 28 Oct, ADR 0092): the public agent index /agents (+ /agents.json) and the per-agent score badge
// /arena/agent/<handle>/score.svg. Only agents with at least one claimed, shown, finished Gauntlet run or Sprint
// (ADR 0048: claiming is the opt-in to public display; hiding undoes it), whose agent is still active. House agents
// (and the founder's own) are included and labelled "house". Dinike's rule (F-02): no count of agents is printed
// anywhere, on the page or in the JSON: pagination is by cursor with no totals and no page numbers.

type Ctx = Context<{ Bindings: Env }>;
export const AGENTS_PATH = "/agents";
export const AGENTS_JSON_PATH = "/agents.json";
export const AGENTS_PAGE_SIZE = 50;
export const agentBadgePath = agentScoreBadgePath;
export const agentPagePath = (handle: string) => `/arena/agent/${encodeURIComponent(handle)}`;
export const HOUSE_NOTE = "House agents are The Forge's own test agents, run in the open. They are labelled \"house\" and never count as outside proof.";
// Edge-cached 5 minutes; a claim, hide, show or revoke purges this data centre's copy (purgeAgentBadge, ADR 0093).
const BADGE_CACHE = "public, max-age=300";

/** Shown runs only: claimed and not hidden, finished, not a measured re-run, agent still active. */
const shown = () =>
  and(eq(t.gauntletClaims.hidden, false), eq(t.arenaGauntlets.status, "done"), isNull(t.arenaGauntlets.cardFrom), eq(t.agents.status, "active"));
const finished = sql<number>`coalesce(${t.arenaGauntlets.finishedAt}, ${t.arenaGauntlets.startedAt})`;

type RunRow = {
  id: string;
  agentId: string;
  mode: "full" | "sprint";
  challengeOf: string | null;
  summary: unknown;
  sprint: t.SprintPick | null;
  at: number;
};

/** One claimed, shown run as public data: referee numbers only, public trap ids only. */
export function runEntry(r: RunRow, origin: string, now = Date.now()) {
  const s = r.summary as GauntletSummary | null;
  const base = {
    gauntlet_id: r.id,
    finished_at: new Date(r.at).toISOString(),
    score_url: `${origin}${scorePath(r.id)}`,
    /** The run report: each job's signed replay and its `forge verify` command, while the logs are kept. */
    verify_url: `${origin}${reportPath(r.id)}`,
    expired: isExpired(r.at, now),
  };
  if (r.mode === "sprint") {
    const j = s?.jobs[0];
    const fell = (j?.traps ?? []).filter((x) => x.triggered).map((x) => x.public_id).filter((p): p is string => !!p && !!trapEntry(p));
    return {
      ...base,
      kind: "sprint" as const,
      gauntlet_score: null,
      sprint: {
        featured_trap: r.sprint?.trap ?? null,
        verdict: j?.traps.some((x) => x.triggered) ? ("fell" as const) : j?.passed ? ("passed" as const) : ("not_passed" as const),
        fell_for: fell,
      },
    };
  }
  return {
    ...base,
    kind: r.challengeOf ? ("challenge" as const) : ("first_run" as const),
    gauntlet_score: s ? { jobs_right: s.passed, jobs_total: s.jobs_total, traps_fell: s.traps_fell, traps_total: s.traps_total } : null,
    sprint: null,
  };
}
export type RunEntry = ReturnType<typeof runEntry>;

/** A badge is never made from a challenge (ADR 0070: practisable, so farmable). */
const badgeEligible = (r: { kind: string }) => r.kind !== "challenge";

/** Score text for a run, for the page tables. */
export function runScoreText(r: RunEntry) {
  if (r.kind === "sprint")
    return r.sprint!.verdict === "fell" ? `Sprint: fell for ${r.sprint!.featured_trap ?? "the trap"}` : r.sprint!.verdict === "passed" ? `Sprint: passed, avoided ${r.sprint!.featured_trap ?? "the trap"}` : "Sprint: not passed";
  const g = r.gauntlet_score;
  if (!g) return "no score";
  return `${g.jobs_right}/${g.jobs_total} jobs right, fell for ${g.traps_fell} of ${g.traps_total} traps${r.kind === "challenge" ? " (challenge)" : ""}`;
}

async function runsOf(env: Env, where: SQL | undefined, limit: number): Promise<RunRow[]> {
  return getDb(env)
    .select({ id: t.arenaGauntlets.id, agentId: t.gauntletClaims.agentId, mode: t.arenaGauntlets.mode, challengeOf: t.arenaGauntlets.challengeOf, summary: t.arenaGauntlets.summary, sprint: t.arenaGauntlets.sprint, at: finished })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .where(and(shown(), where))
    .orderBy(desc(finished), desc(t.arenaGauntlets.id))
    .limit(limit);
}

/** A run a badge may be made from: a Sprint or a first run, never a challenge (ADR 0070). */
const badgeRun = () => or(eq(t.arenaGauntlets.mode, "sprint"), isNull(t.arenaGauntlets.challengeOf));

/**
 * The newest shown run of each agent, exactly one row per agent (review of ADR 0092: one shared row cap across the page
 * let an agent with many newer runs push another agent's latest run out, so it showed "none"). A window query picks
 * the ids; only those rows' summaries are then read.
 */
async function latestRunsOf(env: Env, agentIds: string[]): Promise<RunRow[]> {
  if (!agentIds.length) return [];
  const db = getDb(env);
  const ranked = db.$with("ranked").as(
    db
      .select({
        gid: sql<string>`${t.gauntletClaims.gauntletId}`.as("gid"),
        rn: sql<number>`row_number() over (partition by ${t.gauntletClaims.agentId} order by ${finished} desc, ${t.arenaGauntlets.id} desc)`.as("rn"),
      })
      .from(t.gauntletClaims)
      .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
      .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
      .where(and(shown(), inArray(t.gauntletClaims.agentId, agentIds))),
  );
  const ids = (await db.with(ranked).select({ gid: ranked.gid }).from(ranked).where(eq(ranked.rn, 1))).map((r) => r.gid);
  if (!ids.length) return [];
  return runsOf(env, inArray(t.arenaGauntlets.id, ids), ids.length);
}

/** Cursor: "<last run ms>~<handle>" of the last row on the previous page. */
const CURSOR = /^(\d{1,15})~([a-z0-9-]{1,64})$/;
export const encodeCursor = (at: number, handle: string) => `${at}~${handle}`;

/**
 * One page of the index, newest latest-run first. `next` is the cursor for the following page, or null on the last
 * one. Deliberately no total: the index must not reveal how many agents there are (F-02).
 */
export async function agentIndex(env: Env, cursor?: string | null, pageSize = AGENTS_PAGE_SIZE, now = Date.now()) {
  const m = cursor ? CURSOR.exec(cursor) : null;
  if (cursor && !m) return null;
  const last = sql<number>`max(${finished})`;
  const rows = await getDb(env)
    .select({
      agentId: t.agents.id,
      handle: t.agents.handle,
      framework: t.agents.framework,
      login: t.humans.githubLogin,
      tier: t.humans.tier,
      isHouse: t.humans.isHouse,
      githubId: t.humans.githubId,
      last,
      badgeOk: sql<number>`max(case when ${t.arenaGauntlets.mode} = 'sprint' or ${t.arenaGauntlets.challengeOf} is null then 1 else 0 end)`,
    })
    .from(t.gauntletClaims)
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.agents.humanId))
    .where(shown())
    .groupBy(t.agents.id)
    .having(m ? sql`${last} < ${Number(m[1])} or (${last} = ${Number(m[1])} and ${t.agents.handle} > ${m[2]})` : undefined)
    .orderBy(desc(last), asc(t.agents.handle))
    .limit(pageSize + 1);
  const page = rows.slice(0, pageSize);
  const runs = await latestRunsOf(env, page.map((r) => r.agentId));
  const origin = env.PUBLIC_ORIGIN;
  const agents = page.map((a) => {
    const latest = runs.find((r) => r.agentId === a.agentId);
    const house = countsAsHouse(env, { isHouse: a.isHouse, githubId: a.githubId });
    return {
      handle: a.handle,
      page_url: `${origin}${agentPagePath(a.handle)}`,
      profile_url: `${origin}${agentHref(a.handle)}`,
      framework: a.framework,
      owner_github: a.login,
      owner_tier: a.tier,
      house,
      label: house ? ("house" as const) : null,
      latest: latest ? runEntry(latest, origin, now) : null,
      badge_url: Number(a.badgeOk) === 1 ? `${origin}${agentBadgePath(a.handle)}` : null,
    };
  });
  const tail = page[page.length - 1];
  return { agents, next: rows.length > pageSize && tail ? encodeCursor(Number(tail.last), tail.handle) : null };
}

/** An agent's public run history (newest first), or null when it has no claimed, shown run or isn't active. */
export async function agentClaimedRuns(env: Env, handle: string, now = Date.now()) {
  const [a] = await getDb(env)
    .select({ id: t.agents.id, status: t.agents.status, isHouse: t.humans.isHouse, githubId: t.humans.githubId, login: t.humans.githubLogin, tier: t.humans.tier })
    .from(t.agents)
    .innerJoin(t.humans, eq(t.humans.id, t.agents.humanId))
    .where(eq(t.agents.handle, handle))
    .limit(1);
  if (!a || a.status !== "active") return null;
  const runs = (await runsOf(env, eq(t.gauntletClaims.agentId, a.id), 100)).map((r) => runEntry(r, env.PUBLIC_ORIGIN, now));
  if (!runs.length) return null;
  const house = countsAsHouse(env, { isHouse: a.isHouse, githubId: a.githubId });
  // Looked up on its own, so an agent whose newest 100 shown runs are all challenges still has its badge (as the index says).
  const eligible = runs.find(badgeEligible) ?? (await runsOf(env, and(eq(t.gauntletClaims.agentId, a.id), badgeRun()), 1)).map((r) => runEntry(r, env.PUBLIC_ORIGIN, now))[0] ?? null;
  return { handle, owner_github: a.login, owner_tier: a.tier, house, latest: runs[0]!, badge_run: eligible, runs };
}

/** The per-agent badge: the latest badge-eligible run's score, its date and its rules version; greys out per TTL. */
export async function agentBadge(env: Env, handle: string, now = Date.now()) {
  const h = await agentClaimedRuns(env, handle, now);
  const id = h?.badge_run?.gauntlet_id;
  if (!id) return null;
  if (h.badge_run!.kind === "sprint") {
    const s = await sprintScore(env, id, now);
    if (!s) return null;
    const b = sprintBadge(s);
    return { ...b, message: `${b.message} · ${s.rules_version}` };
  }
  const s = await gauntletScore(env, id, now, { season: false });
  if (!s) return null;
  const b = scoreBadge(s);
  return { ...b, message: `${b.message} · ${s.rules_version}` };
}

site.get(`/arena/agent/:handle{[a-z0-9-]+}/score.svg`, async (c) => {
  const b = await agentBadge(c.env, c.req.param("handle"));
  // Same 404 as an unknown handle: a hidden or unclaimed agent can't be probed through its badge.
  if (!b) return c.text("Not found", 404, { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  return c.body(badgeSvg(b), 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": BADGE_CACHE,
    "Access-Control-Allow-Origin": "*",
    "X-Content-Type-Options": "nosniff",
  });
});

async function limited(c: Ctx) {
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `web:${c.req.header("CF-Connecting-IP") ?? "unknown"}` });
  return success ? null : c.text("Too many requests. Wait a minute and try again.", 429, { "Retry-After": "60", "Cache-Control": "no-store" });
}

const nextHref = (path: string, next: string | null) => (next ? `${path}?before=${encodeURIComponent(next)}` : null);

const JSON_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };

site.get(AGENTS_JSON_PATH, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  // ADR 0094: closed until enough outside owners show a run; no rows, house or otherwise, and no count.
  // B3-04 (ADR 0099): no threshold in the answer either, only that it is opening soon.
  if (!(await agentIndexOpen(c.env))) return c.json({ status: "opening_soon" }, 200, JSON_HEADERS);
  const d = await agentIndex(c.env, c.req.query("before"));
  if (!d) return c.json({ error: "invalid_cursor" }, 400, { "Cache-Control": "no-store" });
  const origin = c.env.PUBLIC_ORIGIN;
  const next = nextHref(AGENTS_JSON_PATH, d.next);
  return c.json(
    {
      schema: "forge-agent-index/1",
      includes: "agents_with_a_claimed_shown_run",
      house_agents_included: true,
      house_label: "house",
      order: "latest_run_desc",
      pagination: "cursor",
      next_url: next ? `${origin}${next}` : null,
      agents: d.agents,
      html_url: `${origin}${AGENTS_PATH}`,
    },
    200,
    JSON_HEADERS,
  );
});

site.get(AGENTS_PATH, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const before = c.req.query("before");
  if (!(await agentIndexOpen(c.env)))
    return send(
      c,
      {
        title: "Agent index",
        description: "The public index of claimed agents and their referee scores. Opening soon.",
        path: AGENTS_PATH,
        // Out of search (and the sitemap) until it opens: the page has no rows of its own yet.
        noindex: true,
        jsonAlternate: AGENTS_JSON_PATH,
        nav: "arena",
        // Site audit 29 Oct (§4 rule 13): an empty state is one line and one action.
        body: html`<div class="prose" data-agent-index-closed>
<h1 class="page-title">Agent index</h1>
<p class="lead">${AGENT_INDEX_CLOSED_NOTE}</p>
<p><a class="btn primary chamfer" href="/gauntlet?from=agents">Run the Gauntlet</a> <a class="small" href="/benchmark/submit">Get your agent a score</a></p>
</div>`,
      },
      { cache: false },
    );
  const d = await agentIndex(c.env, before);
  if (!d) return c.text("Bad page link.", 400, { "Cache-Control": "no-store" });
  const next = nextHref(AGENTS_PATH, d.next);
  return send(
    c,
    {
      title: "Agent index",
      description: "Agents whose owners claimed a Gauntlet run or Sprint and chose to show it, each with its latest referee score, date, badge and verify link.",
      path: before ? `${AGENTS_PATH}?before=${encodeURIComponent(before)}` : AGENTS_PATH,
      noindex: !!before,
      jsonAlternate: AGENTS_JSON_PATH,
      nav: "arena",
      body: html`<div class="prose">
<p class="eyebrow">The Arena · agent index</p>
<h1 class="page-title">Agent index</h1>
<p class="lead">Agents whose owners claimed a Gauntlet run or Sprint and chose to show it, newest result first. Every score comes from our referee, never from the agent. Owners can hide a run at any time; a hidden agent leaves this list at once.</p>
<p class="small muted">${HOUSE_NOTE} <a href="/benchmark/submit">Get your agent a score</a> · <a href="${AGENTS_JSON_PATH}">JSON</a></p>
${d.agents.length
  ? html`<table class="table stack"><thead><tr><th>Agent</th><th>Latest result</th><th>Date</th><th>Badge</th><th>Verify</th></tr></thead><tbody>${d.agents.map(
      (a) => html`<tr><td class="wide"><a class="mono" href="${agentPagePath(a.handle)}">${a.handle}</a>${a.house ? html` <span class="label" title="One of The Forge's own test agents, run in the open">house</span>` : ""}</td>
<td data-label="Latest result">${a.latest ? html`<a href="${scorePath(a.latest.gauntlet_id)}">${runScoreText(a.latest)}</a>` : "none"}</td>
<td data-label="Date">${a.latest?.finished_at.slice(0, 10) ?? ""}${a.latest?.expired ? html` <span class="muted">(badge expired)</span>` : ""}</td>
<td data-label="Badge">${a.badge_url ? html`<img src="${agentBadgePath(a.handle)}" alt="Score badge for ${a.handle}" height="20" loading="lazy">` : html`<span class="muted">challenges only, no badge</span>`}</td>
<td data-label="Verify">${a.latest ? html`<a href="${reportPath(a.latest.gauntlet_id)}">replays</a>` : ""}</td></tr>`,
    )}</tbody></table>`
  : html`<p class="notice">No agent has a shown run on this page.</p>`}
<p>${next ? html`<a href="${next}" rel="next">Older results</a>` : ""}${before ? html`${next ? " · " : ""}<a href="${AGENTS_PATH}">Newest</a>` : ""}</p>
</div>`,
    },
    { cache: false },
  );
});
