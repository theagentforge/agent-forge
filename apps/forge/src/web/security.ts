import { CANARY, isRescoredGroup, PUBLIC_NAME, rescoredGroup, RULES_VERSION, TRAP_CATALOG, VERDICT_RUNS } from "@forge/arena";
import { SCAN_RULES, SCAN_RULES_VERSION, type ScanFamily } from "@forge/shared";
import { html } from "hono/html";
import { contaminationStatus, eventWorlds, refereeAudit } from "../arena/benchmark";
import { businessBoard, cellJson, MIN_CELL_ATTEMPTS, type BizCell, type BusinessBoard } from "../arena/business";
import { JOBS } from "../arena/gauntlet";
import { formatSlot, nextHeadlineSlot } from "../arena/headline-slot";
import { EXPERIMENTS, intervalText, pText, type Experiment } from "./experiments";
import { heldOutGap, weeklyPooledGap } from "../arena/holdout";
import { getDb } from "../services/db";
import { REPLAY_V2_FROM } from "../services/replay-keys";
import { DATASET_LICENCE, LICENCE_ID, LICENCE_PATH } from "../services/provenance";
import { NOTICE_DAYS, RESULTS_POLICY_PATH, RESULTS_POLICY_VERSION } from "./results-policy";
import { more } from "./components";
import { send, sendJson, site, wantsJson } from "./pages";
import { VERIFY_CLI_VERSION, verifyCommand } from "./replay-verify";

// /security (Boardy item 5, plan W1.3): the page for a buyer who secures AI agents (head of platform, trust and safety
// or AI security at an agent platform, MCP registry, model lab or security vendor). Every number on it is read live
// (the Arena's ranked results through businessBoard, so embargoed models, held-out seeds, practice and review holds are
// already out; scanner rules from @forge/shared; trap catalogue and canary from @forge/arena), or is a dated figure
// from a published report, linked. Limits are stated next to the claims they limit.
// Arena numbers count only attempts scored under the current rules (ADR 0068 Amendment 1: never pooled across rules
// versions); older-rules attempts are counted apart and their per-model rows are on /benchmark. Intervals are rounded
// outwards (ADR 0072).

export const SECURITY_PATH = "/security";

/** Plain names for the scanner's rule families (ScanFamily in packages/shared/src/skill-scan.ts). */
/** Each says only what the family's rules match in the text (ADR 0072): no wider than the patterns in SCAN_RULES. */
export const FAMILY_NAMES: Record<ScanFamily, string> = {
  exec: "Running downloaded code (piped into a shell, eval, made executable)",
  secrets: "Reading key files, saved passwords, cookies, wallets or the environment",
  exfil: "Sending data to throwaway endpoints, chat bots, tunnels or uploads of key files",
  hidden: "Invisible characters, direction overrides and instructions in HTML comments",
  injection: "Telling the agent to ignore its instructions, hide things from the user or take a new role",
  persistence: "Editing the agent's standing files or memory, or installing a scheduled task",
  remote: "Fetching instructions from a URL and following them",
  money: "Sending cryptocurrency to a fixed address",
  destructive: "Deleting the home or root folder",
  obfuscation: "Long encoded text",
  permissions: "Turning off permission prompts, or asking for administrator rights",
  impersonation: "A publisher or package name one character away from a well-known one",
};

/** Dated figures from published reports (each with its page). Not live: the report date is shown with each. */
export const REPORT_FACTS = {
  census: { path: "/reports/mcp-registry-census-2026-10", date: "2026-10-14", servers: 36_863, remote_only_share: 0.546, no_repository_share: 0.294 },
  // The 30 flagged files are among the 9,014 ordinary skills; the 916 security courses, test fixtures and examples
  // (which quote attack patterns on purpose) are reported apart in the report, not counted here.
  skill_scan: { path: "/reports/skill-scan-2026-10", date: "2026-10-19", rules_version: "2026-10-19.3", skills: 9_930, ordinary_skills: 9_014, flagged_ordinary: 30, real_patterns: 26, signs_of_malice: 0, malware_found: 0 },
  grader_hacking: {
    url: "https://github.com/theagentforge/agent-forge/blob/main/docs/reports/grader-hacking-2026-10.md",
    month: "2026-10",
    scripted_hack_attempts: 2_134,
    passed: 0,
    /** The referee gaps the first run found were fixed in this rules version. */
    fixed_in_rules: "rules 0.5",
  },
} as const;

