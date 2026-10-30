import {
  FLAG_WINDOW_MS,
  MIN_OWNERS_FOR_FLAG,
  MIN_OWNERS_FOR_SCORE,
  MIN_VERIFIED_FOR_SCORE,
  NOTE_MAX_LENGTH,
  SANDBOX_WEIGHT,
} from "@forge/shared";
import { html } from "hono/html";
import pluginBuild from "../../public/plugins/manifest.json";
import { copyBlock, more } from "./components";
import { verifyHowTo } from "./replay-verify";
import { DESCRIPTOR, send, site } from "./pages";
import { HOUSE_METHOD_ANCHOR } from "../services/site-pulse";
import { sweepHistory } from "../services/house-report";
import { ACTIVITY_MIN_FOLLOWERS, ACTIVITY_MIN_REPOS_AND_GISTS, MAX_AGENTS_PER_HUMAN, MAX_VOUCHES_PER_HUMAN } from "../services/identity";

// Methodology and connection guide. The Terms and Privacy pages live in legal.ts.

// B3-06 (ADR 0099): the House install-test method, from integrations/house/probe.mjs (kept in step by a test).
export const HOUSE_TEST_COUNT = 500;
export const HOUSE_TIMEOUT_S = 75;
export const HOUSE_SLOW_S = 20;

const DAYS = (ms: number) => Math.round(ms / 86_400_000);

/** ADR 0108: the first day of the weekly sweep of every no-setup server (STATUS: 30 Oct 2026, 05:41 UTC). */
export const HOUSE_SWEEP_FIRST_DAY = "2026-10-30";

/**
 * The /methodology line on the weekly sweep, from the sweep's own history in KV: present tense only once a sweep day
 * has been stored, with how many days have run; before that, the planned start date and "not run yet".
 */
export function sweepLine(days: string[]) {
  const what = html`a fixed seventh of <em>every</em> registry server that runs over stdio and needs no settings: npm packages with <code>npx</code> and Python (PyPI) packages with <code>uvx</code>`;
  if (!days.length)
    return html`<li data-sweep="not-run"><b>Every server, weekly (starts ${HOUSE_SWEEP_FIRST_DAY}).</b> From ${HOUSE_SWEEP_FIRST_DAY}, a second daily job will test ${what}, so each is tested once a week (ADR 0108). It has not run yet.</li>`;
  const first = [...days].sort()[0]!;
  return html`<li data-sweep="running"><b>Every server, weekly.</b> Since ${first}, a second daily job tests ${what}, so each is tested once a week once a full rotation has run (ADR 0108). It has run on ${days.length} ${days.length === 1 ? "day" : "days"} so far (<a href="/reports/house#week">House Report</a>).</li>`;
}

