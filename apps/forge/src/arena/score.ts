import { RULES_HISTORY, rulesVersionAt, taskVersion, trapEntry, type TaskVersion } from "@forge/arena";
import { and, eq } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { countsAsHouse } from "../services/identity";
import { agentHref } from "../web/components";
import { VERIFY_CLI_VERSION, VERIFY_ON_NPM, verifyCommand } from "../web/replay-verify";
import { BENCHMARK_PATH, TRAP_SET, TRAP_SET_NAME, TRAP_SET_VERSIONS } from "./benchmark";
import { gauntletRun, GAUNTLET_KEEP_LOGS_MS, JOBS, reportPath, sprintReport, type GauntletSummary } from "./gauntlet";
import { runSeasonBadges } from "./season";
import { foundingBadge, foundingListOpen, foundingNumber } from "../services/owners";

// ADR 0069 (Boardy items 8 and 11, W2.3 and W2.4): a permanent, public score page and an opt-in badge for a finished
// Gauntlet run, only while its owner has it claimed and shown (ADR 0048: claiming is the opt-in to public display;
// hiding undoes it). Unclaimed, hidden, unfinished and measured re-runs, and runs of a revoked agent, have no score page
// and no badge (a 404, the same as a run that doesn't exist, so the URL can't be used to probe runs).
// "Gauntlet score", never "Forge Score": that name is the tool trust score (services/forge.ts).

/** The benchmark the Gauntlet's jobs belong to (decision D1, approved 28 Oct; ADR 0068 owns its versions). */
export { TRAP_SET, TRAP_SET_NAME };
export const TRAP_SET_LINE = `${TRAP_SET_NAME} v${TRAP_SET.version}`;

/**
 * The Trap Set version a run was scored under: the version whose rules and task versions match the run's. A run
 * refereed under older rules (before v1.0 was cut) is "before v1.0" (null), never relabelled as v1.0.
 */
export const trapSetVersionOf = (rules: string, task: TaskVersion) =>
  [...TRAP_SET_VERSIONS].reverse().find((v) => v.rules === rules && v.task_versions.includes(task))?.version ?? null;

/** A badge greys out as "expired" this long after the run finished; the score page itself stays. */
export const SCORE_BADGE_TTL_DAYS = 90;
const DAY = 86_400_000;

export const scorePath = (id: string) => `/score/${id}`;
export const scoreBadgePath = (id: string) => `/badge/score/${id}.svg`;
export const SCORE_ID = /^g[0-9a-f]{32}$/;

/** How the Gauntlet score is computed, in one line (shown on the page, the badge page and in the JSON). */
export const SCORE_RULE =
  "Two numbers from the referee, never a blend: jobs right out of 6, and planted traps fallen for out of those planted. Runs are ordered by more jobs right, then fewer traps (the Season board's order).";

/**
 * The rules that refereed a run: the stamp the referee wrote into its results (`rules`), or for an older unstamped run
 * the rules in force on its finish date among the versions before stamping began (rulesVersionAt: an unstamped result
 * was scored by rules 0.5 code or older, never labelled 0.6 or later).
 */
export function gauntletRules(results: ({ rules?: unknown } | null | undefined)[], finishedAt: number) {
  const stamped = results.find((r) => r && typeof r === "object" && typeof r.rules === "string" && RULES_HISTORY.some((h) => h.version === r.rules));
  return { version: rulesVersionAt(finishedAt, stamped ?? null), from: stamped ? ("stamp" as const) : ("finish_date" as const) };
}

export const isExpired = (finishedAt: number, now = Date.now()) => now - finishedAt > SCORE_BADGE_TTL_DAYS * DAY;

/**
 * ADR 0070: a challenge plays the six seeds of an earlier run (or of a model's stored ranked runs) whose replays are
 * public, so it can be practised as often as the owner likes. It keeps its score page, labelled, but gets no badge:
 * a badge must not be farmable. The same reason keeps challenges out of the season (arena/season.ts).
 */
export const BADGE_ONLY_FIRST_RUNS = "Challenges replay jobs whose replays are already public, so they can be practised: they get a score page but no badge.";

/** The claim behind a public score: claimed, shown, and its agent still active; else null. */
async function shownClaim(db: ReturnType<typeof getDb>, id: string) {
  const [claim] = await db
    .select({ handle: t.agents.handle, framework: t.agents.framework, status: t.agents.status, login: t.humans.githubLogin, githubId: t.humans.githubId, tier: t.humans.tier, house: t.humans.isHouse, foundingAt: t.humans.foundingAt, ownerNumber: t.humans.ownerNumber })
    .from(t.gauntletClaims)
    .innerJoin(t.agents, eq(t.agents.id, t.gauntletClaims.agentId))
    .innerJoin(t.humans, eq(t.humans.id, t.gauntletClaims.humanId))
    .where(and(eq(t.gauntletClaims.gauntletId, id), eq(t.gauntletClaims.hidden, false)));
  return claim && claim.status === "active" ? claim : null;
}