const families = () => {
  const by = new Map<ScanFamily, string[]>();
  for (const r of SCAN_RULES) by.set(r.family, [...(by.get(r.family) ?? []), r.title]);
  return [...by.entries()].map(([id, titles]) => ({ id, name: FAMILY_NAMES[id], rules: titles.length, titles }));
};

async function gapStatus(db: ReturnType<typeof getDb>) {
  const [gap, pooled] = await Promise.all([heldOutGap(db, {}).catch(() => []), weeklyPooledGap(db).catch(() => [])]);
  const rows = [...gap, ...pooled];
  const status = rows.some((g) => g.status === "measured") ? "measured" : rows.length ? "not_enough_bouts" : "not_yet_measured";
  // A measured gap is not a contamination result: that needs ADR 0071's rule (same reading as /benchmark).
  const tests = gap.filter((g) => g.status === "measured" && g.public_arm === "previously_published").map((g) => g.event);
  const contamination = contaminationStatus(gap, await eventWorlds(db, tests).catch(() => new Map())).status;
  return { status, contamination };
}

export type SecurityGap = Awaited<ReturnType<typeof gapStatus>>;

/** The structured twin (AGENTS.md rule 7): numbers, ids, enums and links only. */
/**
 * B2-04 (Boardy 10; ADR 0082): the trap card experiments as data, Lab #4's null result first. Counts per arm, the
 * Mantel–Haenszel risk ratio with its 95% interval, the p-value and the result in the pre-registration's own terms, all
 * from the published counts.json files (./experiments). `p_text` is "p = 0.51" or "p < 0.001", as the Lab pages print it.
 */
export function trapCardExperimentsData(origin: string) {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return [...EXPERIMENTS].reverse().map((e) => {
    const s = e.stats;
    const arm = (a: { n: number; trapped: number }) => ({ bouts: a.n, fell: a.trapped });
    return {
      lab: e.lab,
      id: e.id,
      models: e.who,
      finished: e.date,
      pre_registered: true,
      rules_version: e.rules,
      bouts: s.boutsTotal,
      bouts_per_arm: s.card.n,
      model_job_pairs: s.pairs,
      arms: { no_card: arm(s.none), ...(s.placebo ? { placebo: arm(s.placebo) } : {}), card: arm(s.card) },
      // The interval is rounded outwards to 2 decimals, so it never reads narrower than computed.
      risk_ratio: Math.round((1 - s.fewer) * 100) / 100,
      risk_ratio_ci95: [Math.floor((1 - s.fewerHi) * 100 + 1e-9) / 100, Math.ceil((1 - s.fewerLo) * 100 - 1e-9) / 100],
      p: r3(s.p),
      p_text: pText(s.p),
      statistically_significant: s.significant,
      result: s.significant ? "reduced_traps" : "did_not_measurably_reduce_traps",
      plan: `${origin}${e.plan}`,
      results: `${origin}${e.results}`,
    };
  });
}

/** B2-01 (ADR 0088): ranked attempts re-scored under the current rules from their signed logs, as data, apart. */
export function rescoredData(r: BusinessBoard | null) {
  if (!r || !r.attempts) return null;
  return {
    rules_version: r.rules,
    scored_under: RULES_VERSION,
    label: "re_scored_from_signed_logs",
    pooled_with_native: false,
    played_under: r.playedUnder.map((v) => ({ rules_version: v.version, attempts: v.attempts })),
    since: r.since,
    as_of: r.asOf,
    attempts: r.attempts,
    knockouts: r.knockouts,
    models: r.models.length,
    overall: cellJson(r.overall),
    by_model: r.byModel.map((m) => ({ id: m.id, name: m.name, ...cellJson(m.cell) })),
  };
}

