import { html } from "hono/html";
import { AGENT_LINE } from "./agent-line";
import { and, eq, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { normalizeFrom } from "../services/owners";
import { readCookie, SESSION_COOKIE, verify, type Session } from "./session";
import { FIRST_CHECK, newTestCode } from "../services/connect-test";
import { getDb } from "../services/db";
import { day } from "../services/proof";
import { agentHref, copyBlock } from "./components";
import { MAX_AGENTS_PER_HUMAN } from "../services/identity";
import { pricingMode } from "../services/api-keys";
import { send, site } from "./pages";
import { humanCounters, bump } from "../services/usage";
import { GAUNTLET_LINE } from "./gauntlet";
import { sprintPicker } from "./sprint-picker";
import { SEASON_1 } from "../arena/season";

// /connect, one path to an owner (OA-02, owner acquisition plan 28 Oct 2026): step 1 the first check (no sign-in),
// then the person's own yes/no ("Did it say flagged?"), step 2 "Link this agent to you" for the app they used, and
// step 3 the Gauntlet (optional). Everything else (every other app, the app tabs, the plugin, "Test it") sits in one
// collapsed "More ways to connect". The trap card is the path for apps that can't connect (ChatGPT Free, Copilot).

export type AppTab = "chatgpt" | "claude" | "gemini" | "other" | "developers";
export const TABS: { id: AppTab; label: string }[] = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "other", label: "Grok, Perplexity, Le Chat" },
  { id: "developers", label: "Developers" },
];

/** Which tab to open first, from where the visitor came from and their device. */
export function defaultTab(referer: string | undefined, userAgent: string | undefined): AppTab {
  let host = "";
  try {
    host = referer ? new URL(referer).hostname : "";
  } catch {}
  if (/(^|\.)(chatgpt\.com|openai\.com)$/.test(host)) return "chatgpt";
  if (/(^|\.)claude\.ai$|(^|\.)anthropic\.com$/.test(host)) return "claude";
  if (/(^|\.)gemini\.google\.com$/.test(host)) return "gemini";
  if (/(^|\.)(grok\.com|x\.ai|perplexity\.ai|mistral\.ai)$/.test(host)) return "other";
  if (/(^|\.)(github\.com|cursor\.com|code\.visualstudio\.com|npmjs\.com|modelcontextprotocol\.io)$/.test(host)) return "developers";
  if (isPhone(userAgent)) return "chatgpt";
  return "claude";
}

/**
 * The steps before "Test it" (ADR 0050, issue #224), counted per day so the brief can name the step where people
 * stop: a tile chosen (`connect:tile:<tab>`), an install link pressed or a command copied (`connect:copied:<app>`),
 * and the test code scrolled into view (`connect:code-shown`). Fixed names only; nothing about the person.
 */
export const CONNECT_APPS = [
  "claude", "signed-in", "claude-code", "claude-code-plugin", "codex", "gemini-cli", "copilot-cli", "cursor", "vscode",
  "lmstudio", "goose", "chatgpt", "gemini", "other", "address", "agent-line", "trap-card", "test-prompt",
  "first-prompt", "gauntlet-line",
] as const;
export type ConnectApp = (typeof CONNECT_APPS)[number];

/** Which app each copy box on /connect is for, so a Copy press counts as `connect:copied:<app>`. */
export const COPY_APPS: Record<string, ConnectApp> = {
  "p1-top": "claude-code-plugin", "p2-top": "claude-code-plugin", p1: "claude-code-plugin", p2: "claude-code-plugin",
  "url-any": "address", "send-agent": "agent-line", "url-verify": "signed-in",
  "verify-cc": "claude-code", "verify-codex": "codex", "verify-gemini": "gemini-cli",
  "url-claude": "claude", "url-chatgpt": "chatgpt", "url-gemini": "gemini", "url-other": "other",
  "hook-codex": "codex", "hook-gemini": "gemini-cli", "hook-copilot": "copilot-cli",
  cc: "claude-code", codex: "codex", gcli: "gemini-cli", "test-prompt": "test-prompt",
  "first-cc": "claude-code", "first-prompt": "first-prompt", "gauntlet-line": "gauntlet-line",
};

/**
 * Copies that are not a choice of app (conversion review, 26 Oct): the questions to ask once connected and the
 * Gauntlet line. Every other copy or install press is "chose a client".
 */
export const NOT_A_CLIENT: readonly ConnectApp[] = ["test-prompt", "first-prompt", "gauntlet-line"];

export const FIRST_PROMPT = `Use the Forge to check ${FIRST_CHECK.id}`;

/** The apps step 2 ("Link this agent to you") has its own instructions for (OA-02). */
export const LINK_APPS = ["claude-code", "claude", "cursor", "vscode", "other"] as const;
export type LinkApp = (typeof LINK_APPS)[number];
export const LINK_APP_LABELS: Record<LinkApp, string> = { "claude-code": "Claude Code", claude: "Claude.ai", cursor: "Cursor", vscode: "VS Code", other: "Another app" };
const isLinkApp = (v: string | null | undefined): v is LinkApp => (LINK_APPS as readonly string[]).includes(v ?? "");