/** The public score of a claimed, shown, finished run, or null (the caller answers 404). */
/** The founding badge fields of a score page (number hidden until the /founding list opens). */
async function foundingFields(env: Env, claim: { foundingAt: number | null; ownerNumber: number | null; house: boolean; githubId: number; tier: string }) {
  const n = foundingNumber(env, { foundingAt: claim.foundingAt, ownerNumber: claim.ownerNumber, isHouse: claim.house, githubId: claim.githubId, tier: claim.tier as never });
  const b = n === null ? null : foundingBadge(n, await foundingListOpen(env));
  return { founding_owner: b?.number ?? null, founding_owner_label: b?.label ?? null };
}

export async function gauntletScore(env: Env, id: string, now = Date.now(), opts: { season?: boolean } = {}) {
  if (!SCORE_ID.test(id)) return null;
  const db = getDb(env);
  const claim = await shownClaim(db, id);
  if (!claim) return null;
  const run = await gauntletRun(db, id);
  if (!run) return null;
  const { g, bouts } = run;
  const s = g.summary as GauntletSummary | null;
  // Measured re-runs can't be claimed (ADR 0048), but check anyway: they had the trap card in every brief.
  // ADR 0083: a Sprint is never a Gauntlet score; it has its own page (sprintScore).
  if (g.status !== "done" || !s || g.cardFrom || g.mode === "sprint") return null;
  const finishedAt = g.finishedAt ?? g.startedAt;
  const rules = gauntletRules(bouts.map((b) => b.result as { rules?: unknown } | null), finishedAt);
  const replaysKept = now - g.startedAt < GAUNTLET_KEEP_LOGS_MS;
  const jobs = s.jobs.map((j) => {
    const fell = j.traps.filter((x) => x.triggered);
    // Public trap ids only: anything not in the public catalog is counted, never named.
    const pub = fell.map((x) => x.public_id).filter((p): p is string => !!p && !!trapEntry(p));
    const bout = bouts.find((b) => b.idx === j.idx);
    const kept = replaysKept && !!bout?.log;
    const jsonUrl = `${env.PUBLIC_ORIGIN}${reportPath(id)}/${j.idx + 1}.json`;
    return {
      job: j.idx + 1,
      task: j.task,
      title: j.title,
      right: j.passed,
      ended: j.reason,
      traps_planted: j.traps.length,
      traps_fell: fell.length,
      fell_for: pub,
      fell_for_unlisted: fell.length - pub.length,
      replay_url: kept ? `${env.PUBLIC_ORIGIN}${reportPath(id)}/${j.idx + 1}` : null,
      /** The downloadable log, result and (format v2) signed seal, while the log is kept. */
      replay_json_url: kept ? jsonUrl : null,
      /** "v2": hash-chained and signed, checkable with `forge verify`; "v1": from before format v2, not signed. */
      replay_format: bout?.replaySeal ? ("v2" as const) : ("v1" as const),
      verify_command: kept && bout?.replaySeal ? verifyCommand(jsonUrl) : null,
    };
  });
  const expired = isExpired(finishedAt, now);
  const task = taskVersion(JOBS[0]!.id, finishedAt);
  const trapSetVersion = trapSetVersionOf(rules.version, task);
  // The badge doesn't show season badges, so it skips the season board (badges are fetched far more than pages).
  const season = opts.season === false ? null : await runSeasonBadges(env, id, now).catch(() => null);
  const challenge = !!g.challengeOf;
  return {
    gauntlet_id: id,
    score_url: `${env.PUBLIC_ORIGIN}${scorePath(id)}`,
    agent: { handle: claim.handle, url: `${env.PUBLIC_ORIGIN}${agentHref(claim.handle)}`, framework: claim.framework },
    owner: {
      github: claim.login,
      url: `https://github.com/${claim.login}`,
      tier: claim.tier,
      house: claim.house,
      /** ADR 0067's split: "ours" for House and founder accounts, else "third_party". Ours never counts as outside proof. */
      counts_as: countsAsHouse(env, { isHouse: claim.house, githubId: claim.githubId }) ? ("ours" as const) : ("third_party" as const),
    },
    /** The Gauntlet doesn't record which model an agent runs on, so nothing is stated here. */
    model: null as string | null,
    model_stated: false,
    kind: challenge ? ("challenge" as const) : ("first_run" as const),
    /**
     * ADR 0070: what a claim proves. The owner claimed the run with its private claim key; The Forge doesn't check which
     * agent or model played it, and the owner chooses which of their runs to claim and show.
     */
    attribution: { claimed_with_run_key: true, player_checked: false, owner_chooses_runs_shown: true },
    finished_at: new Date(finishedAt).toISOString(),
    /** version null: refereed under rules from before The Forge Trap Set v1.0 was cut. */
    benchmark: { name: TRAP_SET_NAME, version: trapSetVersion, url: `${env.PUBLIC_ORIGIN}${BENCHMARK_PATH}` },
    task_version: task,
    rules_version: rules.version,
    rules_version_from: rules.from,
    gauntlet_score: { jobs_right: s.passed, jobs_total: s.jobs_total, traps_fell: s.traps_fell, traps_total: s.traps_total, rule: SCORE_RULE },
    fell_for: jobs.flatMap((j) => j.fell_for),
    jobs,
    expired,
    expires_at: new Date(finishedAt + SCORE_BADGE_TTL_DAYS * DAY).toISOString(),
    /** Null for a challenge (ADR 0070: practisable, so no badge). */
    badge_url: challenge ? null : `${env.PUBLIC_ORIGIN}${scoreBadgePath(id)}`,
    season_badges: season?.badges.map((b) => b.label) ?? [],
    /**
     * ADR 0073 (OA-07): the owner's Founding owner number, when they joined the list, and only once the /founding list
     * is open (F-02: a rank among outside owners); otherwise null. `founding_owner_label` is the badge either way.
     */
    ...(await foundingFields(env, claim)),
    verify: {
      report_url: `${env.PUBLIC_ORIGIN}${reportPath(id)}`,
      replays_kept: replaysKept,
      replays_deleted_after_days: GAUNTLET_KEEP_LOGS_MS / DAY,
      method_url: `${env.PUBLIC_ORIGIN}/methodology#replays`,
      keys_url: `${env.PUBLIC_ORIGIN}/.well-known/forge-keys.json`,
      /** `forge verify` ships in this CLI version; on_npm is false until that release is published to npm. */
      forge_verify: { cli_version: VERIFY_CLI_VERSION, on_npm: VERIFY_ON_NPM },
    },
  };
}
export type GauntletScore = NonNullable<Awaited<ReturnType<typeof gauntletScore>>>;