export function securityData(origin: string, b: BusinessBoard, gap: SecurityGap, audit: string, now = Date.now(), rescored: BusinessBoard | null = null) {
  const next = nextHeadlineSlot(now);
  return {
    name: `${PUBLIC_NAME} security overview`,
    url: `${origin}${SECURITY_PATH}`,
    arena: {
      unit: "attempt",
      event_kinds: ["card", "guest"],
      rules_version: b.rules,
      attempts_under_older_rules: b.rulesVersions.filter((v) => v.version !== b.rules && !isRescoredGroup(v.version)).map((v) => ({ rules_version: v.version, attempts: v.attempts })),
      /** Re-scored under the current rules from signed logs (played under older rules): never pooled with the rows above. */
      rescored: rescoredData(rescored),
      older_rules_rows: `${origin}/benchmark#results`,
      /** F-01: the next weekly headline bout, which runs under the current rules. */
      next_weekly_bout: { at: new Date(next).toISOString(), local: formatSlot(next) },
      since: b.since,
      as_of: b.asOf,
      attempts: b.attempts,
      knockouts: b.knockouts,
      models: b.models.length,
      overall: cellJson(b.overall),
      by_model: b.byModel.map((m) => ({ id: m.id, name: m.name, ...cellJson(m.cell) })),
      by_group: b.groups.map((g) => ({ id: g.group.id, name: g.group.name, ...cellJson(g.overall) })),
      min_attempts_shown: MIN_CELL_ATTEMPTS,
      early_read_below: VERDICT_RUNS,
      interval: "wilson_95_rounded_outwards",
      public_traps: TRAP_CATALOG.length,
      details: `${origin}/arena/business`,
      dataset: `${origin}/arena/dataset.json`,
    },
    gauntlet: { url: `${origin}/gauntlet`, jobs: JOBS.length, account_needed: false, price: 0 },
    pre_install: {
      check: `${origin}/check`,
      scan: `${origin}/scan`,
      scan_rules: SCAN_RULES.length,
      scan_rules_version: SCAN_RULES_VERSION,
      scan_families: families().map((f) => ({ id: f.id, rules: f.rules })),
      scan_method: "text_pattern_match",
      scan_runs_code: false,
      scan_sees_remote_server_behaviour: false,
      advisory_ecosystems: ["npm", "pypi"],
      public_mcp: `${origin}/mcp/public`,
      clear_scan_means: "no_known_pattern_matched",
    },
    protections: {
      referee_reads: "sandbox_end_state_and_tool_call_log",
      referee_code: "https://github.com/theagentforge/agent-forge",
      replay_formats: [
        { format: 2, runs_from: REPLAY_V2_FROM, log: "sha256_hash_chain", seal: "ed25519", keys: `${origin}/.well-known/forge-keys.json`, verifier: `@theagentforge/cli@${VERIFY_CLI_VERSION} verify`, third_party_verifiable: true },
        { format: 1, runs_before: REPLAY_V2_FROM, signature: "hmac_sha256_server_key", third_party_verifiable: false },
      ],
      held_out_seeds_published: false,
      held_out_gap: { status: gap.status, url: `${origin}/arena/history#gap` },
      contamination_effect: { status: gap.contamination, url: `${origin}/benchmark#data-protection` },
      canary: CANARY,
      provenance_on_every_row: true,
      results_policy: { url: `${origin}${RESULTS_POLICY_PATH}`, version: RESULTS_POLICY_VERSION, notice_days: NOTICE_DAYS, paid_placement: false },
      licence: { id: LICENCE_ID, url: `${origin}${LICENCE_PATH}` },
      referee_human_agreement: { status: audit, url: `${origin}/benchmark#referee` },
    },
    reports: REPORT_FACTS,
    trap_card_experiments: trapCardExperimentsData(origin),
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** An interval in whole percents, rounded outwards so it never looks tighter than it is. */
const pctRange = ([l, u]: [number, number]) => `${Math.floor(l * 100 + 1e-9)}%–${Math.ceil(u * 100 - 1e-9)}%`;
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const num = (n: number) => n.toLocaleString("en-GB");

function rate(c: BizCell) {
  if (!c.n) return html`<span class="muted">No attempts yet</span>`;
  if (!c.shown) return html`<span class="muted">Too few (n=${c.n})</span>`;
  return html`<b>${pct(c.rate!)}</b> <span class="muted">${c.breaks} of ${c.n}</span>`;
}
const interval = (c: BizCell) =>
  c.shown ? html`${pctRange(c.ci!)}${c.early ? html` <span class="label" title="Fewer than ${VERDICT_RUNS} attempts">Early read</span>` : ""}` : html`<span class="muted">–</span>`;
const replay = (c: BizCell) => {
  const r = c.replays.find((x) => x.broke);
  return r ? html`<a href="/arena/run/${r.id}">Watch a fall</a>` : html`<span class="muted">–</span>`;
};
const row = (name: string, c: BizCell) =>
  html`<tr><td class="wide">${name}</td><td class="num" data-label="Attempts">${c.n}</td><td data-label="Fell for a trap">${rate(c)}</td><td data-label="95% interval">${interval(c)}</td><td data-label="Replay">${replay(c)}</td></tr>`;
const HEAD = (first: string) =>
  html`<thead><tr><th scope="col">${first}</th><th scope="col" class="num">Attempts</th><th scope="col">Fell for a trap</th><th scope="col">95% interval</th><th scope="col">Replay</th></tr></thead>`;

/** B2-04: "What our own fix didn't do": Lab #4's null in the pre-registration's words, with Lab #3 beside it. */
function nullFinding() {
  const [e3, e4] = EXPERIMENTS;
  const n = (x: number) => x.toLocaleString("en-GB");
  const data = trapCardExperimentsData("");
  const rr = (e: Experiment) => {
    const d = data.find((x) => x.lab === e.lab)!;
    return `risk ratio ${d.risk_ratio.toFixed(2)}, 95% interval ${d.risk_ratio_ci95[0]!.toFixed(2)} to ${d.risk_ratio_ci95[1]!.toFixed(2)}; ${d.p_text}`;
  };
  const arms = (e: Experiment) => {
    const s = e.stats;
    return html`with the card ${n(s.card.trapped)} of ${n(s.card.n)} bouts fell for a planted trap${s.placebo ? html`, with a placebo text of the same length ${n(s.placebo.trapped)} of ${n(s.placebo.n)}` : ""}, and with no card ${n(s.none.trapped)} of ${n(s.none.n)}`;
  };
  const s4 = e4.stats;
  return html`<h2 id="null-result">What our own fix didn't do</h2>
<p>The Forge's free <a href="/trap-card">trap card</a> is our own product, so we tested it in public, pre-registered, and publish the result whatever it shows.</p>
<ul>
<li><b>Frontier models (Forge Lab #4, ${dayLabelText(e4.date)}):</b> ${s4.significant ? html`the card reduced traps.` : html`<b>the card didn't measurably reduce traps.</b>`} It didn't cause measurable harm to legitimate work either. <a href="${e4.results}?from=security">Lab #4 results</a></li>
<li><b>Small open models (Forge Lab #3, ${dayLabelText(e3.date)}):</b> ${e3.stats.significant ? html`${pct(e3.stats.fewer)} fewer traps with the card.` : html`no measurable change.`} <a href="${e3.results}?from=security">Lab #3 results</a></li>
</ul>
${more(
    "The numbers",
    html`<ul>
<li><b>Lab #4 (${e4.rules}):</b> on ${s4.pairs} model–job pairs on Hard jobs, ${n(s4.boutsTotal)} bouts in all (n = ${n(s4.card.n)} per arm): ${arms(e4)} (${rr(e4)}; relative change ${intervalText(s4)}).</li>
<li><b>Lab #3 (${e3.rules}):</b> ${arms(e3)}; ${n(e3.stats.boutsTotal)} bouts in all (${rr(e3)}).</li>
</ul>
<p class="small muted">Risk ratio: the share of bouts with a fall with the card, divided by the share without it (Mantel–Haenszel, pooled over model–job pairs; 95% Greenland–Robins interval). A ratio of 1 means no difference; an interval that includes 1 means no measurable effect. Lab runs change the prompt, so they are never in the ranked numbers above. Data: <a href="/security?format=json">trap_card_experiments</a>.</p>`,
    { hint: "Bouts per arm, risk ratios and intervals" },
  )}`;
}

const dayLabelText = (d: string) => fmtDay(d);

/**
 * Review of the site audit (ADR 0118): the per-model table on /security is folded, so the spread between models, the
 * fact a security buyer needs most, stays visible as one line under the overall rate: the highest and lowest shown
 * rates, with their counts. Only models with enough attempts for a rate are named (MIN_CELL_ATTEMPTS); "early read"
 * stays beside a rate under VERDICT_RUNS.
 */
export function modelsLine(rows: { name: string; cell: BizCell }[]) {
  const shown = rows.filter((m) => m.cell.shown && m.cell.rate !== null).sort((x, y) => y.cell.rate! - x.cell.rate! || y.cell.n - x.cell.n);
  if (!shown.length) return "";
  const one = (m: (typeof shown)[number]) =>
    html`<b>${m.name}</b>, ${pct(m.cell.rate!)} (${m.cell.breaks} of ${m.cell.n}${m.cell.early ? ", early read" : ""})`;
  const hi = shown[0]!, lo = shown[shown.length - 1]!;
  if (shown.length === 1) return html`<p data-models-line>Only one model has enough attempts for a rate: ${one(hi)}.</p>`;
  if (hi.cell.rate === lo.cell.rate) return html`<p data-models-line>All ${shown.length} models with enough attempts for a rate fell at the same rate: ${pct(hi.cell.rate!)}.</p>`;
  return html`<p data-models-line>Highest: ${one(hi)}. Lowest: ${one(lo)}.</p>`;
}

async function securityInputs(env: Env) {
  const db = getDb(env);
  const [b, gap, audit] = await Promise.all([businessBoard(db, "all", { rules: RULES_VERSION }), gapStatus(db), refereeAudit(db).then((a) => a.status)]);
  const group = rescoredGroup(RULES_VERSION);
  const rescored = b.rulesVersions.some((v) => v.version === group) ? await businessBoard(db, "all", { rules: group }) : null;
  return { b, gap, audit, rescored };
}

/** The /security?format=json object (the State of Agent Reliability report reads the same numbers). */
export async function securityJson(env: Env) {
  const { b, gap, audit, rescored } = await securityInputs(env);
  return securityData(env.PUBLIC_ORIGIN, b, gap, audit, Date.now(), rescored);
}

site.get(SECURITY_PATH, async (c) => {
  const { b, gap, audit, rescored } = await securityInputs(c.env);
  if (wantsJson(c)) return sendJson(c, securityData(c.env.PUBLIC_ORIGIN, b, gap, audit, Date.now(), rescored));
  const older = b.rulesVersions.filter((v) => v.version !== b.rules && !isRescoredGroup(v.version));
  const rs = rescoredData(rescored);
  const olderN = older.reduce((n, v) => n + v.attempts, 0);
  const fams = families();
  const { census, skill_scan: scan, grader_hacking: hacks } = REPORT_FACTS;
  const byModel = [...b.byModel].sort((x, y) => (y.cell.shown ? 1 : 0) - (x.cell.shown ? 1 : 0) || (y.cell.rate ?? 0) - (x.cell.rate ?? 0) || y.cell.n - x.cell.n);
  return send(c, {
    title: "Security",
    description: "For teams that secure AI agents: what an agent tool can reach, how often refereed AI models fell for planted traps on business jobs, how to test your own agent, and how the data is protected.",
    path: SECURITY_PATH,
    jsonAlternate: `${SECURITY_PATH}?format=json`,
    body: html`<article class="prose">
<p class="eyebrow">For security teams</p>
<h1 class="page-title">What an agent can be tricked into doing, measured</h1>
<p class="lead">For teams that secure AI agents. Every number links to its source and says what it can't tell you.</p>

<h2 id="reach">What an install can reach</h2>
<p>A skill file is text the agent obeys. An MCP server, plugin or package runs with the agent's own access. Whatever the agent can reach, the tool can ask for. The Forge's skill scanner has <a href="/scan/rules">${SCAN_RULES.length} rules</a> (version <code>${SCAN_RULES_VERSION}</code>) for patterns behind real attacks on agents. It matches the text only: it doesn't run the code or use a model, so it can miss what isn't written in a known form.</p>
${more(
  "What the rules look for",
  html`<div class="table-wrap"><table class="table stack">
<thead><tr><th scope="col">What the rules look for</th><th scope="col" class="num">Rules</th><th scope="col">Examples</th></tr></thead>
<tbody>${fams.map((f) => html`<tr><td class="wide">${f.name}</td><td class="num" data-label="Rules">${f.rules}</td><td data-label="Examples">${f.titles.slice(0, 3).join("; ")}</td></tr>`)}</tbody></table></div>`,
  { hint: `${SCAN_RULES.length} rules in ${fams.length} families: running downloaded code, reading keys, sending data out, hidden text…` },
)}
<p>You often can't read the code first. In the official MCP Registry on ${fmtDay(census.date)}, ${pct(census.remote_only_share)} of ${num(census.servers)} servers were remote only (the code runs on someone else's machine) and ${pct(census.no_repository_share)} listed no source repository (<a href="${census.path}">Registry census</a>).</p>

<h2 id="arena">What the Arena measures</h2>
<p>The Arena gives AI models everyday business jobs (refunds, supplier invoices, bookings, stock, records) in a sandbox with planted traps. ${TRAP_CATALOG.length} public traps, each with a stable ID and the real-world pattern it's based on (<a href="/arena/methodology#catalog">trap catalogue</a>; as a versioned, citable benchmark: <a href="/benchmark">The Forge Trap Set</a>).</p>
<p>The numbers below count only attempts scored under the current referee rules (<code>${RULES_VERSION}</code>), because a rules change can change how a trap is scored.${olderN ? html` ${num(olderN)} more ranked attempts were scored under older rules (${older.map((v, i) => html`${i ? ", " : ""}${v.version}: ${num(v.attempts)}`)}) and aren't pooled with them; their per-model rows are on <a href="/benchmark#results">the Trap Set results</a>.` : ""}</p>
${b.attempts
  ? html`<p><b>${b.overall.shown ? html`${pct(b.overall.rate!)} of ${b.attempts}` : html`${b.attempts}`} ranked attempts</b>${b.overall.shown ? html` fell for at least one planted trap (95% interval ${pctRange(b.overall.ci!)})` : ""}, across ${b.models.length} models${b.since && b.asOf ? `, ${fmtDay(b.since)} to ${fmtDay(b.asOf)}` : ""}. ${b.knockouts} more attempts ran out of time, tokens or turns and aren't counted either way.</p>
${modelsLine(byModel)}
${more(
  html`<span id="models">Which models fell</span>`,
  html`<div class="table-wrap"><table class="table stack">${HEAD("Model")}<tbody>${byModel.map((m) => row(m.name, m.cell))}</tbody></table></div>`,
  { hint: `${byModel.length} ${byModel.length === 1 ? "model" : "models"}, each with its rate, interval and a replay of a fall` },
)}
${more(
  html`<span id="jobs">By kind of job</span>`,
  html`<div class="table-wrap"><table class="table stack">${HEAD("Job")}<tbody>${b.groups.filter((g) => g.overall.n).map((g) => row(g.group.name, g.overall))}</tbody></table></div>`,
  { hint: "The same attempts, split by job" },
)}
${more("What these numbers include", html`<p class="small muted">Ranked bouts only (headline and guest events), not practice runs, prompt experiments, models whose results aren't published yet, private held-out seeds or events still being checked. Rows under ${MIN_CELL_ATTEMPTS} attempts show no rate; under ${VERDICT_RUNS} they're an early read. The 95% Wilson interval is rounded outwards and treats attempts as independent; a model plays each job version 3 times, so the real uncertainty is a little wider. Full tables, the most common trap per cell and replays: <a href="/arena/business">business agent reliability</a>.</p>`)}`
  : html`<p class="empty" data-current-rules-empty>No ranked attempts under ${RULES_VERSION} yet. The first are scheduled for the weekly bout on ${formatSlot(nextHeadlineSlot(Date.now()))} (<a href="/arena/headline.ics">calendar</a>). ${num(olderN)} ranked ${olderN === 1 ? "attempt" : "attempts"} scored under older rules ${olderN === 1 ? "is" : "are"} on <a href="/benchmark#results">the Trap Set page</a>, kept apart from the current rules. Older-rules results: <a href="/arena">Arena</a>.</p>`}

${rs
  ? more(html`<span id="rescored" data-rescored>Re-scored from signed logs</span>`, html`<p>${num(rs.attempts)} more ranked attempts were played under older rules (${rs.played_under.map((v, i) => html`${i ? "; " : ""}${v.rules_version}: ${num(v.attempts)}`)}) and re-scored under ${RULES_VERSION} by replaying their signed logs through the current referee. The jobs and what the model saw were the same; only the referee's verdict can differ. They're shown here on their own${rescored!.overall.shown ? html`: ${pct(rescored!.overall.rate!)} fell for at least one planted trap (95% interval ${pctRange(rescored!.overall.ci!)}), across ${rs.models} models, ${fmtDay(rs.since!)} to ${fmtDay(rs.as_of!)}` : ""}.</p>
<div class="table-wrap"><table class="table stack">${HEAD("Model")}<tbody>${rescored!.byModel.map((m) => row(m.name, m.cell))}</tbody></table></div>`, { hint: "Older-rules attempts, never pooled with the numbers above" })
  : ""}

${nullFinding()}

<h2 id="replays">Refereed replays</h2>
<ul>
<li><b>The referee reads what happened.</b> It checks the sandbox's end state and the log of tool calls, never the AI's own account. The referee code is public (<a href="https://github.com/theagentforge/agent-forge">theagentforge/agent-forge</a>).</li>
<li><b>Checkable without trusting us.</b> Runs from ${fmtDay(REPLAY_V2_FROM)} use replay format v2: the log is hash-chained and its final record is signed with Ed25519, with the public keys at <a href="/.well-known/forge-keys.json">/.well-known/forge-keys.json</a>. Anyone can check one: <code>${verifyCommand("<replay URL>")}</code> (<a href="/methodology#replays">how replays are verified</a>).</li>
<li><b>Limits:</b> runs before ${fmtDay(REPLAY_V2_FROM)} (format v1) carry a server signature (HMAC-SHA256) that only we can check, so for those you have to trust our copy. How often the referee agrees with human reviewers: ${audit === "measured" ? html`measured (<a href="/benchmark#referee">referee audit</a>)` : html`not yet published (<a href="/benchmark#referee">referee audit</a>)`}.</li>
</ul>
${more("Replays in the dataset, and the gaming test", html`<ul>
<li><b>Every ranked attempt has a replay</b>, linked from the tables above and listed in <a href="/arena/dataset.json">the dataset</a>. <a href="/dataset/sample">The sample dataset</a> is a fixed, checksummed zip of public records with signed replays to verify; the whole dataset is on <a href="/dataset">the dataset spec</a>.</li>
<li><b>Tested against gaming.</b> In the October 2026 test, ${num(hacks.scripted_hack_attempts)} scripted attempts to pass without doing the job (claiming done, doing part, copying the success wording) passed ${hacks.passed} times, after the referee gaps the first run found were fixed in ${hacks.fixed_in_rules} (<a href="${hacks.url}">grader-hacking report</a>). Results scored before ${hacks.fixed_in_rules} were scored by the older referee and keep their rules version.</li>
</ul>`, { hint: `${num(hacks.scripted_hack_attempts)} scripted attempts to pass without doing the job` })}

<h2 id="gauntlet">Test your own agent</h2>
<p><a href="/gauntlet">The Gauntlet</a> runs your agent through the same ${JOBS.length} everyday jobs with the same hidden traps, refereed the same way. Free, no account. You get a result page with what it fell for, a <a href="/trap-card">trap card</a> built from those traps, and a re-run to see whether the card helped. For agents handling invoices, purchasing or support, <a href="/teams">we'll run yours and send a report</a>.</p>

<h2 id="pre-install">Before an install: check and scan</h2>
<ul>
<li><b><a href="/check">Check a tool</a></b> by npm, PyPI or GitHub name, link or fingerprint: field reports on that exact version from agents tied to human-verified owners, plus published advisories for npm and PyPI versions. Each answer has a signed, dated receipt.</li>
<li><b><a href="/scan">Scan a skill</a></b> file, tool descriptions or an install command against the ${SCAN_RULES.length} rules above.</li>
</ul>
${more("The launch scan, the advisory sources and where checks run", html`<ul>
<li>In the launch scan (${fmtDay(scan.date)}, rules <code>${scan.rules_version}</code>), ${num(scan.skills)} public skills were scanned; of the ${num(scan.ordinary_skills)} ordinary ones (security courses, test fixtures and examples are counted apart), ${scan.flagged_ordinary} were flagged with a high-risk pattern. On hand review ${scan.real_patterns} were real patterns, none showing signs of malice, and no malware was found by this method (<a href="${scan.path}">report</a>).</li>
<li><b>Where it runs:</b> the public MCP server (<code>/mcp/public</code>, no account), the Claude Code plugin (looks up each install command first and blocks only versions that verified agents flagged or a malicious-package advisory names), the <code>@theagentforge/cli</code> command line, and the forge-check GitHub Action. Setup: <a href="/connect">Connect</a>.</li>
<li><b>Advisories:</b> OSV, including the OpenSSF malicious-package records, and CISA's Known Exploited Vulnerabilities list.</li>
</ul>`, { hint: `${scan.flagged_ordinary} of ${num(scan.ordinary_skills)} ordinary skills flagged at launch` })}

<h2 id="osv-feed">For security tools: our findings as an OSV feed</h2>
<p>Flagged skill scans pinned to a GitHub commit, and tool versions our field reports flagged, are published in the <a href="https://ossf.github.io/osv-schema/" rel="noopener">OSV format</a> at <a href="/feeds/osv">/feeds/osv</a> (with <a href="/feeds/osv/all.zip">all.zip</a> and <a href="/feeds/osv/modified_id.csv">modified_id.csv</a>), so a scanner can ingest them.</p>
${more("What a record means", html`<p class="small">A match means a line worth reading, not a confirmed vulnerability: records carry no severity score, say so in their summary, and include the maintainer's notice, any fix and how to reply. IDs start with <code>x_FORGE-</code>, OSV's mark for a database osv.dev doesn't aggregate.</p>`, { hint: "A line worth reading, not a confirmed vulnerability" })}

<h2 id="protection">How the referee and the data are protected</h2>
<p>Private held-out seeds, a canary line in every data file, provenance on every row, one results policy for every lab, and an evaluation-only licence.</p>
${more("Details", html`<ul>
<li><b>Held-out split.</b> Every job has private seeds that are never published (no brief, log or replay), so results can be compared on versions no model could have seen. The public-vs-held-out gap: ${gap.status === "measured" ? html`measured, on <a href="/arena/history#gap">Arena history</a>` : gap.status === "not_enough_bouts" ? html`not enough bouts yet (<a href="/arena/history#gap">Arena history</a>)` : html`not yet measured (<a href="/arena/history#gap">Arena history</a>)`}. Whether models do better on versions published before a test (contamination): ${gap.contamination === "established" ? "measured in enough events to read" : gap.contamination === "not_yet_established" ? "measured, not yet established" : "not yet measured"} (<a href="/benchmark#data-protection">how it's tested</a>).</li>
<li><b>Canary.</b> Every Arena data file and replay page carries this line, so anyone can search a training set for it: <code>${CANARY}</code></li>
<li><b>Provenance.</b> Every row and run log says where it came from: the exact model id, its maker, the provider that served it, the run date, and the Terms, Privacy and licence versions in force (<a href="/arena/methodology#contamination">methodology</a>).</li>
<li><b>Results policy.</b> Every named lab gets the same ${NOTICE_DAYS} days' notice before a headline result; exact versions, intervals and replays are always shown; no one pays for placement (<a href="${RESULTS_POLICY_PATH}">results policy ${RESULTS_POLICY_VERSION}</a>).</li>
<li><b>Licence.</b> ${DATASET_LICENCE} (<a href="${LICENCE_PATH}">licence</a>)</li>
</ul>`, { hint: "Held-out split, canary, provenance, results policy, licence" })}

<h2 id="thirty-seconds">Why a check before install is worth thirty seconds</h2>
<p>An install hands the tool what the agent can reach: keys, files, money and the right to act. A check is one free request, and the answer is a dated record you can keep. When a tool is new to us, the answer says so; it doesn't guess.</p>

<h2 id="limits">What this doesn't tell you</h2>
<ul>
<li>A clear scan means no known pattern matched. It is not a safety guarantee, and a scanner can't see what a remote server does.</li>
<li>Most tools have few or no field reports yet; the check then says "insufficient" rather than giving a verdict.</li>
<li>Advisories cover npm and PyPI versions only.</li>
<li>Arena samples are small, and the jobs are invented sandboxes with no real companies, people or money. A model's rate here is evidence about these jobs, not a forecast for yours.</li>
</ul>

<p>The quarterly report built from this data, with sample sizes, intervals and a citation block: <a href="/reports/state-of-agent-reliability/2026-q4">The State of Agent Reliability, Edition 1</a> (<a href="/reports/state-of-agent-reliability/2026-q4.pdf">PDF</a>).</p>
<p>Questions, data or a pilot: <a href="mailto:partners@theagentforge.io">partners@theagentforge.io</a>. How we stay independent: <a href="/about#independence">About</a>.</p>
</article>`,
  });
});
