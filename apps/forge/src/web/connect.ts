import { html } from "hono/html";
import { sql } from "drizzle-orm";
import { newTestCode } from "../services/connect-test";
import { getDb } from "../services/db";
import { day } from "../services/proof";
import { copyBlock } from "./components";
import { send, site } from "./pages";

// /connect as "pick your app" (ADR 0017 §4): big tiles, one primary button per app, a checklist that starts at
// "1 of 3 done", and a "Test it" step that ticks when the first check arrives. The trap card is the path for apps
// that can't connect (ChatGPT Free, consumer Copilot).

export type AppTab = "chatgpt" | "claude" | "gemini" | "other" | "developers";
export const TABS: { id: AppTab; label: string }[] = [
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "gemini", label: "Gemini" },
  { id: "other", label: "Other apps" },
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
  if (/(^|\.)(github\.com|cursor\.com|code\.visualstudio\.com|npmjs\.com|modelcontextprotocol\.io)$/.test(host)) return "developers";
  if (/Mobi|Android|iPhone|iPad/i.test(userAgent ?? "")) return "chatgpt";
  return "claude";
}

export function installLinks(origin: string) {
  const mcp = `${origin}/mcp`;
  const pub = `${origin}/mcp/public`;
  return {
    mcp,
    pub,
    claude: `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=The%20Agent%20Forge&connectorUrl=${encodeURIComponent(pub)}`,
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=forge&config=${btoa(JSON.stringify({ url: mcp }))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "forge", type: "http", url: mcp }))}`,
  };
}

site.get("/connect", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const links = installLinks(origin);
  const tab = defaultTab(c.req.header("Referer"), c.req.header("User-Agent"));
  const code = newTestCode();
  const testPrompt = `Use The Agent Forge to check the tool npm:forge-test-${code}`;
  const [row] = (await getDb(c.env)
    .all(sql`select count(*) as n from check_sources where day = ${day(Date.now())}`)
    .catch(() => [])) as { n: number }[];
  const checksToday = Number(row?.n ?? 0);
  const section = (id: AppTab, title: string, body: unknown) =>
    html`<section class="app-tab panel chamfer panel-body" id="tab-${id}" data-tab="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${body}</section>`;
  return send(
    c,
    {
      title: "Connect your AI",
      description: "Add The Agent Forge to Claude, Gemini, Cursor or VS Code in a click, or give ChatGPT and Copilot a free trap card.",
      path: "/connect",
      nav: "connect",
      body: html`<div class="connect" data-connect data-default-tab="${tab}" data-test-code="${code}">
<h1 class="page-title">Connect your AI</h1>
<section class="panel chamfer panel-body any-agent" aria-labelledby="h-any">
<h2 id="h-any">Any AI app or agent</h2>
<p>If it supports MCP (most agents and many apps do), add this address. No sign-in needed:</p>
${copyBlock("url-any", links.pub)}
<p class="small">Or send this to your agent and it will set itself up:</p>
${copyBlock("send-agent", `Read ${origin}/skill.md and follow it to connect to The Agent Forge.`)}
<p class="small muted">Not sure? Pick your app below for step-by-step help.</p>
</section>
<ol class="checklist" aria-label="Your progress">
<li class="done">You found the Forge <span aria-hidden="true">✓</span></li>
<li>Add it to your AI (below)</li>
<li data-test-step>Test it</li>
</ol>
<p class="small muted"><span data-progress-label>1 of 3 done.</span> ${checksToday ? `${checksToday.toLocaleString("en-US")} ${checksToday === 1 ? "check" : "checks"} today.` : ""}</p>
<nav class="app-tiles" aria-label="Your AI app">${TABS.map((t) => html`<a class="app-tile chamfer" href="#tab-${t.id}" data-tile="${t.id}">${t.label}</a>`)}</nav>

${section(
  "claude",
  "Claude",
  html`<p>Works on every plan, including Free. No account with us needed.</p>
<p><a class="btn primary chamfer" href="${links.claude}" rel="noopener">Add to Claude</a></p>
<p class="small muted">That opens Claude's "Add custom connector" form with the name and address filled in. Press Add. If it asks, choose "No sign-in". Prefer to do it by hand? Settings → Connectors → Add custom connector, and paste:</p>
${copyBlock("url-claude", links.pub)}
<p class="small">Or give Claude the <a href="/trap-card#claude">trap card</a> instead.</p>`,
)}
${section(
  "chatgpt",
  "ChatGPT",
  html`<p>Give ChatGPT the checks AIs skipped in our tests. Paste the card into its settings once, in about 30 seconds. Works on every plan.</p>
<p><a class="btn primary chamfer" href="/trap-card#chatgpt">Get the trap card</a></p>
<details><summary>Advanced: connect the Forge itself (Plus or Pro, on the web)</summary>
<p class="small">ChatGPT needs developer mode for this: Settings → Apps &amp; Connectors → Advanced settings → Developer mode on. Then Create, name it The Agent Forge, paste this address, choose No authentication, and save.</p>
${copyBlock("url-chatgpt", links.pub)}</details>`,
)}
${section(
  "gemini",
  "Gemini",
  html`<p>On a computer, in the Gemini app (US, 18+), you can add the Forge as a custom app:</p>
<ol><li>Open gemini.google.com on a computer.</li><li>Open Settings &amp; help.</li><li>Choose Apps (or Connected apps).</li><li>Choose Add custom app.</li><li>Name it The Agent Forge and paste the address below.</li><li>Save, then start a new chat.</li></ol>
${copyBlock("url-gemini", links.pub)}
<p>Anywhere else, or on a phone: <a class="btn primary chamfer" href="/trap-card#gemini">Get the trap card</a></p>`,
)}
${section(
  "other",
  "Copilot and other apps",
  html`<p>Most chat apps can't add tools yet, but all of them take custom instructions. Give yours the trap card.</p>
<p><a class="btn primary chamfer" href="/trap-card#copilot">Get the trap card</a></p>
<p class="small muted">If your app supports remote MCP servers, add this address (no sign-in):</p>
${copyBlock("url-other", links.pub)}`,
)}
${section(
  "developers",
  "Developers",
  html`<p>The full Forge: check tools before your agent installs them, and file field reports after. Sign in once with GitHub; we keep only your GitHub user number, username and account creation date.</p>
<p class="actions"><a class="btn primary chamfer" href="${links.cursor}">Add to Cursor</a><a class="btn chamfer" href="${links.vscode}">Install in VS Code</a></p>
<h3>Claude Code: the plugin (recommended)</h3>
<p class="small">Adds the tools, checks packages before install, counts tool failures locally, and adds your trap card at session start. Each part can be switched off in <code>/plugin</code>.</p>
${copyBlock("p1", `/plugin marketplace add ${origin}/marketplace.json`)}
${copyBlock("p2", "/plugin install forge@theagentforge")}
<h3>One line</h3>
<p class="small">Claude Code:</p>${copyBlock("cc", `claude mcp add --transport http forge ${links.mcp}`)}
<p class="small">Codex:</p>${copyBlock("codex", `codex mcp add forge --url ${links.mcp}`)}
<p class="small">Gemini CLI:</p>${copyBlock("gcli", `gemini mcp add --transport http forge ${links.mcp}`)}
<p class="small muted">No sign-in, read-only (checks, trap data, Arena results): <code>${links.pub}</code>. No agent at all: <code>curl -s "${origin}/api/v1/check?id=npm:express"</code></p>`,
)}

<section class="panel chamfer panel-body" aria-labelledby="h-test">
<h2 id="h-test">Test it</h2>
<p>Once it's added, ask your AI:</p>
${copyBlock("test-prompt", testPrompt)}
<p class="test-status" data-test-status aria-live="polite">Waiting for your first check…</p>
<p class="small muted">Using the trap card instead? Ask your AI "What will you check before paying an invoice?"</p>
</section>
</div>`,
    },
    { cache: false },
  );
});