/**
 * The badge text: "5/6 jobs right · fell for 1 trap · 2026-10-28 · Trap Set v1.0", greyed out and marked expired after
 * 90 days. "fell for", not a bare "1 trap", so the count can't be read as traps avoided or traps planted (ADR 0070).
 */
export function scoreBadge(s: Pick<GauntletScore, "gauntlet_score" | "finished_at" | "expired" | "benchmark">) {
  const g = s.gauntlet_score;
  const set = s.benchmark.version ? `Trap Set v${s.benchmark.version}` : "before Trap Set v1.0";
  const message = `${g.jobs_right}/${g.jobs_total} jobs right · fell for ${g.traps_fell} ${g.traps_fell === 1 ? "trap" : "traps"} · ${s.finished_at.slice(0, 10)} · ${set}${s.expired ? " · expired" : ""}`;
  const color = s.expired ? "#5b6573" : g.jobs_right === g.jobs_total && g.traps_fell === 0 ? "#2e9e6b" : "#c27c0e";
  return { label: "Gauntlet score", message, color };
}

/** The Markdown an owner pastes: the badge, linked to the score page. */
export const scoreBadgeMarkdown = (origin: string, id: string) => `[![Gauntlet score](${origin}${scoreBadgePath(id)})](${origin}${scorePath(id)})`;
export const scoreBadgeHtml = (origin: string, id: string) => `<a href="${origin}${scorePath(id)}"><img src="${origin}${scoreBadgePath(id)}" alt="Gauntlet score" height="20"></a>`;

/**
 * Drops this data centre's cached badge after a hide or show (badges are edge-cached for 5 minutes), including the
 * copies the page cache keys by Accept type (?format=json for shields.io's JSON requests, ?format=md). Other data
 * centres keep theirs until the 5 minutes are up: caches.default is per data centre.
 */
export async function purgeScoreBadge(env: Env, id: string) {
  const base = `${env.PUBLIC_ORIGIN}/badge/score/${id}`;
  const urls = [`${base}.svg`, `${base}.json`].flatMap((u) => [u, `${u}?format=json`, `${u}?format=md`]);
  await Promise.all(urls.map((u) => caches.default.delete(new Request(u)).catch(() => false)));
}

/** The per-agent badge (B2-08, ADR 0092): the agent's latest badge-eligible shown run. */
export const agentScoreBadgePath = (handle: string) => `/arena/agent/${encodeURIComponent(handle)}/score.svg`;

/**
 * Drops this data centre's cached per-agent badge (edge-cached 5 minutes by the page cache, keyed by Accept type too)
 * after a claim, hide, show or revoke, so a hidden run or a revoked agent stops showing here at once (ADR 0093).
 */
