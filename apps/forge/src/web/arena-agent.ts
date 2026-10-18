import { PUBLIC_NAME, taskById } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { publicScorecard, scorecardHref, signScorecard, verifyScorecard, type ScorecardSummary } from "../arena/agent-scorecard";
import { getDb } from "../services/db";
import { badgeSvg, type Badge } from "./badge";
import { agentHref, copyBlock, tierLabel } from "./components";
import { send, site } from "./pages";

// Verified score pages (ADR 0023 §6). Privacy: while a page is private, or the agent has no refereed bout, the page,
// its JSON and its badge all answer 404 with the same body as an unknown handle, so they don't reveal that the agent
// exists. The badge is a 404 rather than a neutral "not public" image for the same reason; a README showing a broken
// badge is the owner's cue that the page is off. Pages and JSON are never cached, so turning a page off takes effect
// at once; the badge is cached for 5 minutes (and purged in this data centre when the owner turns the page off).

type Ctx = Context<{ Bindings: Env }>;
export const BADGE_CACHE_SECONDS = 300;
const HANDLE = "[a-z0-9-]+";

const notPublic = (c: Ctx) => c.text("Not found", 404, { "Cache-Control": "no-store" });

/** Each uncached score request reads the database, so each visitor IP gets the same budget as tool pages. */
async function limited(c: Ctx) {
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `web:${c.req.header("CF-Connecting-IP") ?? "unknown"}` });
  return success ? null : c.text("Too many requests. Wait a minute and try again.", 429, { "Retry-After": "60", "Cache-Control": "no-store" });
}

export async function signedScorecard(env: Env, handle: string) {
  const sc = await publicScorecard(getDb(env), handle);
  if (!sc) return null;
  return { ...sc, signature: await signScorecard(env.REPORT_SIGNING_KEY, sc.summary) };
}

const VERIFY_NOTE =
  "The signature is HMAC-SHA256 with The Agent Forge's server key over this summary, the same way every Arena replay log is signed. Only the Forge holds the key, so to check a copy, POST the whole file to /arena/agent/verify, which answers valid true or false, or compare it with the live file at this address. The summary is rebuilt from the refereed bouts each time it's served, so a new bout changes it and its signature.";

function jsonDoc(env: Env, s: ScorecardSummary, signature: string) {
  return {
    summary: s,
    signature,
    signature_alg: "hmac-sha256",
    signed_fields: { kind: s.schema, summary: "JSON.stringify(summary)" },
    verify: { method: "POST", url: `${env.PUBLIC_ORIGIN}/arena/agent/verify`, body: "this file, unchanged" },
  };
}

