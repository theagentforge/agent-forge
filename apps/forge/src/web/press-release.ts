import { html } from "hono/html";
import skillScanReport from "../../../../docs/reports/2026-10-skill-scan.md";
import lab4Output from "../../../../lab/004-trap-card-frontier/analysis-output.md";
import { LAUNCH_SCAN } from "../reports/skill-scan-facts";
import { cachedToolScans } from "../services/house-tools";
import { getDb } from "../services/db";
import { scanPath } from "../services/scans";
import * as t from "../db/schema";
import { inArray, and, eq } from "drizzle-orm";
import { EXPERIMENTS, pText } from "./experiments";
import { responsesShowing, type MaintainerResponse } from "./maintainer-response";
import { notFound, send, site } from "./pages";
import { FROZEN } from "./reliability-report";
import { REPORT_FACTS, securityJson } from "./security";
import { statsData } from "./stats";
import type { FallSummary } from "../arena/results";

// The research release of 2 Nov 2026 (docs/launch/research-release-2026-11.md §1, §4 and §5; Dinike, 1 Nov). One page,
// /press/2026-11, for reporters: Lab #4's null result, the launch skill scan, what maintainers did, and the Arena rates.
// Order (Dinike, 6 Nov): the page leads with the dated launch-scan finding and what maintainers did; the ranked rates
// come lower, labelled "Early read" with their attempts, dates and interval, because their samples are small.
//
// Every number is read when the page is built, through the Worker's own data functions (the same objects /security,
// /stats.json, /reports/house.json and the launch-scan report serve), never typed here. A number that can't be read
// takes its line with it (the doc's rule: delete the line rather than estimate it).
//
// The §4 rules, in code: no "malicious", "safe", "embargo", "exclusive" or "first"; no model names (rates are by kind of
// job; the Arena board already leaves out embargoed models, held-out seeds, practice and lab arms); gross numbers only,
// each with "Includes the Forge's own test agents"; Edition 1 is a "live preview" until frozen; Lab #3's figure is only
// ever said of small open models. Named repositories come only from the maintainer-response file, each with its
// response.
//
// The page is noindex always, and is a 404 before PRESS_LIVE_FROM (2 Nov 2026 00:00 UTC, when the launch scan's
// disclosure window ended): it went live by itself at that instant. The 404 is never cached.

export const PRESS_PATH = "/press/2026-11";
export const PRESS_LIVE_FROM = Date.UTC(2026, 10, 2);
/** The day the 17 maintainer notices were filed (STATUS, 28 Oct 2026). A fix dated before it wasn't a response to it. */
export const NOTICES_SENT = "2026-10-28";

/**
 * The launch-scan report names every notified repository from version 1.2 (the 2 Nov disclosure task, step 3); before
 * that it was anonymised. Read from the report's own byline, the same file the report page renders.
 */
export function reportNamesRepositories(md: string = skillScanReport) {
  const m = /Report version (\d+)\.(\d+)/.exec(md);
  return !!m && (Number(m[1]) > 1 || (Number(m[1]) === 1 && Number(m[2]) >= 2));
}

/** "The current text describes how the third-party … handles ~/.env.", from the response's own note; null if absent. */
export function currentTextClause(note: string | undefined) {
  const m = /description of how (the third-party [^:]+?) handles ~\/\.env/.exec(note ?? "");
  return m ? `The current text describes how ${m[1]} handles ~/.env.` : null;
}

/** The fingerprints among these whose scan row is public in D1, so their /scan page exists. */
async function publicFingerprints(env: Env, fps: string[]) {
  if (!fps.length) return new Set<string>();
  const rows = await getDb(env).select({ fp: t.skillScans.fingerprint }).from(t.skillScans).where(and(inArray(t.skillScans.fingerprint, fps), eq(t.skillScans.public, true)));
  return new Set(rows.map((r) => r.fp));
}