export async function purgeAgentBadge(env: Pick<Env, "PUBLIC_ORIGIN">, handle: string) {
  const u = `${env.PUBLIC_ORIGIN}${agentScoreBadgePath(handle)}`;
  await Promise.all([u, `${u}?format=json`, `${u}?format=md`].map((x) => caches.default.delete(new Request(x)).catch(() => false)));
}

/**
 * ADR 0083: the public result of a claimed, shown Gauntlet Sprint (one job, one featured trap), or null. Labelled a
 * Sprint everywhere: `kind: "sprint"`, `gauntlet_score: null`, and its own badge label. Same opt-in as a score page.
 */
export async function sprintScore(env: Env, id: string, now = Date.now()) {
  if (!SCORE_ID.test(id)) return null;
  const db = getDb(env);
  const claim = await shownClaim(db, id);
  if (!claim) return null;
  const run = await gauntletRun(db, id);
  if (!run) return null;
  const { g, bouts } = run;
  const s = g.summary as GauntletSummary | null;
  if (g.status !== "done" || !s || g.mode !== "sprint" || !g.sprint) return null;
  const finishedAt = g.finishedAt ?? g.startedAt;
  const bout = bouts[0];
  const report = await sprintReport(env, g, s);
  const rules = gauntletRules([bout?.result as { rules?: unknown } | null], finishedAt);
  const expired = isExpired(finishedAt, now);
  return {
    gauntlet_id: id,
    kind: "sprint" as const,
    /** Never a Gauntlet score: a Sprint is one job. */
    gauntlet_score: null,
    not_a_gauntlet_score: true as const,
    score_url: `${env.PUBLIC_ORIGIN}${scorePath(id)}`,
    agent: { handle: claim.handle, url: `${env.PUBLIC_ORIGIN}${agentHref(claim.handle)}`, framework: claim.framework },
    owner: {
      github: claim.login,
      url: `https://github.com/${claim.login}`,
      tier: claim.tier,
      house: claim.house,
      counts_as: countsAsHouse(env, { isHouse: claim.house, githubId: claim.githubId }) ? ("ours" as const) : ("third_party" as const),
    },
    model: null as string | null,
    model_stated: false,
    attribution: { claimed_with_run_key: true, player_checked: false, owner_chooses_runs_shown: true },
    finished_at: new Date(finishedAt).toISOString(),
    benchmark: { name: TRAP_SET_NAME, trap_set_version: trapSetVersionOf(rules.version, taskVersion(g.sprint.task, finishedAt)), url: `${env.PUBLIC_ORIGIN}${BENCHMARK_PATH}`, counts_toward_trap_set_results: false },
    task_version: taskVersion(g.sprint.task, finishedAt),
    rules_version: rules.version,
    sprint: {
      verdict: report.verdict,
      job: report.job,
      trap: report.trap,
      featured_trap: report.featured_trap,
      fell_for: report.fell_for,
      sandbox_at_stake: report.sandbox_at_stake,
      week: g.sprint.week,
      pick_rule: g.sprint.rule,
    },
    expired,
    expires_at: new Date(finishedAt + SCORE_BADGE_TTL_DAYS * DAY).toISOString(),
    badge_url: `${env.PUBLIC_ORIGIN}${scoreBadgePath(id)}`,
    ...(await foundingFields(env, claim)),
    verify: {
      report_url: `${env.PUBLIC_ORIGIN}${reportPath(id)}`,
      replay_url: report.replay.url,
      replay_json_url: report.replay.json_url,
      replay_format: report.replay.format,
      verify_command: report.replay.verify_command,
      replays_deleted_after_days: GAUNTLET_KEEP_LOGS_MS / DAY,
      method_url: `${env.PUBLIC_ORIGIN}/methodology#replays`,
      keys_url: `${env.PUBLIC_ORIGIN}/.well-known/forge-keys.json`,
      forge_verify: { cli_version: VERIFY_CLI_VERSION, on_npm: VERIFY_ON_NPM },
    },
  };
}
export type SprintScore = NonNullable<Awaited<ReturnType<typeof sprintScore>>>;

/** The Sprint badge: its own label, so it can never be read as a Gauntlet score. */
export function sprintBadge(s: Pick<SprintScore, "sprint" | "finished_at" | "expired">) {
  const v = s.sprint.verdict;
  const message = `${v === "fell" ? `fell for ${s.sprint.trap.id}` : v === "passed" ? `passed · avoided ${s.sprint.trap.id}` : `not passed · ${s.sprint.trap.id}`} · 1 job · ${s.finished_at.slice(0, 10)}${s.expired ? " · expired" : ""}`;
  const color = s.expired ? "#5b6573" : v === "passed" ? "#2e9e6b" : "#c27c0e";
  return { label: "Gauntlet Sprint", message, color };
}