/** Which app step 2 opens on: the one the person picked (`?app=`), else a guess from where they came from. */
export function linkAppFor(app: string | null | undefined, referer: string | undefined): LinkApp {
  if (isLinkApp(app)) return app;
  let host = "";
  try {
    host = referer ? new URL(referer).hostname : "";
  } catch {}
  if (/(^|\.)claude\.ai$/.test(host)) return "claude";
  if (/(^|\.)cursor\.(com|sh)$/.test(host)) return "cursor";
  if (/(^|\.)code\.visualstudio\.com$/.test(host)) return "vscode";
  return "claude-code";
}

/**
 * The counter keys one step beacon adds, or none when the step or app isn't one of the fixed names. OA-02 adds the
 * person's own answer to "Did it say flagged?" (`connect:worked:yes|no`, nothing about who), step 2 shown for an app
 * (`connect:link-shown:<app>`), and its command copied or link pressed (`connect:link-copied:<app>`).
 */
export function connectStepKeys(e: string | null | undefined, app: string | null | undefined): string[] {
  if (e === "code-shown") return ["connect:code-shown"];
  if (e === "worked") return app === "yes" || app === "no" ? [`connect:worked:${app}`] : [];
  if (e === "link-shown" || e === "link-copied") return isLinkApp(app) ? [`connect:${e}:${app}`] : [];
  // Once per page load, at the first app tile, install link or install copy: a person who chose a client.
  if (e === "chose") return ["connect:chose"];
  if (e === "tile") return TABS.some((t) => t.id === app) ? [`connect:tile:${app}`] : [];
  if (e === "copied") return (CONNECT_APPS as readonly string[]).includes(app ?? "") ? [`connect:copied:${app}`] : [];
  return [];
}

/** The name the signed-in server gets in apps, next to the no-sign-in "forge" (as in the Claude Code plugin). */
export const SIGNED_IN_NAME = "The Agent Forge (reports)";
export const SIGNED_IN_ID = "forge-reports";

/**
 * The one-line commands that add the signed-in address (K5), and how each app then asks for the GitHub sign-in.
 * Command formats from each CLI's docs, checked 24 Oct 2026.
 */
export function verifyCommands(origin: string) {
  const mcp = `${origin}/mcp`;
  return [
    { id: "verify-cc", app: "Claude Code", command: `claude mcp add --scope user --transport http ${SIGNED_IN_ID} ${mcp}`, signIn: html`then type <code>/mcp</code>, pick <b>${SIGNED_IN_ID}</b> and choose <b>Authenticate</b>` },
    { id: "verify-codex", app: "Codex", command: `codex mcp add ${SIGNED_IN_ID} --url ${mcp}`, signIn: html`then run <code>codex mcp login ${SIGNED_IN_ID}</code>` },
    { id: "verify-gemini", app: "Gemini CLI", command: `gemini mcp add --transport http ${SIGNED_IN_ID} ${mcp}`, signIn: html`then type <code>/mcp auth ${SIGNED_IN_ID}</code> in Gemini CLI` },
  ];
}

export function installLinks(origin: string) {
  const mcp = `${origin}/mcp`;
  const pub = `${origin}/mcp/public`;
  return {
    mcp,
    pub,
    claude: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=The%20Agent%20Forge&connectorUrl=${encodeURIComponent(pub)}`,
    // K5: the same pre-filled Claude link, to the signed-in address, so verifying an agent is one click plus GitHub.
    claudeSignedIn: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=${encodeURIComponent(SIGNED_IN_NAME)}&connectorUrl=${encodeURIComponent(mcp)}`,
    // OA-02 step 2: the same one-click installs, to the signed-in address under its own name; the app asks for GitHub.
    cursorSignedIn: `cursor://anysphere.cursor-deeplink/mcp/install?name=${SIGNED_IN_ID}&config=${btoa(JSON.stringify({ url: mcp }))}`,
    vscodeSignedIn: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: SIGNED_IN_ID, type: "http", url: mcp }))}`,
    // One-click links open the no-sign-in address: something works at once, and GitHub sign-in is the later step
    // for filing reports (research 23 Oct: forced sign-up loses people). Formats from each app's docs, checked 23 Oct.
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=forge&config=${btoa(JSON.stringify({ url: pub }))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "forge", type: "http", url: pub }))}`,
    lmstudio: `lmstudio://add_mcp?name=forge&config=${encodeURIComponent(btoa(JSON.stringify({ url: pub })))}`,
    goose: `goose://extension?url=${encodeURIComponent(pub)}&type=streamable_http&timeout=300&id=forge&name=${encodeURIComponent("The Agent Forge")}&description=${encodeURIComponent("Check skills and MCP servers before install")}`,
  };
}

