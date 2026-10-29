import { like, sql } from "drizzle-orm";
import { displayVerdict, type VerdictInput } from "@forge/shared/light";
import * as t from "../db/schema";
import { PUBLIC_ROW_MINIMUMS, rowShown } from "./counters";
import { getDb } from "./db";
import type { InternalComponent } from "./internal";
import type { StatsRule } from "./public-stats";
import { bump } from "./usage";

// B2-06 (build plan 28 Oct, Boardy item 5; ADR 0086): what happens at the moment of an install, counted by client,
// gross. A check counts here only when one of our install-time clients made it, told apart by the User-Agent each one
// sends (the Claude Code plugin's PreToolUse hook, the CLI and its hooks for Codex, Gemini CLI and Copilot, the
// forge-check GitHub Action), or, for the skill-scan Action (which scans on the runner and never calls a check), by its
// one anonymous end-of-run count, sent only when its user opts in with count-run: true (ADR 0090 Amendment 1). Crawlers, page views, MCP connections and plain API checks never count here.
//
// "Blocked" is decided from our own answer, by the same rule every client applies (packages/shared verdict.ts):
// flagged or confirmed malicious is denied by the plugin and the hooks, and fails the forge-check Action at its default
// setting. So the number is "would block": a person who turned the check off never sends one. Nothing about the person,
// the machine, the repository or the package is stored: daily counter rows only (usage_daily), like every other count.
// Our own tagged callers (services/internal.ts) count in the gross total, like House activity, and are also counted
// under `install:ours:*` so the admin pages can show the outside split. Public pages never show that split (Dinike,
// 28 Oct: gross numbers only on the site).

/** The install-time clients, in display order. */
export const INSTALL_CLIENTS = ["plugin", "cli", "hook-codex", "hook-gemini", "hook-copilot", "action", "skill-scan"] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];
export type InstallOutcome = "checked" | "blocked" | "advisory";
export const INSTALL_OUTCOMES: readonly InstallOutcome[] = ["checked", "blocked", "advisory"];

export const INSTALL_CLIENT_NAMES: Record<InstallClient, string> = {
  plugin: "Claude Code plugin (install hook)",
  cli: "CLI (forge check)",
  "hook-codex": "CLI hook for Codex",
  "hook-gemini": "CLI hook for Gemini CLI",
  "hook-copilot": "CLI hook for GitHub Copilot",
  action: "forge-check GitHub Action",
  "skill-scan": "skill-scan GitHub Action (one count per run)",
};

/** The install-time client a check came from, by its User-Agent; null for everyone else (browsers, crawlers, scripts). */
export function installClient(userAgent: string | null | undefined): InstallClient | null {
  const ua = (userAgent ?? "").slice(0, 200);
  if (ua.startsWith("theagentforge-claude-plugin")) return "plugin";
  if (ua.startsWith("theagentforge-action")) return "action";
  if (ua.startsWith("theagentforge-cli")) {
    // `forge hook <client>` sends "theagentforge-cli/<version> (hook <client>)"; `forge watch` is a weekly check-in,
    // not an install, and uses the watch API, so it never reaches here.
    const hook = /\(hook (codex|gemini|copilot)\)/.exec(ua);
    return hook ? (`hook-${hook[1]}` as InstallClient) : "cli";
  }
  return null;
}

type Answer = Pick<VerdictInput, "security_status" | "forge_score" | "public_signals_summary">;

/**
 * What our answer means at the install: "blocked" when every client denies it (flagged or confirmed malicious; the
 * forge-check Action's default `fail-on: flagged`), "advisory" when it carries a published advisory but isn't blocked,
 * otherwise null (just a check).
 */
export function installOutcome(answer: Partial<Answer> | null | undefined): "blocked" | "advisory" | null {
  if (!answer || typeof answer.security_status !== "string") return null;
  const v = displayVerdict({ security_status: answer.security_status, forge_score: answer.forge_score ?? null });
  if (v === "flagged" || v === "confirmed_malicious") return "blocked";
  return (answer.public_signals_summary?.advisories?.length ?? 0) > 0 ? "advisory" : null;
}

/** The counter keys one install-time check adds: always `checked`, plus its outcome; our own also under `ours`. */
export function installCounters(client: InstallClient, outcome: "blocked" | "advisory" | null, internal: InternalComponent | null = null): string[] {
  const keys = [`install:checked:${client}`, ...(outcome ? [`install:${outcome}:${client}`] : [])];
  return internal ? [...keys, ...keys.map((k) => k.replace(/^install:/, "install:ours:"))] : keys;
}

