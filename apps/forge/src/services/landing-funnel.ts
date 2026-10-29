import { and, count, countDistinct, eq, gte, isNull, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { outsidePeople } from "./agent-funnel";
import { getDb } from "./db";
import { counterSums } from "./owner-funnel";

// The landing-to-owner funnel (conversion review, 26 Oct 2026; ADR 0065). Internal only (/admin/kpis). Every step from
// opening /connect to a verified owner who claimed a Gauntlet run, in one table with drop-off percentages, so the step
// where people stop is plain. Daily aggregate counters only (usage_daily) and the run and claim tables we already
// keep: nothing new about any person is stored. A counter that has never been written is null ("not yet measured").
//
// Two populations meet here. Steps 1–3 are people on /connect; steps 4–9 are Gauntlet runs, which also start from the
// Gauntlet page, the plugin or a pasted line without /connect. So a later step can be larger than the one before it;
// the percentages are a guide to where people stop, not a cohort.

const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const LANDING_STAGES = [
  ["connect_views", "Opened /connect", "people opening /connect (site.js beacon; crawlers and automation left out)"],
  ["chose_client", "Chose a client", "page loads where someone picked an app tile, pressed an install link or copied an install command (once per page load)"],
  ["first_call", "First call from a new client", "the /connect example check (pypi:litellm 1.107.0) or test code arriving by MCP, A2A or the API (not the site's own check form)"],
  ["gauntlet_started", "Gauntlet started", "first runs and challenges started (measured re-runs left out; ours included, runs are anonymous)"],
  ["gauntlet_finished", "Gauntlet finished", "those runs finished"],
  ["claim_page", "Claim page opened", "views of /gauntlet/claim (not the return from sign-in)"],
  ["github_signin", "GitHub sign-in", "sign-ins finished on the way back to the claim page (House and founders left out)"],
  ["claimed", "Run claimed", "runs claimed by verified owners outside the project"],
  ["verified_owner", "Verified owner", "distinct verified owners outside the project who claimed a run"],
] as const;

export type LandingStage = (typeof LANDING_STAGES)[number][0];

export interface LandingFunnel {
  window: { from: string; to: string; days: number };
  stages: { id: LandingStage; label: string; definition: string; n: number | null; pct_of_previous: number | null; pct_of_first: number | null; measured_since: string | null }[];
  biggest_drop: string | null;
  detail: {
    connect_page_views_gross: number | null;
    chose_by_app: Record<string, number>;
    tiles_by_app: Record<string, number>;
    first_check_by_channel: Record<string, number>;
    connect_tests_passed: number | null;
    first_prompt_copied: number | null;
    gauntlet_line_copied: number | null;
    signin_started_from_claim: number | null;
    maintainer_reply_page: number | null;
    maintainer_disputes_sent: number | null;
  };
  daily: ({ day: string } & Record<LandingStage, number | null>)[];
  notes: string[];
}

const pct = (x: number | null, of: number | null) => (x === null || !of ? null : Math.round((x / of) * 1000) / 10);

/** The funnel over the `days` full UTC days before `now`'s day, and the last `dailyDays` of them day by day. */
export async function landingFunnel(env: Env, now = Date.now(), days = 30, dailyDays = 14): Promise<LandingFunnel> {
  const db = getDb(env);
  const fromDay = day(now - days * DAY);
  const toDay = day(now - DAY);
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  const end = Date.parse(`${day(now)}T00:00:00Z`);
  const keys = ["visit:human:connect", "visit:connect", "connect:chose", "connect:first-check", "connect:test-passed", "connect:copied:first-prompt", "connect:copied:gauntlet-line", "owner:claim_page", "owner:signin_start", "owner:signin_done", "maintainer:reply_page", "maintainer:dispute_sent"];
  const c = await counterSums(env, keys, ["connect:copied:", "connect:tile:", "connect:first-check:"], fromDay, toDay);

  // Gauntlet runs, by day (UTC). cardFrom null: first runs and challenges, the claimable ones.
  const dayOf = (col: typeof t.arenaGauntlets.startedAt | typeof t.arenaGauntlets.finishedAt) => sql<string>`strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;
  const started = await db
    .select({ d: dayOf(t.arenaGauntlets.startedAt), n: count() })
    .from(t.arenaGauntlets)
    .where(and(isNull(t.arenaGauntlets.cardFrom), eq(t.arenaGauntlets.mode, "full"), gte(t.arenaGauntlets.startedAt, start), lt(t.arenaGauntlets.startedAt, end)))
    .groupBy(dayOf(t.arenaGauntlets.startedAt));
  const finished = await db
    .select({ d: dayOf(t.arenaGauntlets.finishedAt), n: count() })
    .from(t.arenaGauntlets)
    .where(and(isNull(t.arenaGauntlets.cardFrom), eq(t.arenaGauntlets.mode, "full"), eq(t.arenaGauntlets.status, "done"), gte(t.arenaGauntlets.finishedAt, start), lt(t.arenaGauntlets.finishedAt, end)))
    .groupBy(dayOf(t.arenaGauntlets.finishedAt));
  // Review (ADR 0084): claims of six-job runs only, like the started and finished stages.
  const claimWhere = and(outsidePeople(env), eq(t.humans.tier, "verified"), eq(t.arenaGauntlets.mode, "full"), gte(t.gauntletClaims.claimedAt, start), lt(t.gauntletClaims.claimedAt, end));
  const claimDay = sql<string>`strftime('%Y-%m-%d', ${t.gauntletClaims.claimedAt} / 1000, 'unixepoch')`;
  const claimsDaily = await db
    .select({ d: claimDay, n: count(), owners: countDistinct(t.gauntletClaims.humanId) })
    .from(t.gauntletClaims)
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .where(claimWhere)
    .groupBy(claimDay);
  const [claims] = await db
    .select({ n: count(), owners: countDistinct(t.gauntletClaims.humanId) })
    .from(t.gauntletClaims)
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .innerJoin(t.arenaGauntlets, eq(t.arenaGauntlets.id, t.gauntletClaims.gauntletId))
    .where(claimWhere);
  const total = (rows: { n: number }[]) => rows.reduce((a, r) => a + Number(r.n), 0);

  // First call: the example check or the test code, whichever came (the two can overlap for one person).
  const firstCheck = c.get("connect:first-check");
  const tests = c.get("connect:test-passed");
  const firstCall = firstCheck === null && tests === null ? null : (firstCheck ?? 0) + (tests ?? 0);
  const values: Record<LandingStage, number | null> = {
    connect_views: c.get("visit:human:connect"),
    chose_client: c.get("connect:chose"),
    first_call: firstCall,
    gauntlet_started: total(started),
    gauntlet_finished: total(finished),
    claim_page: c.get("owner:claim_page"),
    github_signin: c.get("owner:signin_done"),
    claimed: Number(claims?.n ?? 0),
    verified_owner: Number(claims?.owners ?? 0),
  };
  const since: Partial<Record<LandingStage, string | null>> = {
    connect_views: c.seen("visit:human:connect"),
    chose_client: c.seen("connect:chose"),
    first_call: [c.seen("connect:first-check"), c.seen("connect:test-passed")].filter((x): x is string => !!x).sort()[0] ?? null,
    claim_page: c.seen("owner:claim_page"),
    github_signin: c.seen("owner:signin_done"),
  };
  const first = values.connect_views;
  const stages = LANDING_STAGES.map(([id, label, definition], i) => {
    const prev = i ? values[LANDING_STAGES[i - 1]![0]] : null;
    return { id, label, definition, n: values[id], pct_of_previous: i ? pct(values[id], prev) : null, pct_of_first: i ? pct(values[id], first) : null, measured_since: since[id] ?? null };
  });
  let biggest: string | null = null;
  let worst = 0;
  for (let i = 1; i < stages.length; i++) {
    const a = stages[i - 1]!.n, b = stages[i]!.n;
    if (a === null || b === null || a <= 0) continue;
    const lost = (a - b) / a;
    if (lost > worst) (worst = lost), (biggest = `${stages[i - 1]!.label} → ${stages[i]!.label}`);
  }

  // Day by day, oldest first. Counter stages read per day; a counter never written by that day is null.
  const firstDay = day(now - Math.min(dailyDays, days) * DAY);
  const perDay = await db
    .select({ d: t.usageDaily.day, key: t.usageDaily.key, n: t.usageDaily.n })
    .from(t.usageDaily)
    .where(and(gte(t.usageDaily.day, firstDay), sql`${t.usageDaily.day} <= ${toDay}`, sql`${t.usageDaily.key} in ('visit:human:connect', 'connect:chose', 'connect:first-check', 'connect:test-passed', 'owner:claim_page', 'owner:signin_done')`));
  const daily = Array.from({ length: Math.min(dailyDays, days) }, (_, i) => {
    const d = day(now - (Math.min(dailyDays, days) - i) * DAY);
    const get = (k: string) => {
      const s = c.seen(k);
      return s && s <= d ? Number(perDay.find((r) => r.d === d && r.key === k)?.n ?? 0) : null;
    };
    const fc = get("connect:first-check"), tp = get("connect:test-passed");
    const cl = claimsDaily.find((r) => r.d === d);
    return {
      day: d,
      connect_views: get("visit:human:connect"),
      chose_client: get("connect:chose"),
      first_call: fc === null && tp === null ? null : (fc ?? 0) + (tp ?? 0),
      gauntlet_started: Number(started.find((r) => r.d === d)?.n ?? 0),
      gauntlet_finished: Number(finished.find((r) => r.d === d)?.n ?? 0),
      claim_page: get("owner:claim_page"),
      github_signin: get("owner:signin_done"),
      claimed: Number(cl?.n ?? 0),
      verified_owner: Number(cl?.owners ?? 0),
    };
  });

  const copiedByApp = c.byPrefix("connect:copied:");
  return {
    window: { from: fromDay, to: toDay, days },
    stages,
    biggest_drop: biggest,
    detail: {
      connect_page_views_gross: c.get("visit:connect"),
      chose_by_app: Object.fromEntries(Object.entries(copiedByApp).filter(([k]) => !["test-prompt", "first-prompt", "gauntlet-line"].includes(k))),
      tiles_by_app: c.byPrefix("connect:tile:"),
      first_check_by_channel: c.byPrefix("connect:first-check:"),
      connect_tests_passed: tests,
      first_prompt_copied: c.get("connect:copied:first-prompt"),
      gauntlet_line_copied: c.get("connect:copied:gauntlet-line"),
      signin_started_from_claim: c.get("owner:signin_start"),
      maintainer_reply_page: c.get("maintainer:reply_page"),
      maintainer_disputes_sent: c.get("maintainer:dispute_sent"),
    },
    daily,
    notes: [
      "Steps 1–3 are people on /connect; steps 4–9 are Gauntlet runs, which can also start without /connect. A step can be larger than the one before it.",
      "First call counts checks of pypi:litellm 1.107.0 by MCP, A2A or the API (anyone can ask for it, including the CLI, the GitHub Action and agents reacting to the advisory, so an upper bound) plus /connect test codes; one person can do both.",
      "Gauntlet started and finished include our own runs (runs are anonymous until claimed). Claims and owners leave out House and founder accounts.",
      "Chose a client counts page loads, not people; the app breakdown counts presses, and one person can press several.",
    ],
  };
}