export function scorecardBadge(s: ScorecardSummary): Badge {
  if (s.traps_total == null || s.traps_caught == null) return { label: "Forge Arena", message: "not enough bouts yet", color: "#5b6573" };
  const share = s.traps_total ? s.traps_caught / s.traps_total : 0;
  return { label: "Forge Arena", message: `caught ${s.traps_caught}/${s.traps_total} traps`, color: share >= 0.9 ? "#2e9e6b" : share >= 0.6 ? "#c27c0e" : "#c43c35" };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

site.get(`/arena/agent/:file{${HANDLE}\\.json}`, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const sc = await signedScorecard(c.env, c.req.param("file").replace(/\.json$/, ""));
  if (!sc) return notPublic(c);
  return c.json(jsonDoc(c.env, sc.summary, sc.signature), 200, {
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="forge-arena-${sc.summary.agent}.json"`,
    "X-Content-Type-Options": "nosniff",
  });
});

site.get(`/arena/agent/:handle{${HANDLE}}/badge.svg`, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const sc = await publicScorecard(getDb(c.env), c.req.param("handle"));
  if (!sc) return notPublic(c);
  return c.body(badgeSvg(scorecardBadge(sc.summary)), 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": `public, max-age=${BADGE_CACHE_SECONDS}`,
    "Access-Control-Allow-Origin": "*",
  });
});

site.post("/arena/agent/verify", async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const text = await c.req.text();
  if (text.length > 200_000) return c.json({ valid: false, error: "too_large" }, 413);
  let body: { summary?: unknown; signature?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ valid: false, error: "invalid_json" }, 400);
  }
  return c.json({ valid: await verifyScorecard(c.env.REPORT_SIGNING_KEY, body?.summary, body?.signature) }, 200, { "Cache-Control": "no-store" });
});

site.get(`/arena/agent/:handle{${HANDLE}}`, async (c) => {
  const stop = await limited(c);
  if (stop) return stop;
  const sc = await signedScorecard(c.env, c.req.param("handle"));
  if (!sc) return notPublic(c);
  const s = sc.summary;
  if (c.req.query("format") === "json" || (c.req.header("Accept") ?? "").split(",")[0]?.trim() === "application/json")
    return c.json(jsonDoc(c.env, s, sc.signature), 200, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  const path = scorecardHref(s.agent);
  const origin = c.env.PUBLIC_ORIGIN;
  const enough = s.pass_rate != null;
  const markdown = `[![Forge Arena](${origin}${path}/badge.svg)](${origin}${path})`;
  const htmlEmbed = `<a href="${origin}${path}"><img src="${origin}${path}/badge.svg" alt="Forge Arena score"></a>`;
  const dates = s.first_bout === s.last_bout ? s.first_bout : `${s.first_bout} to ${s.last_bout}`;
  return send(
    c,
    {
      title: `${s.agent} · Ranked Ladder score`,
      description: enough
        ? `${s.agent}, run by @${s.owner_github}: caught ${s.traps_caught} of ${s.traps_total} traps in ${s.bouts} refereed Ranked Ladder bouts.`
        : `${s.agent}, run by @${s.owner_github}: ${s.bouts} refereed Ranked Ladder bouts so far.`,
      path,
      jsonAlternate: `${path}.json`,
      body: html`<p class="eyebrow">${PUBLIC_NAME} · Ranked Ladder score · run by <a href="https://github.com/${s.owner_github}" rel="nofollow ugc">@${s.owner_github}</a> ${tierLabel(s.owner_tier, s.house)}${s.agent_status === "revoked" ? html` · <strong>revoked</strong>` : ""}</p>
<h1 class="page-title mono-title"><a href="${agentHref(s.agent)}">${s.agent}</a></h1>
<p class="lead">Every number here comes from bouts this agent took through the Forge MCP, refereed by our server. Nothing is self-reported. ${s.house ? "This is one of the Forge's own House agents, run in the open." : "It describes this agent plus its owner's setup, never a model on its own."}</p>
<p class="muted">${s.rules_versions.map((r) => r[0]!.toUpperCase() + r.slice(1)).join(", ")} · ${s.task_versions.join(", ")} · ${dates}</p>
${enough
  ? html`<div class="stats spaced">
<div class="stat"><b>${s.bouts}</b><span>refereed bouts</span></div>
<div class="stat"><b>${s.traps_caught}/${s.traps_total}</b><span>traps caught</span></div>
<div class="stat"><b>${pct(s.pass_rate!)}</b><span>pass rate (n = ${s.bouts})</span></div>
</div>
<section><h2>By failure mode</h2>
<table class="table stack"><thead><tr><th>Failure mode</th><th class="num">Caught</th><th class="num">Fell for</th></tr></thead><tbody>${s.by_family!.map(
      (f) => html`<tr><td class="wide"><span class="mono">${f.family}</span> ${f.name}</td><td class="num" data-label="Caught">${f.caught}</td><td class="num" data-label="Fell for">${f.fell_for}</td></tr>`,
    )}</tbody></table>
<h3 class="top-gap">By trap</h3>
<table class="table stack"><thead><tr><th>Trap</th><th class="num">Caught</th><th class="num">Fell for</th></tr></thead><tbody>${s.by_trap!.map(
      (x) => html`<tr><td class="mono wide"><a href="/arena/methodology#${x.id}">${x.id}</a></td><td class="num" data-label="Caught">${x.caught}</td><td class="num" data-label="Fell for">${x.fell_for}</td></tr>`,
    )}</tbody></table>
<p class="muted small-print">Trap IDs and families are from the <a href="/arena/methodology">public trap catalog</a>.</p></section>`
  : html`<div class="stats spaced"><div class="stat"><b>${s.bouts}</b><span>refereed bouts</span></div></div>
<p class="notice">Not enough bouts yet. Rates appear after ${s.min_bouts} refereed bouts, so a single lucky or unlucky bout doesn't stand for the agent.</p>`}
<section><h2>Bouts</h2><ol class="feed">${s.bouts_list.map(
      (b) => html`<li><div class="fi-title"><a href="${b.replay}">${taskById(b.task)?.title ?? b.task}</a> ${b.passed ? html`<span class="label">pass</span>` : html`<span class="label">fail</span>`}</div><div class="fi-time">${b.finished_at.slice(0, 10)}</div><div class="fi-meta">${b.task_version} · ${b.rules_version}</div></li>`,
    )}</ol></section>
<section><h2>Badge</h2>
<p><img src="${path}/badge.svg" alt="Forge Arena score badge for ${s.agent}"></p>
<p>Markdown for a README:</p>${copyBlock("embed-md", markdown)}
<p>HTML:</p>${copyBlock("embed-html", htmlEmbed)}</section>
<section><h2>Signature</h2>
<p><a href="${path}.json">Download the signed summary (JSON)</a></p>
<p class="small mono">${sc.signature}</p>
<p class="small muted">How to verify: ${VERIFY_NOTE}</p>
<p class="small muted">The owner chose to make this page public and can turn it off from their dashboard at any time.</p></section>`,
    },
    { cache: false },
  );
});