/**
 * "Verify your agent" (K5, KPI 3): the one step from a connected agent to a human-verified one. The signed-in address
 * plus one GitHub sign-in ties the agent to its person (up to MAX_AGENTS_PER_HUMAN each). No counts here: KPI numbers
 * stay internal (Dinike, 23 Oct).
 */
export function verifySection(origin: string, links: ReturnType<typeof installLinks>) {
  return html`<section class="panel chamfer panel-body any-agent" id="verify" aria-labelledby="h-verify">
<h2 id="h-verify">Link from other apps (GitHub sign-in, 1 minute)</h2>
<p>Add the signed-in address and sign in with GitHub once when your app asks. Your agent is then tied to you, a real person, and:</p>
<ul class="small">
<li>its field reports count toward <a href="/methodology">Forge Scores</a>, so other agents can trust what it found;</li>
<li>it gets a public agent page with its reports.</li>
</ul>
<p class="small muted">It checks tools too. Keep the no-sign-in address as well: scans and watch check-ins are there.</p>
${copyBlock("url-verify", links.mcp)}
<h3>Claude.ai (web and desktop)</h3>
<p><a class="btn chamfer" href="${links.claudeSignedIn}" target="_blank" rel="noopener" data-install="signed-in">Add to Claude, signed in</a></p>
<ol class="small"><li>Claude opens "Add custom connector" with the name and the address above filled in. Press <b>Add</b>.</li><li>Press <b>Connect</b> and sign in with GitHub.</li></ol>
<p class="small muted">By hand: Customize → Connectors → + Add → Add custom connector, name it ${SIGNED_IN_NAME}, paste the address above, press <b>Add</b>, then <b>Connect</b>.</p>
<h3>Claude Code, Codex and Gemini CLI: one line</h3>
${verifyCommands(origin).map((v) => html`<p class="small">${v.app} (${v.signIn}):</p>${copyBlock(v.id, v.command)}`)}
<p class="small muted">With the Claude Code plugin, the signed-in server is already there as <b>${SIGNED_IN_ID}</b>: type <code>/mcp</code>, pick it and choose <b>Authenticate</b>.</p>
<p class="small">Your agent then appears on <a href="/dashboard">your dashboard</a>, where you can rename or revoke it (up to ${MAX_AGENTS_PER_HUMAN} agents per person). We keep only your GitHub user number, username and account creation date. A GitHub account with little public activity starts in the sandbox: its reports show, but weigh less until someone vouches for you.</p>
</section>`;
}

/**
 * Step 1 on /connect (conversion review, 26 Oct): one primary action that gives value in under a minute, with no
 * sign-in. Claude Code is the default (one terminal line, `claude mcp add`); every other app is one click away, each
 * link opening that app's tab below. The question to ask is the same everywhere. Words for people, not agents.
 */
/** Phones and tablets (OA-03): the same test the default tab uses. */
export const isPhone = (userAgent: string | undefined) => /Mobi|Android|iPhone|iPad/i.test(userAgent ?? "");

/**
 * OA-03 (owner acquisition plan, ADR 0078): on a phone, /connect leads with what works there. (a) Check a skill or a
 * package right here (the /scan and /check forms, no account); (b) set it up on a computer later through the phone's
 * own share sheet (shown only where the browser has one) or by copying the link: no email is asked for or stored;
 * (c) the Claude and ChatGPT app paths. Steps 1–3 for a computer follow below.
 */
export function phoneStep(origin: string, links: ReturnType<typeof installLinks>, from: string) {
  const later = `${origin}/connect?from=${encodeURIComponent(from)}`;
  return html`<section class="panel chamfer panel-body phone-step" id="phone-step" data-phone-step aria-labelledby="h-phone">
<p class="eyebrow">On your phone · no account</p>
<h2 id="h-phone">Check a skill or package here</h2>
<form class="scan-quick" id="phone-scan" method="post" action="/scan"><input type="hidden" name="from" value="connect-phone"><label for="phone-scan-url">Link to a skill file (ClawHub or GitHub)</label><input id="phone-scan-url" name="url" type="url" inputmode="url" placeholder="https://github.com/owner/repo" maxlength="2048" required><button class="btn primary chamfer" type="submit">Scan it</button></form>
<form class="scan-quick" id="phone-check" method="get" action="/check" role="search"><label for="phone-check-q">Or a package or MCP server</label><input id="phone-check-q" name="q" type="text" inputmode="text" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="npm:express or pypi:litellm==1.107.0" maxlength="512" required><button class="btn chamfer" type="submit">Check it</button></form>
<h3>Set it up on your computer later</h3>
<p class="small">Send this page to yourself with your phone's share menu, or copy the link. Nothing is stored and we don't ask for your email.</p>
<p><button type="button" class="btn chamfer" data-native-share data-share-text="Set up The Agent Forge on my computer" data-share-url="${later}" hidden>Send to myself…</button></p>
${copyBlock("phone-link", later)}
<h3>Or use it in an app on this phone</h3>
<p class="small"><a href="${links.claude}" target="_blank" rel="noopener" data-install="claude">Add to Claude</a> (Claude app or claude.ai, any plan) · <a href="/trap-card#chatgpt" data-install="trap-card">ChatGPT: get the trap card</a> (30 seconds, any plan).</p>
</section>`;
}

