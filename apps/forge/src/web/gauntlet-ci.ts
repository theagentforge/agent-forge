import { OWASP_AGENTIC, publicTrapId, TRAP_CATALOG, trapSeverity, type OwaspAgenticId } from "@forge/arena";
import { html } from "hono/html";
import { ACTION_VERSION, CLIENT_TAG, DEFAULT_MAX_TURNS, TRAP_FAMILIES, VERIFY_CLI } from "../../../../integrations/gauntlet-action/src/run";
import { GAUNTLET_DAILY_PER_SOURCE, JOBS } from "../arena/gauntlet";
import { SPRINT_DAILY_PER_SOURCE, SPRINT_TOOL_CALLS } from "../arena/sprint";
import { copyBlock } from "./components";
import { send, site } from "./pages";

// ADR 0135: the Gauntlet in CI. The page for people who add the GitHub Action (integrations/gauntlet-action) to their
// repository. Wording rules: a pass is never "safe" or a certification; no counts of users or runs on this page.

export const GAUNTLET_CI_PATH = "/gauntlet/ci";
/** The published copy's address (a repository of its own, as for forge-check and skill-scan: docs/runbooks/publish-action.md). */
export const GAUNTLET_ACTION_USES = "theagentforge/gauntlet@v1";
/**
 * Whether theagentforge/gauntlet is released (the repository holds the action and `@v1` resolves). Until then the page
 * says so instead of offering a line that doesn't work yet. On since 13 Nov 2026 (ADR 0150): the repository holds the
 * v1.0.0 files on `main` and the `v1` branch, so `@v1` resolves, Marketplace listing or not (as forge-check since 16 Oct).
 */
export const GAUNTLET_ACTION_RELEASED = true;

/**
 * Harness, "The State of Agent DLC 2026" (Sapio Research survey for Harness, July 2026), read 13 Nov 2026: "Only 19%
 * actually have a gate that automatically blocks every bad release, no exceptions." The page gives 700 respondents,
 * technology professionals at large enterprises in five countries.
 */
export const HARNESS_GATE_STAT = {
  url: "https://www.harness.io/state-of-agent-dlc-2026",
  text: "In Harness's State of Agent DLC 2026 (a Sapio Research survey of 700 technology professionals at large enterprises, July 2026), 19% said they have a gate that automatically blocks every bad release.",
} as const;

/** The forge-check action (theagentforge/forge-check): fails CI when a tool the repository uses is flagged. */
export const FORGE_CHECK_USES = "theagentforge/forge-check@v1";

export interface OwaspRow {
  id: OwaspAgenticId;
  name: string;
  /** Traps in the Gauntlet's six jobs that the Trap Set's severity annotation maps to this category. */
  gauntlet: { trap: string; fit: "direct" | "partial" }[];
  /** Other public Trap Set traps mapped to it (played in the Arena, not by this action). */
  trapSetOnly: { trap: string; fit: "direct" | "partial" }[];
}

/**
 * What the gate tests, by OWASP Top 10 for Agentic Applications category, read from the published per-trap annotation
 * (packages/arena/src/severity.ts, "never forced"), so the page can't claim a category no trap is mapped to.
 */
export function gauntletOwasp(): OwaspRow[] {
  const inGauntlet = new Set(JOBS.flatMap((t) => t.traps.map((x) => publicTrapId(t.id, x.id)).filter((x): x is string => !!x)));
  return (Object.keys(OWASP_AGENTIC.categories) as OwaspAgenticId[]).map((id) => {
    const mapped = TRAP_CATALOG.map((e) => ({ trap: e.id, o: trapSeverity(e.id)?.owasp_agentic ?? null })).filter((x) => x.o?.id === id).map((x) => ({ trap: x.trap, fit: x.o!.fit }));
    return { id, name: OWASP_AGENTIC.categories[id], gauntlet: mapped.filter((x) => inGauntlet.has(x.trap)), trapSetOnly: mapped.filter((x) => !inGauntlet.has(x.trap)) };
  });
}

const fitList = (xs: { trap: string; fit: string }[]) => xs.map((x) => `${x.trap} (${x.fit})`).join(", ");

/**
 * The Gauntlet column of that mapping as a Markdown table, for the action's README (a test checks the README carries it
 * word for word). Only the six jobs' traps, which are frozen, so the Arena's growing catalog doesn't churn the README.
 */
export function owaspMarkdown(rows: OwaspRow[] = gauntletOwasp()) {
  const note = (r: OwaspRow) =>
    r.id === "ASI04"
      ? "Not tested by the Gauntlet. [forge-check](https://github.com/theagentforge/forge-check) fails CI when an MCP server or tool your repository uses is flagged (field reports, OSV advisories): known reports only."
      : r.id === "ASI02" && !r.gauntlet.length
        ? "Planted only in the harder Arena jobs, which this action doesn't play ([full mapping](https://theagentforge.io/gauntlet/ci#owasp))."
        : "";
  return [
    "| OWASP category | Gauntlet traps (fit) | Note |",
    "|---|---|---|",
    ...rows.filter((r) => r.gauntlet.length || r.id === "ASI02" || r.id === "ASI04").map((r) => `| ${r.id} ${r.name} | ${r.gauntlet.length ? fitList(r.gauntlet) : "none"} | ${note(r)} |`),
  ].join("\n");
}

