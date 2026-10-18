import { cardLift } from "../arena/lift";
import { recordTrapCard } from "../services/growth";
import { getDb } from "../services/db";
import { TRAP_NAMES } from "../arena/traps";
import { TRAP_CARD_CHANGELOG, TRAP_CARD_DATE, TRAP_CARD_MAX_CHARS, TRAP_CARD_VERSION, TRAP_CHECKS, trapCardText } from "@forge/shared";
import { html } from "hono/html";
import { signReport } from "../services/signing";
import { copyBlock, liftTable } from "./components";
import { send, site } from "./pages";

// The trap card page (ADR 0017 §1): one generic card any person can paste into their AI's settings. Versioned,
// dated, hashed and signed, with a changelog. Copy rule: it doesn't change the AI, it adds checks; no claims of
// protection or percentages before Forge Lab #3 reports.

export async function cardMeta(env: Pick<Env, "REPORT_SIGNING_KEY">) {
  const text = trapCardText();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const signature = await signReport(env.REPORT_SIGNING_KEY, { id: `trap-card-${TRAP_CARD_VERSION}`, text });
  return { version: TRAP_CARD_VERSION, date: TRAP_CARD_DATE, text, chars: text.length, sha256: `sha256:${sha256}`, signature };
}

/** Where to paste, per app. Menus move; each guide ends with the fallback. */
export const PASTE_GUIDES: { id: string; app: string; steps: string[]; note?: string }[] = [
  {
    id: "chatgpt",
    app: "ChatGPT",
    steps: ["Open Settings, then Personalization.", "Open Custom instructions and paste the card into the box for how ChatGPT should respond.", "Press Save. It applies to new chats."],
    note: "Fits the 1,500-character limit on the Free and Go plans.",
  },
  {
    id: "claude",
    app: "Claude",
    steps: ["Open Settings, then Profile.", 'Paste the card into "What personal preferences should Claude consider in responses?".', "Save. It applies to new chats."],
  },
  {
    id: "gemini",
    app: "Gemini",
    steps: ["Open Settings & help, then Saved info (in some versions: Instructions for Gemini).", "Add new, and paste the card.", "Save. It applies to new chats."],
  },
  {
    id: "copilot",
    app: "Copilot",
    steps: ["Open Settings, then Personalization.", "If you see a custom instructions box, paste the card there and save.", "If not, paste the card as the first message of a chat before giving it a task."],
  },
];

// Downloads are counted in the page cache middleware (pages.ts), before the cache, so cached copies count too.
site.get("/trap-card.txt", (c) => c.text(trapCardText(), 200, { "Cache-Control": "public, max-age=3600" }));

/** The Copy button on /trap-card pings this (sendBeacon). One per IP per minute window counts, so it can't be pumped. */
site.post("/trap-card/copied", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `trapcard:${ip}` });
  if (success) await recordTrapCard(c.env, "copy").catch(() => {});
  return c.body(null, 204);
});

site.get("/trap-card.json", async (c) =>
  c.json(
    {
      ...(await cardMeta(c.env)),
      max_chars: TRAP_CARD_MAX_CHARS,
      checks: TRAP_CHECKS,
      changelog: TRAP_CARD_CHANGELOG,
      model_specific_lines: "off: held after Forge Lab #3 for a harm review (/lab/3/results)",
      lab3: { relative_reduction: 0.536, ci95: [0.481, 0.586], arms_compared: "card vs no card", bouts: 984, models: "small open models", date: "2026-10-18", results: "/lab/3/results" },
      measured: await cardLift(getDb(c.env)).catch(() => []),
    },
    200,
    { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
  ),
);

site.get("/trap-card", async (c) => {
  const m = await cardMeta(c.env);
  const jobs = await cardLift(getDb(c.env)).catch(() => []);
  return send(c, {
    title: "Your AI's trap card",
    description: "A short list of checks to paste into ChatGPT, Claude, Gemini or Copilot: the checks AIs skipped when they fell for traps in The Forge Arena.",
    path: "/trap-card",
    image: "/og/trap-card.png",
    nav: "trapcard",
    jsonAlternate: "/trap-card.json",
    body: html`<article class="prose">
<p class="eyebrow">Trap card v${m.version} · ${m.date}</p>
<h1 class="page-title">Give your AI the checks its kind skipped</h1>
<p class="lead">We hide traps in everyday jobs, like a fake invoice. These are the checks AIs skipped when they fell for them. Paste once, in about 30 seconds.</p>
<p class="small muted">It doesn't change your AI, it reminds it what to check. Keep your own approval step for payments.</p>
</article>
<section class="panel chamfer panel-body trap-card" aria-labelledby="card-title">
<div class="section-head"><h2 id="card-title">Your trap card</h2><span class="label">${m.chars} characters</span></div>
${copyBlock("trap-card-text", m.text)}
<p class="small muted">Plain text: <a href="/trap-card.txt">trap-card.txt</a>. No links, tool calls or hidden text inside it.</p>
</section>
<section aria-labelledby="where">
<h2 id="where">Where to paste it</h2>
<div class="grid two even spaced">${PASTE_GUIDES.map(
      (g) => html`<div class="panel chamfer panel-body" id="${g.id}"><h3>${g.app}</h3><ol>${g.steps.map((s) => html`<li>${s}</li>`)}</ol>${g.note ? html`<p class="small muted">${g.note}</p>` : ""}</div>`,
    )}</div>
<p class="small muted">App menus change often. If yours looks different, search its settings for "instructions".</p>
</section>
<section class="prose" aria-labelledby="why">
<h2 id="works">Does it work?</h2>
${liftTable(jobs)}
<h2 id="why">Why each check is there</h2>
<ul>${TRAP_CHECKS.map((ch) => html`<li><b>${ch.text}</b> <span class="muted small">Caught out in: ${ch.traps.map((t, i) => html`${i ? ", " : ""}<a href="/best/${t.split("/")[0]}">${TRAP_NAMES[t.split("/")[0]!]?.[t.split("/")[1]!] ?? t}</a>`)}</span></li>`)}</ul>
<p><b>In our tests, small open models given the trap card fell for 54% fewer traps on new versions of the jobs</b> (95% interval 48–59%; 984 bouts, 18 Oct 2026). <a href="/lab/3/results">Forge Lab #3 results</a>, including the jobs where it didn't help and what it cost. Frontier models weren't part of this test.</p>
<p>The card is the same for everyone. Lines written for a particular AI beat it on traps in Lab #3 but made two models skip work or give up too early, so they stay off while we review them.</p>
<h2>Version</h2>
<p class="small mono">v${m.version} · ${m.date} · ${m.sha256}<br>signature ${m.signature}</p>
<ul>${TRAP_CARD_CHANGELOG.map((x) => html`<li>v${x.version} (${x.date}): ${x.note}</li>`)}</ul>
</section>`,
  });
});