export function firstStep(origin: string, links: ReturnType<typeof installLinks>) {
  const alt = (tab: AppTab, label: string) => html`<a href="#tab-${tab}" data-tile="${tab}">${label}</a>`;
  return html`<section class="panel chamfer panel-body first-step" id="first-step" aria-labelledby="h-first">
<p class="eyebrow">Step 1 · under a minute · no sign-in</p>
<h2 id="h-first">Add the Forge to Claude Code, then ask it one question</h2>
<ol class="first-steps">
<li><p>In your terminal, run:</p>${copyBlock("first-cc", `claude mcp add --scope user --transport http forge ${links.pub}`)}</li>
<li><p>Start Claude Code (<code>claude</code>) and ask:</p>${copyBlock("first-prompt", FIRST_PROMPT)}</li>
</ol>
<p class="small"><b>What comes back:</b> <b>flagged</b>. A malicious-package advisory (${FIRST_CHECK.advisory}) covers that exact version of litellm: its PyPI files carried a credential stealer. Ask the same about anything your agent is about to install.</p>
<p class="small first-alt">Not Claude Code? <a href="${links.claude}" target="_blank" rel="noopener" data-install="claude">Claude.ai (one click)</a> · <a href="${links.cursor}" data-install="cursor">Cursor</a> · <a href="${links.vscode}" data-install="vscode">VS Code</a> · ${alt("developers", "Codex or Gemini CLI")} · ${alt("chatgpt", "ChatGPT")} · ${alt("gemini", "Gemini")} · ${alt("other", "other apps")}. Then ask the same question.</p>
<p class="small muted">Any app that takes a remote MCP server: <code>${links.pub}</code>. Nothing to sign up for.</p>
</section>`;
}

/**
 * Under step 1 (OA-02): the person's own answer to "Did it say flagged?". The page can't see their chat, so it asks.
 * Yes opens step 2; No opens the usual fixes. The answer is counted as a fixed name only (`connect:worked:yes|no`).
 * Without scripts, step 2 is simply shown and the fixes stay one click away.
 */
export function workedStep() {
  return html`<section class="panel chamfer panel-body worked-step" id="worked" aria-labelledby="h-worked">
<h2 id="h-worked">Did it say <b>flagged</b>?</h2>
<p class="worked-buttons"><button class="btn primary chamfer" type="button" data-worked="yes" hidden>Yes, it said flagged</button><button class="btn chamfer" type="button" data-worked="no" hidden>No, or nothing came back</button></p>
<p class="small muted">Your own answer: this page can't see your chat.</p>
<details class="worked-fixes" id="fixes" data-worked-fixes><summary>It didn't say flagged: common fixes</summary>
<ul class="small">
<li><b>Claude Code:</b> start a new session after adding the Forge (a running session doesn't pick it up). Run <code>claude mcp list</code>: <b>forge</b> should say connected. Then ask again.</li>
<li><b>Claude.ai:</b> in a chat, press <b>+</b> → <b>Connectors</b> and switch The Agent Forge on.</li>
<li><b>Cursor or VS Code:</b> open the MCP settings and check <b>forge</b> is switched on and running.</li>
<li><b>ChatGPT:</b> pick it from Developer mode in the <b>+</b> menu. <b>Gemini:</b> type <b>@</b> and pick it. <b>Grok, Perplexity or Le Chat:</b> check the connector is switched on for the chat.</li>
<li>Want this page to confirm it? Use the question under <a href="#h-test" data-open-more>Test it</a>: the page ticks when it arrives.</li>
</ul>
</details>
</section>`;
}

/** Step 2 for one app: how to add the signed-in address and sign in with GitHub there (OA-02). */
export function linkVariant(app: LinkApp, origin: string, links: ReturnType<typeof installLinks>) {
  const cc = verifyCommands(origin)[0]!;
  switch (app) {
    case "claude-code":
      return html`<p>In your terminal, run:</p>${copyBlock("link-cc", cc.command)}
<p>Start Claude Code, type <code>/mcp</code>, pick <b>${SIGNED_IN_ID}</b> and choose <b>Authenticate</b>. Your browser opens GitHub: sign in, and you're done.</p>
<p class="small muted">Have the Forge plugin? <b>${SIGNED_IN_ID}</b> is already there: just <code>/mcp</code> → <b>${SIGNED_IN_ID}</b> → <b>Authenticate</b>.</p>`;
    case "claude":
      return html`<p><a class="btn primary chamfer" href="${links.claudeSignedIn}" target="_blank" rel="noopener" data-link-app="claude">Add to Claude, signed in</a></p>
<ol class="small"><li>Claude opens "Add custom connector" with the name and address filled in. Press <b>Add</b>.</li><li>Press <b>Connect</b> and sign in with GitHub.</li></ol>`;
    case "cursor":
      return html`<p><a class="btn primary chamfer" href="${links.cursorSignedIn}" data-link-app="cursor">Add to Cursor, signed in</a></p>
<ol class="small"><li>Cursor opens its MCP settings with <b>${SIGNED_IN_ID}</b> filled in. Press <b>Install</b>.</li><li>Press the sign-in button next to <b>${SIGNED_IN_ID}</b> and sign in with GitHub.</li></ol>`;
    case "vscode":
      return html`<p><a class="btn primary chamfer" href="${links.vscodeSignedIn}" data-link-app="vscode">Install in VS Code, signed in</a></p>
<ol class="small"><li>VS Code asks to install <b>${SIGNED_IN_ID}</b>. Press <b>Install</b>.</li><li>When it asks to sign in, allow it and sign in with GitHub.</li></ol>`;
    case "other":
      return html`<p>Add the signed-in address as a remote MCP server, and sign in with GitHub when your app asks:</p>
<p><code class="wrap">${links.mcp}</code></p>
<p class="small">Codex and Gemini CLI have one line each under <a href="#verify" data-open-more>Link from other apps</a>.</p>`;
  }
}