const num = (n: number) => n.toLocaleString("en-GB");
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
/** An interval in whole percents, rounded outwards so it never looks tighter than it is (as /security prints it). */
const range = ([l, u]: [number, number]) => `${Math.floor(l * 100 + 1e-9)}%–${Math.ceil(u * 100 - 1e-9)}%`;
const day = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dayShort = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const read = async <T>(f: () => Promise<T>): Promise<T | null> => {
  try {
    return await f();
  } catch (e) {
    console.error("press: a source couldn't be read", String(e).slice(0, 200));
    return null;
  }
};

/** "Piping a download into a shell: 14 files" and "Reading the agent's whole key file: 8 files", from the report. */
export function reportHabits(md: string = skillScanReport) {
  const pipe = /\*\*Piping a download into a shell: (\d+) files/.exec(md);
  const keys = /\*\*Reading the agent's whole key file: (\d+) files/.exec(md);
  return { pipe: pipe ? Number(pipe[1]) : null, key_file: keys ? Number(keys[1]) : null };
}

/** Lab #4's legitimate-work rates (arm A no card, arm C card), from its published analysis output; null when unreadable. */
export function lab4LegitWork(md: string = lab4Output) {
  const m = /Legitimate work: A ([\d.]+)%, C ([\d.]+)%/.exec(md);
  return m ? { no_card: Number(m[1]), card: Number(m[2]) } : null;
}

type Cell = { attempts: number; shown: boolean; policy_breaks: number | null; break_rate: number | null; ci_95: [number, number] | null; replays: { run: string; broke: boolean; url: string }[] };

/** Everything the page shows, as data (nulls where a source couldn't be read). Exported for the tests. */
export async function pressData(env: Env, now = Date.now()) {
  const [security, stats, tools] = await Promise.all([read(() => securityJson(env)), read(() => statsData(env)), read(() => cachedToolScans(env))]);
  const a = security?.arena ?? null;
  const overall = (a?.overall ?? null) as Cell | null;
  const groups = ((a?.by_group ?? []) as (Cell & { id: string; name: string })[]).filter((g) => g.shown && g.break_rate !== null && g.ci_95);
  const sorted = [...groups].sort((x, y) => y.break_rate! - x.break_rate! || y.attempts - x.attempts);
  const fall = overall?.replays.find((r) => r.broke) ?? null;
  const [e3, e4] = EXPERIMENTS;
  const s4 = e4.stats;
  const legit = lab4LegitWork();
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const scan = REPORT_FACTS.skill_scan;
  const habits = reportHabits();
  const work = stats?.blended.work ?? null;
  const td = tools?.summary ?? null;
  const shown = now >= PRESS_LIVE_FROM ? responsesShowing(now) : [];
  const listed = (await read(() => publicFingerprints(env, shown.map((e) => e.fingerprint)))) ?? new Set<string>();
  return {
    // ADR 0123: the latest ranked Hard event (the home line's event, the same summary arena_results gives with no
    // arguments), first in the ranked block, so that block never opens on the few attempts under the newest rules alone.
    latest_hard: (a?.latest_ranked_hard ?? null) as FallSummary | null,
    arena:
      a && overall && overall.shown && overall.break_rate !== null && overall.ci_95 && a.since && a.as_of
        ? {
            rate: overall.break_rate,
            fell: overall.policy_breaks,
            attempts: overall.attempts,
            ci_95: overall.ci_95,
            since: a.since,
            as_of: a.as_of,
            rules_version: a.rules_version,
            highest: sorted.length >= 2 ? sorted[0]! : null,
            lowest: sorted.length >= 2 ? sorted[sorted.length - 1]! : null,
            fall_replay: fall ? fall.url : null,
          }
        : null,
    gross: work && typeof work.bouts_refereed === "number" && typeof work.ranked_bouts === "number" && stats ? { bouts_refereed: work.bouts_refereed, ranked_bouts: work.ranked_bouts, as_of: stats.as_of } : null,
    lab4: {
      card_rate: s4.card.rate,
      no_card_rate: s4.none.rate,
      bouts: s4.boutsTotal,
      pairs: s4.pairs,
      from: e4.run.from,
      to: e4.run.to,
      risk_ratio: r3(1 - s4.fewer),
      ci_95: [r3(1 - s4.fewerHi), r3(1 - s4.fewerLo)] as [number, number],
      p_text: pText(s4.p),
      significant: s4.significant,
      legit_work: legit,
      lab3_fewer: e3.stats.significant ? e3.stats.fewer : null,
    },
    skill_scan: LAUNCH_SCAN
      ? {
          date: LAUNCH_SCAN.date,
          flagged: LAUNCH_SCAN.flagged,
          ordinary: LAUNCH_SCAN.ordinary,
          pct: LAUNCH_SCAN.pct,
          real: scan.real_patterns,
          false_matches: LAUNCH_SCAN.flagged - scan.real_patterns,
          signs_of_malice: scan.signs_of_malice,
          malware_found: scan.malware_found,
          files: scan.skills,
          apart: scan.skills - LAUNCH_SCAN.ordinary,
          ...habits,
        }
      : null,
    // A row shows only once its scan row is public in D1 (its /scan page exists); until then, none of them names anyone.
    maintainers: shown.filter((e) => listed.has(e.fingerprint)),
    maintainers_pending: shown.length > 0 && shown.some((e) => !listed.has(e.fingerprint)),
    report_names_repositories: reportNamesRepositories(),
    tool_descriptions: td && td.servers > 0 && td.since && td.last ? { servers: td.servers, tools: td.tools, flagged: td.verdicts.flagged, since: td.since, last: td.last } : null,
    edition_frozen: FROZEN.frozen,
  };
}

