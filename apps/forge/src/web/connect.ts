import { html } from "hono/html";
import { AGENT_LINE } from "./agent-line";
import { sql } from "drizzle-orm";
import { newTestCode } from "../services/connect-test";
import { getDb } from "../services/db";
import { day } from "../services/proof";
import { atMinimum } from "../services/counters";
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
    // One-click links open the no-sign-in address: something works at once, and GitHub sign-in is the later step
    // for filing reports (research 23 Oct: forced sign-up loses people). Formats from each app's docs, checked 23 Oct.
    cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=forge&config=${btoa(JSON.stringify({ url: pub }))}`,
    vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "forge", type: "http", url: pub }))}`,
    lmstudio: `lmstudio://add_mcp?name=forge&config=${encodeURIComponent(btoa(JSON.stringify({ url: pub })))}`,
    goose: `goose://extension?url=${encodeURIComponent(pub)}&type=streamable_http&timeout=300&id=forge&name=${encodeURIComponent("The Agent Forge")}&description=${encodeURIComponent("Check skills and MCP servers before install")}`,
  };
}

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
  const testNext = html`<p class="small then-test"><a href="#h-test">Then test it below ↓</a> (one question to your AI, and this page ticks).</p>`;
  const section = (id: AppTab, title: string, body: unknown) =>
    html`<section class="app-tab panel chamfer panel-body" id="tab-${id}" data-tab="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${body}</section>`;
  return send(
    c,
    {
      title: "Connect your AI",
      description: "Add The Agent Forge to Claude, Cursor, VS Code, LM Studio or Goose in a click, or to ChatGPT and Gemini in a few steps. No sign-in needed.",
      path: "/connect",
      nav: "connect",
      body: html`<div class="connect" data-connect data-default-tab="${tab}" data-test-code="${code}">
<h1 class="page-title">Connect your AI</h1>
<section class="panel chamfer panel-body any-agent" aria-labelledby="h-any">
<h2 id="h-any">Any AI app or agent</h2>
<p>If it supports MCP (most agents and many apps do), add this address. No sign-in needed:</p>
${copyBlock("url-any", links.pub)}
<p class="small">Or send this to your agent and it will set itself up:</p>
${copyBlock("send-agent", AGENT_LINE(origin))}
<p class="small muted">Not sure? Pick your app below for step-by-step help.</p>
</section>
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
  html`<p>Works on every plan, including Free (Free allows one custom connector). No account with us needed.</p>
<p><a class="btn primary chamfer" href="${links.claude}" target="_blank" rel="noopener">Add to Claude</a></p>
<ol class="small"><li>Claude opens its "Add custom connector" form with the name and address filled in. Press <b>Add</b>.</li><li>Back in a chat, press <b>+</b> → <b>Connectors</b> and check The Agent Forge is switched on.</li></ol>
${testNext}
<p class="small muted">On a Team or Enterprise plan, an Owner adds it first under Organization settings → Connectors. By hand: Customize → Connectors → + Add → Add custom connector, and paste:</p>
${copyBlock("url-claude", links.pub)}
<p class="small">Or give Claude the <a href="/trap-card#claude">trap card</a> instead.</p>`,
)}
${section(
  "chatgpt",
  "ChatGPT",
  html`<p>Give ChatGPT the checks AIs skipped in our tests. Paste the card into its settings once, in about 30 seconds. Works on every plan.</p>
<p><a class="btn primary chamfer" href="/trap-card#chatgpt">Get the trap card</a></p>
<details><summary>Advanced: connect the Forge itself (Plus, Pro, Business, Enterprise or Education, on the web)</summary>
<ol class="small"><li>Settings → Apps → Advanced settings → turn on <b>Developer mode</b>.</li><li>Press <b>Create app</b>, name it The Agent Forge, paste the address below and choose <b>No Authentication</b>.</li><li>In a chat, choose Developer mode from the <b>+</b> menu and pick The Agent Forge.</li></ol>
${copyBlock("url-chatgpt", links.pub)}${testNext}</details>`,
)}
${section(
  "gemini",
  "Gemini",
  html`<p>In the Gemini app you can add the Forge as a custom app. Google allows this for personal accounts in the US, 18 or over, in English, with Keep Activity on.</p>
<ol><li>Open gemini.google.com on a computer.</li><li>Open Settings → Connected Apps (if it isn't there, open Personal Intelligence first).</li><li>Under Custom apps, choose <b>Add a custom app</b>.</li><li>Paste the address below, press <b>Next</b> and follow the steps.</li><li>In a chat, type <b>@</b> and pick The Agent Forge.</li></ol>
${copyBlock("url-gemini", links.pub)}${testNext}
<p>Anywhere else, or on a phone: <a class="btn primary chamfer" href="/trap-card#gemini">Get the trap card</a></p>`,
)}
${section(
  "other",
  "Copilot and other apps",
  html`<p>Most chat apps can't add tools yet, but all of them take custom instructions. Give yours the trap card.</p>
<p><a class="btn primary chamfer" href="/trap-card#copilot">Get the trap card</a></p>
<p class="small muted">If your app supports remote MCP servers, add this address (no sign-in):</p>
${copyBlock("url-other", links.pub)}
<p class="actions"><a class="btn chamfer" href="${links.lmstudio}">Add to LM Studio</a><a class="btn chamfer" href="${links.goose}">Add to Goose</a></p>${testNext}`,
)}
${section(
  "developers",
  "Developers",
  html`<p>Check and scan tools before your agent installs them. The buttons and lines below need no sign-in.</p>
<p class="actions"><a class="btn primary chamfer" href="${links.cursor}">Add to Cursor</a><a class="btn chamfer" href="${links.vscode}">Install in VS Code</a></p>
${testNext}
<h3>Claude Code: the plugin (recommended)</h3>
<p class="small">Adds the tools, checks packages before install, counts tool failures locally, and adds your trap card at session start. Each part can be switched off in <code>/plugin</code>.</p>
${copyBlock("p1", `/plugin marketplace add ${origin}/marketplace.json`)}
${copyBlock("p2", "/plugin install forge@theagentforge")}
<h3>One line</h3>
<p class="small">Claude Code (all your projects):</p>${copyBlock("cc", `claude mcp add --scope user --transport http forge ${links.pub}`)}
<p class="small">Codex:</p>${copyBlock("codex", `codex mcp add forge --url ${links.pub}`)}
<p class="small">Gemini CLI:</p>${copyBlock("gcli", `gemini mcp add --transport http forge ${links.pub}`)}
<h3>To file field reports too</h3>
<p class="small">Use the signed-in address instead: <code>${links.mcp}</code>. Sign in once with GitHub; we keep only your GitHub user number, username and account creation date.</p>
${copyBlock("cc-signed", `claude mcp add --scope user --transport http forge ${links.mcp}`)}
<p class="small muted">No agent at all: <code>curl -s "${origin}/api/v1/check?id=npm:express"</code></p>`,
)}

<section class="panel chamfer panel-body" aria-labelledby="h-test">
<h2 id="h-test">Test it</h2>
<p>Once it's added, ask your AI:</p>
${copyBlock("test-prompt", testPrompt)}
<p class="test-status" data-test-status aria-live="polite">Waiting for your first check…</p>
<div class="test-help" data-test-help hidden><p class="small">Nothing yet. Common fixes: in Claude, press <b>+</b> → <b>Connectors</b> and switch The Agent Forge on; in ChatGPT, pick it from Developer mode in the <b>+</b> menu; in Gemini, type <b>@</b> and pick it. Then ask again.</p>
<p><button class="btn chamfer" type="button" data-test-again>Check again</button></p></div>
<p class="small muted">Using the trap card instead? Ask your AI "What will you check before paying an invoice?"</p>
</section>
</div>`,
    },
    { cache: false },
  );
});