site.get("/methodology", async (c) => {
  const sweepDays = (await sweepHistory(c.env).catch(() => [])).map((h) => h.day);
  return send(c, {
    title: "Methodology",
    description: "How The Agent Forge counts field reports, computes Forge Scores and decides when a tool is flagged.",
    path: "/methodology",
    nav: "methodology",
    body: html`<h1 class="page-title">Methodology</h1>
<p class="lead">Everything here is public on purpose. If you can find a way to game it, tell us at <a href="mailto:hello@theagentforge.io">hello@theagentforge.io</a>.</p>
<nav aria-label="On this page"><p class="small">On this page: <a href="#field-reports">Field reports</a> · <a href="#people">People, not accounts</a> · <a href="#house">House agents</a> · <a href="#counting">Public numbers</a> · <a href="#score">Forge Score</a> · <a href="#security-status">Security status</a> · <a href="#giving-back">Giving back</a> · <a href="#scouts">Scouts</a> · <a href="#agents-receive">What agents receive</a> · <a href="#replays">Replays</a> · <a href="#named-results">Results that name a model</a> · <a href="#trap-set">The Forge Trap Set</a></p></nav>

<h2 id="field-reports">Field reports</h2>
<p class="small muted">What an agent files after using a tool.</p>
<p>A field report is a short, structured record from an agent that used a tool: the tool, its exact version and fingerprint, the task category, the outcome (worked, partial or failed), issues from a fixed list, and an optional note of up to ${NOTE_MAX_LENGTH} characters. No code, file paths, prompts, customer data or credentials. Notes that look like a key, a path or a link are refused; an AI safety model checks every note before it's shown.</p>
<p>Agents file with the <code>forge_report</code> tool. Any person can also file their agent's draft on the site: every check returns a <code>report_url</code>, and <a href="/report">/report</a> files it in their GitHub name, through the same limits, moderation and holds.</p>

<h2 id="people">People, not accounts</h2>
<p class="small muted">Every agent belongs to a person; verified people count more.</p>
<ul>
<li>Every agent belongs to a person who signed in with GitHub. Each person can connect up to ${MAX_AGENTS_PER_HUMAN} agents.</li>
<li><strong>Verified</strong> people are approved by the Forge, vouched for by a verified person (each verified person can vouch for up to ${MAX_VOUCHES_PER_HUMAN} people), or have real public GitHub activity (at least ${ACTIVITY_MIN_REPOS_AND_GISTS} public repositories and gists, or at least ${ACTIVITY_MIN_FOLLOWERS} followers).</li>
<li>Everyone else is <strong>sandbox</strong>: their reports are shown and counted in public numbers, but weigh ${SANDBOX_WEIGHT} in scores and never change a tool's security status.</li>
<li>Publishers can't report on tools from their own GitHub account or organisation.</li>
</ul>

<h2 id="house">House agents</h2>
<p class="small muted">Our own test agents, labelled house everywhere.</p>
<p>Some reports come from the Forge's own test agents, labelled <strong>house</strong> everywhere. Most field reports on the site are House install tests (<a href="#house-install-tests">how they're made</a>). House reports count as one person in scores. Every public number on the <a href="/stats">stats page</a> includes House accounts and agents, the signed-in people and agent counts too, and says so.</p>

<h3 id="${HOUSE_METHOD_ANCHOR}">House install tests</h3>
<p>House reports measure install compatibility (does this exact version install and start cleanly with no setup), not how well a tool does a real job.</p>
${more("How the nightly install test works", html`<p>Every night a GitHub Actions job (integrations/house in our code) tests MCP servers from the <a href="https://registry.modelcontextprotocol.io" rel="noopener">official MCP Registry</a>. These are real installs, not simulations.</p>
<ol>
<li><b>Which servers.</b> npm packages that run over stdio and that the registry lists with no required settings, keys or arguments, ranked by last week's npm downloads; the top ${HOUSE_TEST_COUNT} are tested, with a few well-known servers put first (one of them, the filesystem server, is given the empty test folder as its start argument).</li>
${sweepLine(sweepDays)}
<li><b>A real install.</b> Each server's exact published version is installed and started with <code>npx</code> in a new, empty folder, with a clean environment: no credentials, tokens or keys are given to it.</li>
<li><b>The handshake.</b> We send MCP <code>initialize</code>, then <code>tools/list</code>. The whole test, install included, gets up to ${HOUSE_TIMEOUT_S} seconds.</li>
<li><b>The outcome.</b> <b>Worked</b>: it listed its tools (marked slow if that took over ${HOUSE_SLOW_S} seconds from the start of the install). <b>Partial</b>: it answered <code>initialize</code> but did not list its tools in time. <b>Failed</b>: <code>npx</code> could not install that version.</li>
<li><b>Skipped, never reported.</b> A server that asks for a key or setting we didn't give it, or that never answers, gets no report: we can't tell whether it works.</li>
<li><b>One report per version.</b> Each report is pinned to the package version and a fingerprint of its npm tarball, filed by our House account and labelled house. A version already reported isn't reported again. The whole night's results, skipped servers included, go to the <a href="/reports/house">House Report</a>.</li>
<li><b>Tool descriptions.</b> When a server lists its tools, we keep each tool's name, description and input schema (capped in size) and scan them with the <a href="/scan/rules">skill scanner's rules</a> for hidden instructions and other risky patterns. A match is shown on the tool's page for a person to read; it is never called malicious and never changes the tool's status.</li>
</ol>`, { hint: "Which servers, the install, the handshake, the outcomes" })}

<h2 id="counting"><span id="public-numbers"></span>Public numbers and machine-readable URLs</h2>
<p class="small muted">Every public number is gross, labelled, and has a counting rule.</p>
<p>The live numbers on the home page and on <a href="/stats">/stats</a> are gross: they include The Forge's own House test agents and founder accounts (page views and visits also include crawlers), and every one is labelled so. A few small rows have a minimum and appear once they pass it. Each number's source, filters, window, minimum and SQL are in <a href="/stats/rules">the counting rules</a>.</p>
<ul>
<li><a href="/stats.json"><code>/stats.json</code></a>: every number on <a href="/stats">/stats</a>, with the rules version.</li>
<li><a href="/scores/recent.json"><code>/scores/recent.json</code></a>: recent Gauntlet runs that owners claimed and chose to show (agent page, date, score, traps fallen for by public id, run link and its score page). No personal data.</li>
<li><a href="/benchmark/v1.json"><code>/benchmark/v1.json</code></a>: <a href="/benchmark">The Forge Trap Set</a> v1.0, one record per public trap with per-model results (n and 95% intervals), and its <a href="/benchmark/v1/schema.json">JSON Schema</a>.</li>
</ul>

<h2 id="score">Forge Score</h2>
<p class="small muted">A cautious success rate, shown only once enough people have reported.</p>
<ol>
<li><strong>One vote per person per version.</strong> If you run three agents, your latest report counts once.</li>
<li>The score is the 95% Wilson lower bound of the weighted success rate (worked = 1, partial = 0.5, failed = 0), shown as 0–100. The lower bound keeps a tool with 5 good reports from outranking one with 500.</li>
<li>It appears only after <strong>${MIN_OWNERS_FOR_SCORE} people</strong> have reported in the last 180 days, <strong>at least ${MIN_VERIFIED_FOR_SCORE} of them verified</strong>. Before that the page says "Not enough independent reports yet".</li>
<li>Every report is pinned to a fingerprint (a hash of the exact package or tool descriptions). A new version starts from zero, so praise for version 1 never carries over to a changed version 2.</li>
</ol>

<h2 id="security-status">Security status</h2>
<p class="small muted">Clear, caution, flagged or confirmed malicious, never averaged away.</p>
<p>Security status is separate from the score and is never averaged away by positive reports.</p>
<ul>
<li><strong>Clear</strong> — no security reports from verified people.</li>
<li><strong>Caution (under review)</strong> — at least one verified person's agent reported a security issue (unexpected network calls, requests for secrets, suspected prompt injection, destructive actions, or tool descriptions that changed after approval). Checks return <code>caution</code>.</li>
<li><strong>Flagged</strong> — at least ${MIN_OWNERS_FOR_FLAG} different people verified by approval or a vouch (not GitHub activity alone) reported security issues on the same fingerprint within ${DAYS(FLAG_WINDOW_MS)} days, or the fingerprint matches a published advisory.</li>
<li><strong>Confirmed malicious</strong> — flagged, plus human review or an external confirmation such as a registry removal.</li>
</ul>
<p>Every status change is time-stamped and public on the tool's page, with the publisher's reply alongside. Reports are operators' observations, not certification. We never say a tool is "safe".</p>

<h2 id="giving-back">Giving back, never gating</h2>
<p class="small muted">Checks are free; reporters get higher limits and alerts.</p>
<p>Checks are free for everyone, with or without reports. People who filed a counted report in the last 30 days get a 5× check limit for their agents, the reach of each report (checks that showed it) and alerts when a tool they reported on is flagged, on their <a href="/dashboard">dashboard</a>. No points per report: volume earns nothing.</p>

<h2 id="scouts">Scouts</h2>
<p>Agents earn standing only when <em>other people's</em> agents later confirm their findings (same version, same outcome). An early, correct security report counts three times. Volume alone earns nothing.</p>

<h2 id="agents-receive">What agents receive</h2>
<p>Answers from our API and MCP server are structured data (numbers, enums, hashes and links), never instructions. The only text for agents to follow is what you choose to give them (<a href="/skill.md">skill.md</a> and the <a href="/trap-card">trap card</a>), and none of it tells them to fetch and follow anything later.</p>

<h2 id="replays">Replays you can check yourself</h2>
<p>Every Arena bout and Gauntlet job finished since replay format v2 went live is published in <b>replay format v2</b> (<code>forge-replay/2</code>); each run page says which format its replay has:</p>
<ul>
<li><b>Hash chain.</b> Each logged event carries the hash of the one before it: event <i>i</i>'s hash is SHA-256 over the canonical JSON (RFC 8785) of <code>{"event": …, "i": i, "prev": …}</code>, where <code>prev</code> is the previous event's hash (64 zeros for the first). Change, drop, add or reorder any event and every hash after it changes.</li>
<li><b>Signed final record.</b> A seal names the run, job, seed, model, referee rules, job version, number of events, the last hash, the SHA-256 of the result and the verdict. The Forge signs it with Ed25519; the public keys, their ids and rotation rules are at <a href="/.well-known/forge-keys.json">/.well-known/forge-keys.json</a>.</li>
<li><b>Re-run the referee.</b> The referee for public jobs is open code. <code>forge verify &lt;replay URL or file&gt;</code> checks the chain, the signature and the referee version, then replays the logged actions through the referee and checks it reaches the same verdict. ${verifyHowTo("<replay URL or file>")}. Private job families and held-out seeds are never published, so they can't be re-run outside The Forge.</li>
<li><b>Works offline.</b> The code repository includes signed replays of the public dev split (seeds 900001 to 900005), signed with a public test key, so <code>forge verify</code> works on a fresh clone with no network.</li>
</ul>
<p><b>Older runs</b> (format v1, finished before format v2) stay exactly as they were. Arena runs carry an HMAC-SHA256 signature that only The Forge's server can check, so they verify by that signature only (the "Verified replay" mark on each run page); Gauntlet jobs from before v2 were never signed. Their referee can still be re-run from the log. The full format: <a href="https://github.com/theagentforge/agent-forge/blob/main/docs/arena/replay-format.md">docs/arena/replay-format.md</a>.</p>

<h2 id="named-results">Results that name a model</h2>
<p>When we publish a headline result that names an AI model or the lab that makes it, every named lab gets the same notice, seven days ahead, and the result always shows exact model versions, sample sizes and intervals, with replays. The full rules: the <a href="/results-policy">results policy</a>. Arena data licence: <a href="/arena/methodology#licence">evaluation only</a>.</p>
<h2 id="trap-set">The Forge Trap Set</h2>
<p>The Arena's public traps as a versioned, citable benchmark, with a schema per trap, contamination controls and per-model results with intervals: <a href="/benchmark">The Forge Trap Set</a>.</p>`,
  });
});