const src = (href: string, label: string) => html`<a href="${href}">${label}</a>`;

function maintainersBlock(rows: MaintainerResponse[], pending: boolean, reportNamed: boolean) {
  if (!rows.length && !pending) return "";
  const resp = (e: MaintainerResponse) => {
    const r = e.response;
    const thread = html`<a href="${r.thread_url}" rel="nofollow">thread</a>`;
    // A change dated before our notices wasn't a response to them: say so, not "fixed after our notice".
    if (r.fix_date < NOTICES_SENT)
      return html`Already changed on ${dayShort(r.fix_date)} (<a href="${r.fix_url}" rel="nofollow">${r.fix_label}</a>), after our ${dayShort(REPORT_FACTS.skill_scan.date)} scan and before our notice; replied ${dayShort(r.date)} (${thread})`;
    const fixed = e.rescan.verdict === "clear";
    const clause = fixed ? null : currentTextClause(r.note);
    return html`${fixed ? "Fixed" : "Changed the file"} in <a href="${r.fix_url}" rel="nofollow">${r.fix_label}</a> (${dayShort(r.fix_date)}); replied ${dayShort(r.date)} (${thread})${clause ? html`. ${clause}` : ""}`;
  };
  const rescan = (e: MaintainerResponse) =>
    e.rescan.verdict === "clear"
      ? html`Clear, no known pattern matched (${dayShort(e.rescan.date)}). <a href="${scanPath(e.fingerprint)}">Entry</a>`
      : html`Still matches a pattern (${dayShort(e.rescan.date)}). We record the match and make no claim either way. <a href="${scanPath(e.fingerprint)}">Entry</a>`;
  if (!rows.length)
    return html`<h2 id="maintainers">2. Maintainer responses</h2>
<p data-k="maintainers-pending">Named repositories and maintainer responses are added here once the notice window has closed.</p>`;
  return html`<h2 id="maintainers">2. Maintainer responses</h2>
<p>We told each repository's maintainer before naming it. Each entry shows the result at the commit we scanned, the response, and our rescan.</p>
<div class="table-scroll"><table class="table stack"><thead><tr><th scope="col">Repository and file</th><th scope="col">Response</th><th scope="col">Our rescan</th></tr></thead><tbody>
${rows.map((e) => html`<tr data-repo="${e.repo}"><td class="wide">${e.repo}, <code>${e.path}</code></td><td data-label="Response">${resp(e)}</td><td data-label="Our rescan">${rescan(e)}</td></tr>`)}
</tbody></table></div>
<p class="small">Headline counts don't change after a fix: they describe the commits we scanned.${reportNamed ? html` <span data-k="maintainers-others">Every notified repository is named on ${src("/reports/skill-scan-2026-10", "the report")}, with its maintainer's response beside the entry where there is one.</span>` : ""} Matches are also in our ${src("/feeds/osv", "OSV feed")}, so security tools can ingest them.</p>`;
}

