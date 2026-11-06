import { html } from "hono/html";
import { ACTION_VERSION, CLIENT_TAG, DEFAULT_MAX_TURNS, TRAP_FAMILIES } from "../../../../integrations/gauntlet-action/src/run";
import { GAUNTLET_DAILY_PER_SOURCE } from "../arena/gauntlet";
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
 * says so instead of offering a line that doesn't work yet. Flip it with the first release (Dinike's Marketplace step).
 */
export const GAUNTLET_ACTION_RELEASED = false;

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