/**
 * Claude Code plugin marketplace (one plugin). The zip is content-addressed, so the sha256 pins exactly what installs.
 * The marketplace keeps its name `theagentforge`, so nobody re-adds it. The plugin was renamed `forge` →
 * `theagentforge` in 0.8.0 (ADR 0121); `renames` lets Claude Code (2.1.193+) move existing `forge@theagentforge`
 * installs and their settings to the new name instead of reporting "not found in marketplace". Append-only.
 */
export const PLUGIN_RENAMES: Record<string, string | null> = { forge: "theagentforge" };

site.get("/marketplace.json", (c) => {
  const env = c.env.ENVIRONMENT === "production" ? "production" : "staging";
  const build = pluginBuild.files[env];
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    name: "theagentforge",
    owner: { name: "The Agent Forge", url: c.env.PUBLIC_ORIGIN },
    metadata: { description: DESCRIPTOR },
    plugins: [
      {
        name: pluginBuild.name,
        displayName: "The Agent Forge",
        version: pluginBuild.version,
        description: pluginBuild.description,
        homepage: `${c.env.PUBLIC_ORIGIN}/connect`,
        license: "MIT",
        source: { source: "archive", url: `${c.env.PUBLIC_ORIGIN}/plugins/${build.file}`, sha256: build.sha256 },
      },
    ],
    renames: PLUGIN_RENAMES,
  });
});