export function pressBody(d: Awaited<ReturnType<typeof pressData>>) {
  const a = d.arena;
  const h = d.latest_hard?.event && d.latest_hard.attempts ? d.latest_hard : null;
  const l = d.lab4;
  const s = d.skill_scan;
  const td = d.tool_descriptions;
  const overlap = a?.highest && a.lowest ? a.highest.ci_95![0] <= a.lowest.ci_95![1] : false;
  return html`<article class="prose">
<p class="eyebrow">Research release · 2 Nov 2026</p>
<h1 class="page-title">How often AI agents fall for planted traps in everyday business jobs</h1>
<p>We gave AI models refunds, supplier invoices and bookings with traps planted inside. A referee read what they did.</p>
<p><a href="/reports/state-of-agent-reliability/2026-q4">Read the report</a> · <a href="/gauntlet/sprint">Test your own agent in 90 seconds</a></p>

<h2 id="method">Method and limits, before the numbers</h2>
<ul>
<li>The jobs are invented sandboxes. No real companies, people or money.</li>
<li>A referee scores the sandbox's end state and the tool-call log, never the model's own account.</li>
<li>Rates come from ranked bouts under one rules version. Practice runs and lab arms are left out.</li>
<li>Intervals are 95% Wilson intervals. Samples are small; read rows under the early-read line as early reads.</li>
<li>Every number below links to the public file it came from.</li>
</ul>

${s
  ? html`<h2 id="skill-scan">1. The launch scan of public agent skills (${s.date})</h2>
<ul>
<li data-k="scan-rate">In the ${s.date} launch scan, ${s.flagged} of ${num(s.ordinary)} ordinary public skills matched a high-risk pattern: ${s.pct}%.</li>
<li data-k="scan-review">On hand review of those ${s.flagged}, ${s.real} were real patterns, ${s.false_matches} were false matches, and ${s.signs_of_malice === 0 ? "none" : s.signs_of_malice} showed signs of malice.</li>
${s.malware_found === 0 ? html`<li data-k="scan-malware">No malware was found by this method.</li>` : ""}
${s.pipe !== null && s.key_file !== null ? html`<li data-k="scan-habits">The two common habits in the launch scan: piping a download into a shell (${s.pipe} files) and reading a whole key file for one key (${s.key_file} files).</li>` : ""}
<li data-k="scan-apart">In the launch scan, ${num(s.apart)} security courses, test fixtures and examples were counted apart. ${num(s.files)} files were scanned in all.</li>
</ul>
<p class="small">Source: ${src("/reports/skill-scan-2026-10", "/reports/skill-scan-2026-10")} (${src("/data/skill-scan-2026-10-19.json", "data")}). The scanner matches text only. A clear result is not a guarantee.</p>`
  : ""}

${maintainersBlock(d.maintainers, d.maintainers_pending, d.report_names_repositories)}

<h2 id="lab-4">3. Our own fix didn't measurably help frontier models (Forge Lab #4)</h2>
<ul>
<li>Our trap card is eight checks pasted into an agent's instructions. We pre-registered a test of it.</li>
<li data-k="lab4-rates">With the card, frontier models fell for a trap in ${pct1(l.card_rate)} of bouts. Without it: ${pct1(l.no_card_rate)}. ${num(l.bouts)} bouts, ${l.pairs} model–job pairs, ${dayShort(l.from)}–${day(l.to)}.</li>
<li data-k="lab4-rr">Risk ratio ${l.risk_ratio.toFixed(3)} (95% interval ${l.ci_95[0].toFixed(3)} to ${l.ci_95[1].toFixed(3)}; ${l.p_text}). ${l.significant ? "The card reduced traps." : "That is consistent with no effect: the card didn't measurably reduce traps."}</li>
${l.legit_work ? html`<li data-k="lab4-legit">No measurable harm either: legitimate work ${l.legit_work.no_card.toFixed(1)}% without the card, ${l.legit_work.card.toFixed(1)}% with it, inside the pre-registered margin.</li>` : ""}
${l.lab3_fewer !== null ? html`<li data-k="lab3">On small open models (Lab #3) the same card cut traps by ${pct0(l.lab3_fewer)}. That result is for small open models only; frontier models weren't moved.</li>` : ""}
</ul>
<p class="small">Source: ${src("/lab/4/results", "/lab/4/results")} · ${src("/lab/4", "plan, published before any run")} · ${src("/security#null-result", "/security#null-result")}. Lab arms are never counted in the ranked rates.</p>

${a || h
  ? html`<h2 id="ranked">4. Early read: ranked bouts, how often a model fell for at least one trap</h2>
<ul>
${h ? html`<li data-k="arena-latest-hard">Early read: in ${h.event_name}, the latest ranked Hard event: ${h.fell} of ${num(h.attempts)} attempts (${pct0(h.fell_rate ?? 0)}) fell for a planted trap${h.ci_95 ? `, 95% interval ${range(h.ci_95)}` : ""}, ${h.models} models${h.since && h.as_of ? `, ${day(h.since)} to ${day(h.as_of)}` : ""}${h.rules_versions.length ? `, ${h.rules_versions.join(", ")}` : ""}.${h.worst_model ? ` Highest: ${h.worst_model.name}, ${h.worst_model.fell} of ${h.worst_model.attempts}.` : ""} Source: ${src(`/arena/event/${h.event}/falls`, `/arena/event/${h.event}/falls`)} (${src("/security?format=json", "JSON")}, pointer <code>/arena/latest_ranked_hard</code>).</li>` : ""}
${a ? html`<li data-k="arena-overall">Early read: ${h ? "every ranked event scored under the current rules alone: " : ""}${pct0(a.rate)} of ${num(a.attempts)} ranked attempts fell for at least one trap, 95% interval ${range(a.ci_95)}, ${day(a.since)} to ${day(a.as_of)}${a.rules_version ? `, ${/^rules\b/i.test(a.rules_version) ? a.rules_version : `rules ${a.rules_version}`}` : ""}. Source: ${src("/security#arena", "/security#arena")} (${src("/security?format=json", "JSON")}, pointers <code>/arena/overall</code>, <code>/arena/attempts</code>).</li>` : ""}
${a?.highest && a.lowest
  ? html`<li data-k="arena-groups">By kind of job, highest: ${a.highest.name}, ${a.highest.policy_breaks} of ${a.highest.attempts} (${range(a.highest.ci_95!)}). Lowest: ${a.lowest.name}, ${a.lowest.policy_breaks} of ${a.lowest.attempts} (${range(a.lowest.ci_95!)}).${overlap ? " The two intervals overlap: not a clear difference." : ""} Source: ${src("/security#jobs", "/security#jobs")}.</li>`
  : ""}
${a?.fall_replay ? html`<li data-k="arena-replay">One refereed replay of a fall: ${src(a.fall_replay, a.fall_replay)}.</li>` : ""}
</ul>
<p class="small">Ranked only. Includes the Forge's own test agents. ${src("/stats", "How we count")}</p>`
  : ""}

${d.gross
  ? html`<h2 id="gross">5. All bouts, gross (practice and ranked together)</h2>
<ul><li data-k="gross-bouts">${num(d.gross.bouts_refereed)} bouts refereed, of which ${num(d.gross.ranked_bouts)} ranked${d.gross.ranked_bouts < d.gross.bouts_refereed ? " and the rest practice" : ""}, to ${day(d.gross.as_of)}. Source: ${src("/stats", "/stats")} (${src("/stats.json", "JSON")}).</li></ul>
<p class="small">These are activity counts, not rates. Includes the Forge's own test agents. ${src("/stats", "How we count")}</p>`
  : ""}

<h2 id="full-scan">6. The full public skill scan</h2>
<p data-k="bulk-placeholder">A scan of every public skill file we can lawfully reach is under way. We'll publish its pass when it's measured.</p>

<h2 id="tool-descriptions">7. MCP tool descriptions</h2>
<ul>
<li>Since ${td ? day(td.since) : "29 Oct 2026"} we scan the tool descriptions of MCP servers our tester can start without setup.</li>
${td
  ? html`<li data-k="tool-counts">To ${day(td.last)}: ${num(td.servers)} ${td.servers === 1 ? "server" : "servers"}, ${num(td.tools)} ${td.tools === 1 ? "description" : "descriptions"}; ${num(td.flagged)} ${td.flagged === 1 ? "server" : "servers"} matched a high-risk pattern. Source: ${src("/reports/house#tool-descriptions", "/reports/house#tool-descriptions")} (${src("/reports/house.json", "JSON")}).</li>
<li>Early data. No trend, no rate per registry, no hand review yet.</li>`
  : html`<li>Counts start on the ${src("/reports/house#tool-descriptions", "House report")}.</li>`}
</ul>

<h2 id="unknown">What isn't known yet</h2>
<ul>
<li>How often a person agrees with the referee: not yet published (Lab #6 measures it).</li>
<li>Whether models do better on job versions published before a test: not tested yet.</li>
<li>Whether the full public skill scan matches the launch scan's rate: under way (block 6).</li>
</ul>

<h2 id="tools">Free tools, today</h2>
<ul>
<li><a href="/gauntlet/sprint">Gauntlet Sprint</a>: one job, one trap, 90 seconds, no account.</li>
<li><code>npx @theagentforge/cli check &lt;tool&gt;</code> before an install, or <a href="/scan">/scan</a> for a skill file.</li>
</ul>

<p data-k="edition">The State of Agent Reliability, Edition 1: ${d.edition_frozen
    ? html`<a href="/reports/state-of-agent-reliability/2026-q4">report</a> · <a href="/reports/state-of-agent-reliability/2026-q4.pdf">PDF</a> · cite it.`
    : html`<a href="/reports/state-of-agent-reliability/2026-q4">live preview</a>, not frozen yet; please don't cite it until it is.`}</p>

<p>Data, questions or corrections: <a href="mailto:partners@theagentforge.io">partners@theagentforge.io</a>. The Agent Forge isn't affiliated with any lab. <a href="/about#independence">How we stay independent</a>.</p>
</article>`;
}

site.get(PRESS_PATH, async (c) => {
  const now = Date.now();
  // Nothing public before the notice period ends: the same 404 as any missing page, never cached.
  if (now < PRESS_LIVE_FROM) return notFound(c, "Page not found", "That page doesn't exist.");
  const res = await send(
    c,
    {
      title: "Research release, November 2026",
      description: "How often AI agents fall for planted traps in everyday business jobs, a null result on our own fix, and the 19 Oct 2026 launch scan of public agent skills, with every number linked to its public file.",
      path: PRESS_PATH,
      noindex: true,
      body: pressBody(await pressData(c.env, now)),
    },
    { maxAge: 300 },
  );
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
});

// The trailing-slash form: a 301 to the page once it's live, and the same uncached 404 before, so it never leaks that
// the page exists.
site.get(`${PRESS_PATH}/`, (c) => {
  if (Date.now() < PRESS_LIVE_FROM) return notFound(c, "Page not found", "That page doesn't exist.");
  return new Response(null, { status: 301, headers: { Location: PRESS_PATH, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
});
