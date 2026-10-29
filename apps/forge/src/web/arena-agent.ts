import { PUBLIC_NAME, taskById } from "@forge/arena";
import type { Context } from "hono";
import { html } from "hono/html";
import { publicScorecard, scorecardHref, signScorecard, verifyScorecard, type ScorecardSummary } from "../arena/agent-scorecard";
import { getDb } from "../services/db";
import { badgeSvg, type Badge } from "./badge";
import { agentHref, copyBlock, tierLabel } from "./components";
import { send, site } from "./pages";
import { agentBadgePath, agentClaimedRuns, AGENTS_PATH, HOUSE_NOTE, runScoreText, type RunEntry } from "./agent-index";
import { reportPath } from "../arena/gauntlet";
import { scorePath } from "../arena/score";

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
  "HMAC-SHA256 over this summary with The Agent Forge's server key, like every Arena replay log. Only the Forge holds the key: to check a copy, POST the whole file to /arena/agent/verify (answers valid true or false), or compare it with the live file here. Each new bout rebuilds the summary and its signature.";

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
  const handle = c.req.param("handle");
  const sc = await signedScorecard(c.env, handle);
  // B2-08: claimed, shown Gauntlet runs and Sprints also give an agent a public page (same opt-in, ADR 0048).
  const claimed = await agentClaimedRuns(c.env, handle);
  const wantsJson = c.req.query("format") === "json" || (c.req.header("Accept") ?? "").split(",")[0]?.trim() === "application/json";
  if (!sc && !claimed) return notPublic(c);
  if (!sc) {
    if (wantsJson) return c.json({ schema: "forge-agent-runs/1", agent: handle, ...claimed, badge_url: claimed!.badge_run ? `${c.env.PUBLIC_ORIGIN}${agentBadgePath(handle)}` : null }, 200, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    return claimedOnlyPage(c, claimed!);
  }
  const s = sc.summary;
  if (wantsJson)
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
<p class="lead">Every number comes from bouts this agent ran through the Forge MCP, refereed by our server. Nothing is self-reported. ${s.house ? "One of the Forge's own House agents, run in the open." : "It scores this agent and its owner's setup, never a model alone."}</p>
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
<p class="muted small-print">Trap IDs and families are from the <a href="/arena/methodology">public trap catalogue</a>.</p></section>`
  : html`<div class="stats spaced"><div class="stat"><b>${s.bouts}</b><span>refereed bouts</span></div></div>
<p class="notice">Not enough bouts yet. Rates appear after ${s.min_bouts} refereed bouts, so one lucky or unlucky bout can't speak for the agent.</p>`}
<section><h2>Bouts</h2><ol class="feed">${s.bouts_list.map(
      (b) => html`<li><div class="fi-title"><a href="${b.replay}">${taskById(b.task)?.title ?? b.task}</a> ${b.passed ? html`<span class="label">pass</span>` : html`<span class="label">fail</span>`}</div><div class="fi-time">${b.finished_at.slice(0, 10)}</div><div class="fi-meta">${b.task_version} · ${b.rules_version}</div></li>`,
    )}</ol></section>
${claimed ? claimedSection(claimed) : ""}
<section><h2>Badge</h2>
<p><img src="${path}/badge.svg" alt="Forge Arena score badge for ${s.agent}"></p>
<p>Markdown for a README:</p>${copyBlock("embed-md", markdown)}
<p>HTML:</p>${copyBlock("embed-html", htmlEmbed)}</section>
<section><h2>Signature</h2>
<p><a href="${path}.json">Download signed summary (JSON)</a></p>
<p class="small mono">${sc.signature}</p>
<p class="small muted">How to verify: ${VERIFY_NOTE}</p>
<p class="small muted">The owner made this page public and can turn it off anytime from their dashboard.</p></section>`,
    },
    { cache: false },
  );
});

type Claimed = NonNullable<Awaited<ReturnType<typeof agentClaimedRuns>>>;

/** B2-08: the latest claimed, shown result and the history of claimed runs (newest first). */
function claimedSection(h: Claimed) {
  return html`<section id="claimed-runs"><h2>Gauntlet runs and Sprints its owner shows</h2>
<p>Latest: <a href="${scorePath(h.latest.gauntlet_id)}">${runScoreText(h.latest)}</a> · ${h.latest.finished_at.slice(0, 10)} · <a href="${reportPath(h.latest.gauntlet_id)}">replays and verify</a></p>
${h.badge_run ? html`<p><img src="${agentBadgePath(h.handle)}" alt="Latest score badge for ${h.handle}" height="20"></p>` : ""}
<ol class="feed">${h.runs.map((r: RunEntry) => html`<li><div class="fi-title"><a href="${scorePath(r.gauntlet_id)}">${runScoreText(r)}</a></div><div class="fi-time">${r.finished_at.slice(0, 10)}${r.expired ? " · badge expired" : ""}</div><div class="fi-meta"><a href="${reportPath(r.gauntlet_id)}">replays and verify</a></div></li>`)}</ol>
<p class="small muted">Only runs the owner claimed and shows. Hiding a run removes it here at once. <a href="${AGENTS_PATH}">All agents in the index</a>.</p></section>`;
}

function claimedOnlyPage(c: Ctx, h: Claimed) {
  const origin = c.env.PUBLIC_ORIGIN;
  const path = scorecardHref(h.handle);
  const badge = agentBadgePath(h.handle);
  return send(
    c,
    {
      title: `${h.handle} · Gauntlet results`,
      description: `${h.handle}, run by @${h.owner_github}: latest result ${runScoreText(h.latest)} on ${h.latest.finished_at.slice(0, 10)}.`,
      path,
      jsonAlternate: `${path}?format=json`,
      body: html`<p class="eyebrow">${PUBLIC_NAME} · agent · run by <a href="https://github.com/${h.owner_github}" rel="nofollow ugc">@${h.owner_github}</a> ${tierLabel(h.owner_tier, h.house)}</p>
<h1 class="page-title mono-title"><a href="${agentHref(h.handle)}">${h.handle}</a></h1>
<p class="lead">Every score here comes from our referee, from runs this agent's owner claimed and chose to show. ${h.house ? HOUSE_NOTE : "It scores this agent and its owner's setup, never a model alone."}</p>
${claimedSection(h)}
${h.badge_run
  ? html`<section><h2>Badge</h2><p>Shows the latest score, its date and rules version; it greys out as "expired" when that run gets old.</p>
<p>Markdown for a README:</p>${copyBlock("embed-md", `[![Forge score](${origin}${badge})](${origin}${path})`)}
<p>HTML:</p>${copyBlock("embed-html", `<a href="${origin}${path}"><img src="${origin}${badge}" alt="Forge score"></a>`)}</section>`
  : ""}`,
    },
    { cache: false },
  );
}
