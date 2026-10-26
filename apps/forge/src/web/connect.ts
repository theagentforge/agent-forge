import { html } from "hono/html";
import { AGENT_LINE } from "./agent-line";
import { sql } from "drizzle-orm";
import { newTestCode } from "../services/connect-test";
import { getDb } from "../services/db";
import { day } from "../services/proof";
import { atMinimum } from "../services/counters";
import { copyBlock } from "./components";
import { MAX_AGENTS_PER_HUMAN } from "../services/identity";
import { send, site } from "./pages";
import { humanCounters, bump } from "../services/usage";

// /connect as "pick your app" (ADR 0017 §4): big tiles, one primary button per app, a checklist that starts at
// "1 of 3 done", and a "Test it" step that ticks when the first check arrives. The trap card is the path for apps
// that can't connect (ChatGPT Free, consumer Copilot).

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
  if (/Mobi|Android|iPhone|iPad/i.test(userAgent ?? "")) return "chatgpt";
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
};

/** The counter keys one step beacon adds, or none when the step or app isn't one of the fixed names. */
export function connectStepKeys(e: string | null | undefined, app: string | null | undefined): string[] {
  if (e === "code-shown") return ["connect:code-shown"];
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
<h2 id="h-verify">Verify your agent (GitHub sign-in, 1 minute)</h2>
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

site.get("/connect", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const links = installLinks(origin);
  const tab = defaultTab(c.req.header("Referer"), c.req.header("User-Agent"));
  const code = newTestCode();
  const testPrompt = `Use The Agent Forge to check the tool npm:forge-test-${code}`;
  const [row] = (await getDb(c.env)
    .all(sql`select count(*) as n from check_sources where day = ${day(Date.now())} and is_house = 0`)
    .catch(() => [])) as { n: number }[];
  // ADR 0023 §3: people outside the project only, and shown only once it reaches its minimum.
  const checksToday = atMinimum("check_sources", Number(row?.n ?? 0));
  const testNext = html`<p class="small then-test"><a href="#h-test">Then test it below ↓</a> (one question; this page ticks).</p>`;
  const section = (id: AppTab, title: string, body: unknown) =>
    html`<section class="app-tab panel chamfer panel-body" id="tab-${id}" data-tab="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${body}</section>`;
  return send(
    c,
    {
      title: "Connect your AI",
      description: "Add The Agent Forge to Claude, Cursor, VS Code, LM Studio or Goose in a click, or to ChatGPT, Gemini, Grok, Perplexity and Le Chat in a few steps. No sign-in.",
      path: "/connect",
      nav: "connect",
      body: html`<div class="connect" data-connect data-default-tab="${tab}" data-test-code="${code}" data-copy-apps="${JSON.stringify(COPY_APPS)}">
<h1 class="page-title">Connect your AI</h1>
<p class="small muted">Your agent can check its own stack against <a href="/advisories/2026-10?from=connect">this month's advisories</a> once connected.</p>
<section class="panel chamfer panel-body any-agent" aria-labelledby="h-auto">
<h2 id="h-auto">Claude Code: check every install automatically</h2>
<p>The plugin checks each package and skill before Claude Code installs it, with no prompt needed, and adds the Forge's tools. Two commands:</p>
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
<p class="small muted"><span data-progress-label>1 of 3 done.</span> ${checksToday !== null ? `${checksToday.toLocaleString("en-US")} different people and agents checked a tool today.` : ""}</p>
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
<p class="small">Add the signed-in address, <code>${links.mcp}</code>, and sign in once with GitHub: <a href="#verify">Verify your agent</a> has the line for each CLI.</p>
<p class="small muted">No agent at all: <code>curl -s "${origin}/api/v1/check?id=npm:express"</code></p>
<p class="small muted">API: <a href="/openapi.json">OpenAPI 3.1 spec</a> for the REST API (no account, no key).</p>`,
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
</div>`,
    },
    { cache: false },
  );
});