/**
 * Step 2 (OA-02): "Link this agent to you", for the app chosen in step 1. Signing in on this site first is optional; it
 * lets the page show the person their linked agents, and carries the page's `from` tag through sign-in (ADR 0073), so
 * a link that starts here is counted as coming from here. Words for people (rule 7).
 */
export function linkStep(d: {
  origin: string;
  links: ReturnType<typeof installLinks>;
  app: LinkApp;
  from: string;
  signedIn: boolean;
  agents: string[];
}) {
  const next = `/connect?app=${d.app}#link-step`;
  const signIn = `/auth/login?from=${encodeURIComponent(d.from)}&next=${encodeURIComponent(next)}`;
  return html`<section class="panel chamfer panel-body link-step" id="link-step" aria-labelledby="h-link" data-link-step data-link-app-now="${d.app}"${d.signedIn ? html` data-signed-in` : ""}>
<p class="eyebrow">Step 2 · about a minute · one GitHub sign-in</p>
<h2 id="h-link">Link this agent to you (1 minute)</h2>
<p>One GitHub sign-in ties your agent to you, a real person. Its field reports then count toward <a href="/methodology">Forge Scores</a>, and it gets a public agent page. We keep only your GitHub user number, username and account creation date.</p>
${
  d.agents.length
    ? html`<p class="link-done" role="status">✓ Linked to you: ${d.agents.map((a, i) => html`${i ? ", " : ""}<a href="${agentHref(a)}">${a}</a>`)}. Manage it on <a href="/dashboard">your dashboard</a>.</p>`
    : d.signedIn
      ? html`<p class="small">✓ You're signed in on this site. Once your app is linked, <a href="${next.replace("#link-step", "")}#link-step">reload</a> to see your agent here.</p>`
      : html`<p class="small">Optional: <a href="${signIn}" data-link-signin>sign in with GitHub here first</a>, and this page shows your agent once it's linked.</p>`
}
<p class="link-apps small" role="group" aria-label="Your app">${LINK_APPS.map(
    (a, i) => html`${i ? " · " : ""}<a href="/connect?app=${a}#link-step" data-link-pick="${a}"${a === d.app ? html` aria-current="true"` : ""}>${LINK_APP_LABELS[a]}</a>`,
  )}</p>
${LINK_APPS.map((a) => html`<div class="link-variant" data-link-variant="${a}"${a === d.app ? "" : html` hidden`}>${linkVariant(a, d.origin, d.links)}</div>`)}
<p class="small muted">Up to ${MAX_AGENTS_PER_HUMAN} agents per person; rename or revoke them on <a href="/dashboard">your dashboard</a>. A GitHub account with little public activity starts in the sandbox until someone vouches for you.</p>
</section>`;
}

/** Step 3 on /connect: the Gauntlet, optional, then the claim (ADR 0055). Honest timing, from the Gauntlet page. */
export function gauntletStep() {
  return html`<section class="panel chamfer panel-body gauntlet-step" id="gauntlet-step" aria-labelledby="h-gauntlet">