const FAMILY_WORDS: Record<(typeof TRAP_FAMILIES)[number], string> = {
  PAY: "paid a scam or a changed payee",
  INJ: "followed a hidden instruction",
  DUP: "double payment or order",
  POL: "policy breach",
  AMT: "wrong amount",
  CLM: "false success or false claim",
  DAT: "deleted or merged the wrong record",
  TIM: "time zone or deadline",
  PRM: "permission overreach",
};

export const workflowExample = () => `# .github/workflows/gauntlet.yml
name: Forge Gauntlet
on: [pull_request]
permissions:
  contents: read
jobs:
  gauntlet:
    runs-on: ubuntu-latest
    steps:
      - uses: ${GAUNTLET_ACTION_USES}
        with:
          model: gpt-5-mini
          api-key: \${{ secrets.OPENAI_API_KEY }}`;

const commandExample = () => `      - uses: ${GAUNTLET_ACTION_USES}
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
        with:
          command: python agent/play_gauntlet.py
          mode: full
          fail-on-trap: PAY,INJ,PRM`;

site.get(GAUNTLET_CI_PATH, (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  return send(c, {
    title: "Gauntlet in CI: test your agent on every change",
    description: "A GitHub Action that runs your own agent through the Forge Gauntlet's planted-trap jobs on every pull request and fails the check if it falls for one. Your model, your key.",
    path: GAUNTLET_CI_PATH,
    nav: "gauntlet",
    body: html`<p class="eyebrow">The Forge Gauntlet · GitHub Action ${ACTION_VERSION}</p>
<h1 class="page-title">Test your agent on every change.</h1>
<p class="lead">The Gauntlet's everyday jobs, with planted traps, on every pull request: the check fails when your agent pays a changed payee, follows a hidden instruction or claims a job it didn't do. The job summary lists the traps it fell for, with each job's replay.</p>
${GAUNTLET_ACTION_RELEASED
  ? ""
  : html`<p class="notice" role="status">Not released yet: the <code>${GAUNTLET_ACTION_USES}</code> address works from its first release. The source is in <code>integrations/gauntlet-action</code> of the public code repository.</p>`}
<p class="small" data-action-links>On the GitHub Marketplace as <a href="https://github.com/marketplace/actions/forge-gauntlet">Forge Gauntlet</a>, version ${ACTION_VERSION}; source at <a href="https://github.com/theagentforge/gauntlet">github.com/theagentforge/gauntlet</a>.</p>
<h2>Add it in one file</h2>
<div class="copy-wrap">${copyBlock("gauntlet-ci-workflow", workflowExample())}</div>
<p class="small muted">Add your model key as a repository secret first (Settings, Secrets and variables, Actions). Any OpenAI-compatible endpoint works: set <code>base-url</code> for OpenRouter, Together, Groq, Azure OpenAI or a model served on the runner.</p>
<h2>Two ways to drive your agent</h2>
<ol class="steps">
<li><p><b>A chat model.</b> Give <code>model</code> and <code>api-key</code>. The action plays the agent loop on the runner: each job's tools are offered to the model, and each tool call goes to the Gauntlet. By default it uses the Arena's published harness prompt and ${DEFAULT_MAX_TURNS} replies a job, so results read against the Arena's; put your agent's own instructions in <code>system-prompt</code>.</p></li>
<li><p><b>Your own harness.</b> Give <code>command</code>. The action starts the run and gives your command its id and the Gauntlet MCP address (<code>FORGE_GAUNTLET_ID</code>, <code>FORGE_GAUNTLET_MCP_URL</code>); your agent plays it with <code>gauntlet_status</code> and <code>gauntlet_act</code>. The action then reads the result from The Forge, not from your command.</p>
<div class="copy-wrap">${copyBlock("gauntlet-ci-command", commandExample())}</div></li>
</ol>
<h2>When the check fails</h2>
<ul>
<li><code>fail-on-trap</code>: <code>any</code> sprung trap (the default), <code>none</code>, or trap families. The Forge publishes no per-trap severity, so families are the filter: ${TRAP_FAMILIES.map((f, i) => html`${i ? ", " : ""}<code>${f}</code> ${FAMILY_WORDS[f]}`)}.</li>
<li><code>min-pass-rate</code>: also fail when fewer than this percentage of jobs are right.</li>
<li>A run your agent didn't finish always fails, even with no trap sprung: a job where its replies, tool calls or time ran out counts as unfinished. The action never calls <code>finish</code> for your agent.</li>
<li><code>mode</code>: <code>sprint</code> (the default: one job, at most ${SPRINT_TOOL_CALLS} sandbox tool calls) or <code>full</code> (six jobs). With <code>full</code>, <code>challenge</code> set to an earlier run's id replays its identical jobs, so before and after a change compare like for like. Sprints use a fresh job version each time.</li>
</ul>
<h2 id="gate">A blocking gate, by default</h2>
<p>When your agent falls for a planted trap, the step exits non-zero, so the job fails. Make the job a required status check (branch protection or a ruleset) and a pull request can't merge until the agent passes. To report without blocking, set <code>fail-on-trap: none</code>; to block on some trap families only, list them.</p>
<p class="small">${HARNESS_GATE_STAT.text} <a href="${HARNESS_GATE_STAT.url}">Source</a>.</p>
<h2 id="evidence">Signed replays as audit evidence</h2>
<p>Every job the agent played has a replay: the full log of its tool calls and the referee's result, hash-chained and signed with The Forge's <a href="/.well-known/forge-keys.json">published Ed25519 key</a> (replay format v2). The action puts each job's replay link in the output <code>replay-urls</code> and the job summary, and says how many are signed (<code>replays-signed</code>). Anyone can check one without trusting The Forge or your CI:</p>
<pre class="verdict-line">npx ${VERIFY_CLI} verify ${origin}/gauntlet/r/&lt;run-id&gt;/1.json</pre>
<p class="small muted">The Forge keeps Gauntlet replays 30 days. To keep them as evidence for longer, download the files in a later step and store them with your build (for example as a workflow artifact). A signed replay shows what the agent did on these jobs, and that the record wasn't changed afterwards. It records a test result on these jobs, nothing more.</p>
<h2 id="owasp">What it tests, against the OWASP Top 10 for Agentic Applications</h2>
<p>Each public trap carries the closest <a href="${OWASP_AGENTIC.source.url}">OWASP Top 10 for Agentic Applications for 2026</a> category, or none where none fits (never forced; see <a href="/benchmark">the Trap Set</a>). Read from that annotation, for the Gauntlet's six jobs:</p>
<div class="table-wrap"><table class="table" data-owasp><thead><tr><th scope="col">OWASP category</th><th scope="col">Gauntlet traps (fit)</th><th scope="col">Elsewhere in The Forge</th></tr></thead><tbody>
${gauntletOwasp()
  .filter((r) => r.gauntlet.length || r.trapSetOnly.length || r.id === "ASI02" || r.id === "ASI04")
  .map(
    (r) => html`<tr data-asi="${r.id}"><td>${r.id} ${r.name}</td><td>${r.gauntlet.length ? r.gauntlet.map((x, i) => html`${i ? ", " : ""}<a href="/arena/failures/${x.trap}">${x.trap}</a> (${x.fit})`) : "none"}</td><td>${
      r.id === "ASI04"
        ? html`Not tested by the Gauntlet. The <a href="https://github.com/theagentforge/forge-check">forge-check</a> action (<code>${FORGE_CHECK_USES}</code>) fails CI when an MCP server or tool your repository uses is flagged by field reports or OSV advisories: known reports only.`
        : r.trapSetOnly.length
          ? html`Arena Trap Set only: ${r.trapSetOnly.map((x, i) => html`${i ? ", " : ""}<a href="/arena/failures/${x.trap}">${x.trap}</a> (${x.fit})`)}`
          : "none"
    }</td></tr>`,
  )}
</tbody></table></div>
<p class="small muted">The Gauntlet's six jobs are the Trap Set's Normal jobs; tool misuse (ASI02) is planted only in the harder Arena jobs, which this action doesn't play. Categories with no public trap are left out.</p>
<h2>What it sends, and what it costs</h2>
<ul>
<li><b>Your key goes only to your model.</b> The action sends it to your <code>base-url</code> and nowhere else (redirects are refused), and masks it in the log. The Forge gets what any Gauntlet run sends: the start and each tool call (name and arguments). Never the key, the model's name, its text replies, your repository or your account.</li>
<li><b>No charge from The Forge.</b> The referee replays tool calls in a sandbox, so a run costs only your own model calls: with the default <code>max-turns</code>, a Sprint at most ${DEFAULT_MAX_TURNS}, a full run at most ${DEFAULT_MAX_TURNS * 6}.</li>
<li><b>Same limits as everyone:</b> ${SPRINT_DAILY_PER_SOURCE} Sprints and ${GAUNTLET_DAILY_PER_SOURCE} full runs a day per address, and 60 calls a minute per run. An outage, a daily limit or an empty key (a fork's pull request gets no secrets) doesn't block your CI unless you set <code>fail-on-error: true</code>.</li>
<li><b>Counting:</b> the start address carries the fixed tag <code>?client=${CLIENT_TAG}</code>, which only adds to a daily count of runs started from the action (at most one a day per runner address). Nothing about you is in it.</li>
<li><b>Off by default:</b> the pull request comment (<code>comment: true</code>) and the claim link for a score page and badge (<code>claim-link: true</code>, a masked output). Runs stay anonymous unless an owner claims one.</li>
</ul>
<p class="muted">A pass means your agent didn't fall for these traps on these jobs. It is a test result, not a statement that an agent is safe.</p>
<p><a class="text-link" href="/gauntlet">Run the Gauntlet by hand →</a> <a class="text-link" href="/benchmark">The Trap Set →</a></p>`,
  });
});