/** A cached answer's body, read back for its outcome (null when it isn't JSON). */
export function parseAnswer(text: string): Partial<Answer> | null {
  try {
    return JSON.parse(text) as Partial<Answer>;
  } catch {
    return null;
  }
}

/** Counts a check answered on /api/v1/check, when an install-time client made it. Never throws. */
export async function recordInstallCheck(env: Env, userAgent: string | undefined, internal: InternalComponent | null, answer: Partial<Answer> | null, now = Date.now()) {
  try {
    const client = installClient(userAgent);
    if (!client) return;
    await bump(env, installCounters(client, installOutcome(answer), internal), now);
  } catch (e) {
    console.error("install_count_failed", String(e));
  }
}

/** The skill-scan Action's end-of-run outcome (its only call to us): blocked = the job failed on findings. */
export const SKILL_SCAN_OUTCOMES = { blocked: "blocked", findings: "advisory", clear: null } as const;
export type SkillScanOutcome = keyof typeof SKILL_SCAN_OUTCOMES;
export const isSkillScanOutcome = (v: unknown): v is SkillScanOutcome => typeof v === "string" && Object.hasOwn(SKILL_SCAN_OUTCOMES, v);

/** The 7 UTC days (today included) the 7-day install numbers cover, as on /stats. */
export const INSTALL_DAYS = 7;
const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface InstallTotals {
  days: number;
  /** Gross: every install-time check, our own tests included. */
  gross: Record<"all_time" | "last_7_days", Record<InstallOutcome, number>>;
  /** Internal only (admin): our own tagged callers, per client. Never on a public page. */
  ours: Record<"all_time" | "last_7_days", Record<InstallOutcome, number>>;
  /** Internal only (admin): the gross counts by client. */
  by_client: Record<InstallClient, Record<"all_time" | "last_7_days", Record<InstallOutcome, number>>>;
}