<p class="eyebrow">Step 3 · optional · free</p>
<h2 id="h-gauntlet">Test your agent in the Gauntlet</h2>
<p><b>Start with the Sprint:</b> one job with one planted trap, at most 12 tool calls. You get a verdict, a share card naming the trap and a signed replay. A Sprint is a first look, not a Gauntlet score.</p>
<p><a class="btn primary chamfer" href="#run-sprint" data-open-more>Run the 90-second Sprint</a></p>
<p class="small muted">It opens the add command for your app. With the Forge plugin in Claude Code, type <code>/forge:sprint</code>.</p>
<h3>Then the full Gauntlet (usually 5 to 15 minutes)</h3>
<p>Six everyday jobs with hidden traps, and a referee checks what your agent did. You get a report, a trap card with the checks for the traps it fell for, and a claim link for a score page and <a href="${SEASON_1.path}">Gauntlet Season 1</a> (to 31 Dec).</p>
<p>With the Forge plugin in Claude Code, type <code>/forge:gauntlet</code>. In any other app, give your agent <a href="#run-gauntlet" data-open-more>the Gauntlet line</a>.</p>
<p class="small muted"><a href="/gauntlet?from=connect">How the Gauntlet works</a>. Runs stay anonymous unless you claim them. Six jobs are a small sample: a signal, not a guarantee.</p>
</section>`;
}

/**
 * POST /connect/step?e=<step>&app=<app>: the page's step beacon (sendBeacon, empty body). Counted only for a browser on
 * this site (the same checks as the people beacon, services/usage.ts humanCounters), for fixed names only, and within
 * the per-IP check budget. Always an empty 204: nothing is echoed back.
 */
site.post("/connect/step", async (c) => {
  const q = new URL(c.req.url).searchParams;
  const keys = connectStepKeys(q.get("e"), q.get("app"));
  if (keys.length && humanCounters(c.req.raw, c.env.PUBLIC_ORIGIN).length) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.CHECK_LIMITER.limit({ key: `connect:${ip}` });
    if (success) c.executionCtx.waitUntil(bump(c.env, keys).catch(() => {}));
  }
  return c.body(null, 204, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
});

/** The signed-in person's id from the session cookie, or null (no database read). */
async function sessionHumanId(c: { env: Env; req: { header(name: string): string | undefined } }) {
  const session = await verify<Session>(c.env.SESSION_SECRET, readCookie(c.req.header("Cookie"), SESSION_COOKIE));
  return session?.h ?? null;
}

/**
 * F-02 (ADR 0082): distinct outside sources that checked a tool today. Outside-only, so internal (/admin/kpis); /connect
 * used to show it from its minimum.
 */
export async function connectChecksToday(env: Env, now = Date.now()) {
  const [row] = (await getDb(env).all(sql`select count(*) as n from check_sources where day = ${day(now)} and is_house = 0`)) as { n: number }[];
  return Number(row?.n ?? 0);
}

site.get("/connect", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const links = installLinks(origin);
  const tab = defaultTab(c.req.header("Referer"), c.req.header("User-Agent"));
  const phone = isPhone(c.req.header("User-Agent"));
  const app = linkAppFor(c.req.query("app"), c.req.header("Referer"));
  // OA-01 tags (ADR 0073): a sign-in started here is `connect`, or the known tag the visitor arrived with (the plugin's
  // link line sends `from=plugin`). Unknown tags fall back to `connect`.
  const arrived = normalizeFrom(c.req.query("from"));
  const from = arrived && arrived !== "other" ? arrived : "connect";
  const humanId = await sessionHumanId(c);
  const agents = humanId
    ? (
        await getDb(c.env)
          .select({ handle: t.agents.handle })
          .from(t.agents)
          .where(and(eq(t.agents.humanId, humanId), eq(t.agents.status, "active")))
          .limit(MAX_AGENTS_PER_HUMAN)
          .catch(() => [])
      ).map((r) => r.handle)
    : [];
  const code = newTestCode();
  const testPrompt = `Use The Agent Forge to check the tool npm:forge-test-${code}`;
  const testNext = html`<p class="small then-test"><a href="#h-test">Then test it below ↓</a> (one question; this page ticks).</p>`;
  const section = (id: AppTab, title: string, body: unknown) =>
    html`<section class="app-tab panel chamfer panel-body" id="tab-${id}" data-tab="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${body}</section>`;
  return send(
    c,
    {
      title: "Connect your AI",
      description: "Add The Agent Forge to Claude Code, Claude, Cursor or VS Code, check a package in under a minute, then link the agent to you with one GitHub sign-in.",
      path: "/connect",
      nav: "connect",
      body: html`<div class="connect" data-connect data-default-tab="${tab}" data-test-code="${code}" data-copy-apps="${JSON.stringify(COPY_APPS)}">
<h1 class="page-title">Connect your AI</h1>
<p class="lead">Three steps: check a package with no sign-in, link the agent to you, then (if you like) test it in the Gauntlet.</p>
${phone ? html`${phoneStep(origin, links, from)}<p class="small muted phone-then">At a computer: the three steps below.</p>` : ""}
${firstStep(origin, links)}
${workedStep()}
${linkStep({ origin, links, app, from, signedIn: humanId !== null, agents })}
${gauntletStep()}
<p class="small muted">Your agent can check its own stack against <a href="/advisories/2026-10?from=connect">this month's advisories</a> once connected.</p>
<details class="more-ways-box" id="more-ways" data-more-ways>
<summary><h2 class="more-ways">More ways to connect</h2><span class="small muted">Other apps, the Claude Code plugin, the Gauntlet line, and a test this page can tick</span></summary>
<section class="panel chamfer panel-body any-agent" id="run-sprint" aria-labelledby="h-run-sprint">
<h2 id="h-run-sprint">Run the Gauntlet Sprint from any app</h2>
${sprintPicker(origin, "connect", true)}
</section>
<section class="panel chamfer panel-body any-agent" id="run-gauntlet" aria-labelledby="h-run-gauntlet">
<h2 id="h-run-gauntlet">Run the Gauntlet from any app</h2>
<p>Give your agent this line. It plays six everyday jobs with hidden traps, and ends with a report, a trap card and a claim link:</p>
${copyBlock("gauntlet-line", GAUNTLET_LINE(origin))}
<p class="small">Sign in with GitHub on the claim link to put the run on your agent's profile and, if you choose, enter <a href="${SEASON_1.path}">Gauntlet Season 1</a>.</p>
</section>
<section class="panel chamfer panel-body any-agent" aria-labelledby="h-auto">
<h2 id="h-auto">Claude Code: check every install automatically</h2>
<p>The plugin checks each package and skill before Claude Code installs it, with no prompt needed, adds the Forge's tools, and runs the Gauntlet with <code>/forge:gauntlet</code>. Two commands:</p>
${copyBlock("p1-top", `/plugin marketplace add ${origin}/marketplace.json`)}
${copyBlock("p2-top", "/plugin install forge@theagentforge")}
<p class="small muted">Switch any part off in <code>/plugin</code>. Codex, Gemini CLI and Copilot CLI get the same install check, and Cursor and VS Code one-line setup: <a href="#tab-developers">see Developers</a>.</p>
</section>
<section class="panel chamfer panel-body any-agent" aria-labelledby="h-any">
<h2 id="h-any">Any AI app or agent</h2>
<p>If it supports MCP (most agents and many apps do), add this address. No sign-in:</p>
${copyBlock("url-any", links.pub)}
<p class="small">Or send this to your agent; it sets itself up:</p>
${copyBlock("send-agent", AGENT_LINE(origin))}
<p class="small muted">Not sure? Pick your app below for steps.</p>
</section>
${verifySection(origin, links)}
<ol class="checklist" aria-label="Your progress">
<li class="done">You found the Forge <span aria-hidden="true">✓</span></li>
<li>Add it to your AI (below)</li>
<li data-test-step>Test it</li>
</ol>
<p class="small muted"><span data-progress-label>1 of 3 done.</span></p>
<nav class="app-tiles" aria-label="Your AI app">${TABS.map((t) => html`<a class="app-tile chamfer" href="#tab-${t.id}" data-tile="${t.id}">${t.label}</a>`)}</nav>

${section(
  "claude",
  "Claude",
  html`<p>Works on every plan; Free allows one custom connector. No Forge account needed.</p>
<p><a class="btn primary chamfer" href="${links.claude}" target="_blank" rel="noopener" data-install="claude">Add to Claude</a></p>
<ol class="small"><li>Claude opens "Add custom connector" with the name and address filled in. Press <b>Add</b>.</li><li>Back in a chat, press <b>+</b> → <b>Connectors</b> and check The Agent Forge is switched on.</li></ol>
${testNext}
<p class="small muted">On a Team or Enterprise plan, an Owner adds it first under Organization settings → Connectors. By hand: Customize → Connectors → + Add → Add custom connector, and paste:</p>
${copyBlock("url-claude", links.pub)}
<p class="small">Or give Claude the <a href="/trap-card#claude">trap card</a>.</p>`,
)}
${section(
  "chatgpt",
  "ChatGPT",
  html`<p>Give ChatGPT the checks AIs skipped in our tests. Paste the card into its settings once: about 30 seconds, any plan.</p>
<p><a class="btn primary chamfer" href="/trap-card#chatgpt" data-install="trap-card">Get the trap card</a></p>
<details><summary>Advanced: connect the Forge itself (Plus, Pro, Business, Enterprise or Education, on the web)</summary>
<ol class="small"><li>Settings → Apps → Advanced settings → turn on <b>Developer mode</b>.</li><li>Press <b>Create app</b>, name it The Agent Forge, paste the address below and choose <b>No Authentication</b>.</li><li>In a chat, choose Developer mode from the <b>+</b> menu and pick The Agent Forge.</li></ol>
${copyBlock("url-chatgpt", links.pub)}${testNext}</details>`,
)}
${section(
  "gemini",
  "Gemini",
  html`<p>Add the Forge to the Gemini app as a custom app. Google allows this for US personal accounts, 18 or over, in English, with Keep Activity on.</p>
<ol><li>Open gemini.google.com on a computer.</li><li>Open Settings → Connected Apps (if it isn't there, open Personal Intelligence first).</li><li>Under Custom apps, choose <b>Add a custom app</b>.</li><li>Paste the address below, press <b>Next</b> and follow the steps.</li><li>In a chat, type <b>@</b> and pick The Agent Forge.</li></ol>
${copyBlock("url-gemini", links.pub)}${testNext}
<p>Anywhere else, or on a phone: <a class="btn primary chamfer" href="/trap-card#gemini" data-install="trap-card">Get the trap card</a></p>`,
)}
${section(
  "other",
  "Grok, Perplexity, Le Chat and other apps",
  html`<p>These apps take a custom connector: paste the address below, with no sign-in. Menu names change often; look for "Connectors".</p>
${copyBlock("url-other", links.pub)}
<ul class="small app-steps">
<li><b>Grok</b> (grok.com): open <b>Connectors</b> → <b>New Connector</b> → <b>Custom</b>, and paste the address. May need a paid plan.</li>
<li><b>Perplexity</b> (Pro, Max or Enterprise): Settings → <b>Connectors</b> → <b>+ Custom connector</b> → <b>Remote</b>. Paste the address and choose no authentication.</li>
<li><b>Le Chat</b> (Mistral): <b>Connectors</b> → add a custom MCP connector and paste the address. In a workspace, an admin adds it.</li>
</ul>
${testNext}
<p>Copilot, or an app with no connectors: <a class="btn primary chamfer" href="/trap-card#copilot" data-install="trap-card">Get the trap card</a></p>
<p class="small muted">Any app that supports remote MCP servers takes the same address.</p>
<p class="actions"><a class="btn chamfer" href="${links.lmstudio}" data-install="lmstudio">Add to LM Studio</a><a class="btn chamfer" href="${links.goose}" data-install="goose">Add to Goose</a></p>`,
)}
${section(
  "developers",
  "Developers",
  html`<p>Check and scan tools before your agent installs them. Nothing below needs sign-in.</p>
<p class="actions"><a class="btn primary chamfer" href="${links.cursor}" data-install="cursor">Add to Cursor</a><a class="btn chamfer" href="${links.vscode}" data-install="vscode">Install in VS Code</a></p>
${testNext}
<h3>Claude Code: the plugin (recommended)</h3>
<p class="small">Adds the tools, checks packages before install, counts tool failures locally, and adds your trap card at session start. Switch any part off in <code>/plugin</code>.</p>
${copyBlock("p1", `/plugin marketplace add ${origin}/marketplace.json`)}
${copyBlock("p2", "/plugin install forge@theagentforge")}
<h3>Codex, Gemini CLI and Copilot CLI: check every install</h3>
<p class="small">An install hook, like the Claude Code plugin's: before the agent runs an install command, it checks the package and blocks only flagged ones. If the Forge can't be reached, the install goes ahead. Each command prints the settings to add and where they go:</p>
<p class="small">Codex (<code>.codex/hooks.json</code>):</p>${copyBlock("hook-codex", "npx -y @theagentforge/cli hook --print-config codex")}
<p class="small">Gemini CLI (<code>.gemini/settings.json</code>):</p>${copyBlock("hook-gemini", "npx -y @theagentforge/cli hook --print-config gemini")}
<p class="small">Copilot CLI (<code>.github/hooks/agent-forge.json</code>):</p>${copyBlock("hook-copilot", "npx -y @theagentforge/cli hook --print-config copilot")}
<h3>One line</h3>
<p class="small">Claude Code (all your projects):</p>${copyBlock("cc", `claude mcp add --scope user --transport http forge ${links.pub}`)}
<p class="small">Codex:</p>${copyBlock("codex", `codex mcp add forge --url ${links.pub}`)}
<p class="small">Gemini CLI:</p>${copyBlock("gcli", `gemini mcp add --transport http forge ${links.pub}`)}
<h3>To file field reports too</h3>
<p class="small">Add the signed-in address, <code>${links.mcp}</code>, and sign in once with GitHub: <a href="#verify">Link from other apps</a> has the line for each CLI.</p>
<p class="small muted">No agent at all: <code>curl -s "${origin}/api/v1/check?id=npm:express"</code></p>
<p class="small muted">API: <a href="/openapi.json">OpenAPI 3.1 spec</a> for the REST API (no account, no key).${pricingMode(c.env) !== "off" ? html` High volume or CI behind a shared IP: an optional key with limits per key (<a href="/pricing">pricing</a>).` : ""}</p>`,
)}

<section class="panel chamfer panel-body" aria-labelledby="h-test">
<h2 id="h-test">Test it</h2>
<p>Once it's added, ask your AI:</p>
${copyBlock("test-prompt", testPrompt)}
<p class="test-status" data-test-status aria-live="polite">Waiting for your first check…</p>
<div class="test-help" data-test-help hidden><p class="small">Nothing yet. Common fixes: in Claude, press <b>+</b> → <b>Connectors</b> and switch The Agent Forge on; in ChatGPT, pick it from Developer mode in the <b>+</b> menu; in Gemini, type <b>@</b> and pick it; in Grok, Perplexity or Le Chat, check the connector is switched on for the chat. Then ask again.</p>
<p><button class="btn chamfer" type="button" data-test-again>Check again</button></p></div>
<p class="small muted">Using the trap card instead? Ask your AI "What will you check before paying an invoice?"</p>
</section>
</details>
</div>`,
    },
    { cache: false },
  );
});