/** Every install counter, summed: gross, ours and by client, all time and the last 7 UTC days. */
export async function installTotals(env: Env, now = Date.now()): Promise<InstallTotals> {
  const since = isoDay(now - (INSTALL_DAYS - 1) * DAY);
  const rows = await getDb(env)
    .select({ key: t.usageDaily.key, all: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)`, week: sql<number>`coalesce(sum(case when ${t.usageDaily.day} >= ${since} then ${t.usageDaily.n} else 0 end), 0)` })
    .from(t.usageDaily)
    .where(like(t.usageDaily.key, "install:%"))
    .groupBy(t.usageDaily.key);
  const zero = (): Record<InstallOutcome, number> => ({ checked: 0, blocked: 0, advisory: 0 });
  const pair = () => ({ all_time: zero(), last_7_days: zero() });
  const out: InstallTotals = { days: INSTALL_DAYS, gross: pair(), ours: pair(), by_client: Object.fromEntries(INSTALL_CLIENTS.map((c) => [c, pair()])) as InstallTotals["by_client"] };
  for (const r of rows) {
    const m = /^install:(ours:)?(checked|blocked|advisory):([a-z-]+)$/.exec(r.key);
    if (!m || !(INSTALL_CLIENTS as readonly string[]).includes(m[3]!)) continue;
    const outcome = m[2] as InstallOutcome;
    const target = m[1] ? out.ours : out.gross;
    target.all_time[outcome] += Number(r.all);
    target.last_7_days[outcome] += Number(r.week);
    if (!m[1]) {
      out.by_client[m[3] as InstallClient].all_time[outcome] += Number(r.all);
      out.by_client[m[3] as InstallClient].last_7_days[outcome] += Number(r.week);
    }
  }
  return out;
}

/** The gross all-time install checks, for the home band (null when there are none yet). */
export async function installChecksTotal(env: Env): Promise<number | null> {
  const [r] = await getDb(env)
    .select({ n: sql<number>`coalesce(sum(${t.usageDaily.n}), 0)` })
    .from(t.usageDaily)
    .where(like(t.usageDaily.key, "install:checked:%"));
  const n = Number(r?.n ?? 0);
  return n > 0 ? n : null;
}

const INSTALL_COUNTS =
  "Checks made at the moment of an install by The Forge's install-time clients, told apart by the User-Agent each sends: the Claude Code plugin's install hook, the CLI (forge check) and its hooks for Codex, Gemini CLI and GitHub Copilot, and the forge-check GitHub Action, one per package or tool checked; plus one per run of the skill-scan GitHub Action where its user turned the run count on (count-run: true; off by default, so most runs are never counted), which scans on the runner and sends only its outcome. Crawlers, page views, MCP connections and plain API checks are not counted. A User-Agent can be copied, so this counts what those clients report, not verified installs: anyone who copies one can raise it, up to the rate limit of 60 counted checks (or skill-scan runs) a minute per network address.";
const INSTALL_OURS = "Includes The Forge's own test agents: our CI and repositories (tagged X-Forge-Internal) count in this number, like House activity.";
const OUTCOME_LABEL: Record<InstallOutcome, string> = {
  checked: "Install checks by AI tools",
  blocked: "Installs our answer would block",
  advisory: "Install checks that carried a published advisory (not blocked)",
};
const OUTCOME_COUNTS: Record<InstallOutcome, string> = {
  checked: INSTALL_COUNTS,
  blocked: `The install checks above whose answer every client blocks on: a tool flagged by verified agents or confirmed malicious, or a version with a published malicious-package advisory (the plugin and the hooks deny the command; the forge-check Action fails at its default setting). It counts would-block answers: a person can still run the command themselves. For the skill-scan Action, a run that failed on its findings.`,
  advisory: "The install checks above whose answer named a published advisory (for example a CVE) but was not one the clients block on; for the skill-scan Action, a run with findings below its failure threshold.",
};
const ALL_TIME_WINDOW = "All time (install counting began with counting rules 2.2, 28 Oct 2026)";
const WEEK_WINDOW = "The last 7 UTC days, today included";

/** /stats/rules entries for the six install numbers, each with the SQL that reproduces it. */
export const INSTALL_RULES: StatsRule[] = INSTALL_OUTCOMES.flatMap((o) => [
  {
    key: `install_${o}_all`,
    label: `${OUTCOME_LABEL[o]}, all time (our own tests included)`,
    source: "usage_daily (daily counters; no IP, account, package name or repository is stored)",
    counts: OUTCOME_COUNTS[o],
    ours: INSTALL_OURS,
    window: ALL_TIME_WINDOW,
    minimum: PUBLIC_ROW_MINIMUMS.install_checks,
    reproduce: `SELECT coalesce(sum(n), 0) FROM usage_daily WHERE key LIKE 'install:${o}:%';`,
  },
  {
    key: `install_${o}_7d`,
    label: `${OUTCOME_LABEL[o]}, last 7 days (our own tests included)`,
    source: "usage_daily (daily counters; no IP, account, package name or repository is stored)",
    counts: OUTCOME_COUNTS[o],
    ours: INSTALL_OURS,
    window: WEEK_WINDOW,
    minimum: PUBLIC_ROW_MINIMUMS.install_checks,
    reproduce: `SELECT coalesce(sum(n), 0) FROM usage_daily WHERE day >= '<today - 6 days>' AND key LIKE 'install:${o}:%';`,
  },
]);

/**
 * The gross install numbers as data (/stats.json): no per-client or outside split, which is internal. B3-04 (ADR 0099):
 * each row is left out until its value passes PUBLIC_ROW_MINIMUMS.install_checks, unless `allRows` (admin, data room).
 */
export function installJson(v: InstallTotals | null, origin = "", opts: { allRows?: boolean } = {}) {
  return {
    includes_own_test_agents: true as const,
    caveat: "Includes The Forge's own test agents.",
    days: INSTALL_DAYS,
    rules_url: `${origin}/stats/rules#install`,
    items: INSTALL_OUTCOMES.flatMap((o) => [
      { key: `install_${o}_7d`, outcome: o, window: "last_7_days" as const, label: INSTALL_RULES.find((r) => r.key === `install_${o}_7d`)!.label, value: v ? v.gross.last_7_days[o] : null, rule_url: `${origin}/stats/rules#install_${o}_7d` },
      { key: `install_${o}_all`, outcome: o, window: "all_time" as const, label: INSTALL_RULES.find((r) => r.key === `install_${o}_all`)!.label, value: v ? v.gross.all_time[o] : null, rule_url: `${origin}/stats/rules#install_${o}_all` },
    ]).filter((x) => opts.allRows || rowShown("install_checks", x.value)),
  };
}
