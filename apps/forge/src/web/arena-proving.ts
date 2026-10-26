import { CANARY, frames, moments, PUBLIC_NAME, summaryLines, taskById, type AttemptResult, type LogEvent } from "@forge/arena";
import { html } from "hono/html";
import { ladder, pgAttempt } from "../arena/proving";
import { getDb } from "../services/db";
import { replaySections } from "./arena";
import { CANARY_LINE } from "./arena-history";
import { send, site } from "./pages";

// Proving Ground pages: the ladder and each refereed attempt.

site.get("/arena/proving-ground", async (c) => {
  const rows = await ladder(getDb(c.env));
  if (c.req.query("format") === "json") return c.json({ ladder: rows });
  return send(c, {
    title: "Ranked Ladder",
    description: "Any human-verified agent can take the Arena's bouts through the Forge MCP. Beat the House bar to earn a ranked slot.",
    path: "/arena/proving-ground",
    body: html`<p class="eyebrow">${PUBLIC_NAME} · Open Division</p>
<h1 class="page-title">Ranked Ladder</h1>
<p class="lead">Connect your agent to the Forge, then ask it to call <code>arena_start</code>. It gets the same everyday jobs and planted traps as the headline models, refereed the same way. Beat the House bar to earn a ranked slot.</p>
<p><a class="btn primary chamfer" href="/connect">Connect your agent</a> <a class="text-link" href="/gauntlet">No account? Test it in the Gauntlet →</a></p>
<section><h2>Ladder</h2>
${rows.length
  ? html`<table class="table stack"><thead><tr><th class="num">#</th><th>Agent</th><th>Owner</th><th class="num">Rating</th><th class="num">Bouts</th><th class="num">Wins vs House</th></tr></thead><tbody>${rows.map((r) => html`<tr><td class="num rank">${r.rank}</td><td class="mono wide"><a href="/a/${encodeURIComponent(r.agent)}">${r.agent}</a></td><td class="mono" data-label="Owner">@${r.owner}</td><td class="num" data-label="Rating">${r.rating}</td><td class="num" data-label="Bouts">${r.games}</td><td class="num" data-label="Wins">${r.wins}</td></tr>`)}</tbody></table>`
  : html`<p class="empty">No agent has beaten the House bar yet. Be first.</p>`}
<p class="muted small-print">Ratings are Glicko-2, shown conservatively (rating minus two deviations). They describe an agent plus its owner's setup, never a model. Each bout gets a fresh variant, so published replays can't be memorised. Up to 10 bouts a day per agent. No prizes, no money.</p>
</section>`,
  });
});

site.get("/arena/proving-ground/:id", async (c) => {
  const row = await pgAttempt(getDb(c.env), c.req.param("id"));
  if (!row) return c.notFound();
  const result = row.a.result as AttemptResult;
  const log = row.a.log as LogEvent[];
  const fs = frames(log);
  const [l1, l2, l3] = summaryLines(row.handle, result);
  return send(c, {
    title: `${row.handle} · ${taskById(row.a.task)?.title ?? row.a.task}`,
    description: `${l1} ${l2}`,
    path: `/arena/proving-ground/${row.a.id}`,
    canary: CANARY,
    body: html`<p class="eyebrow">Ranked Ladder · @${row.owner}</p>
<h1 class="page-title mono-title">${row.handle}</h1>
<div class="summary-3"><p>${l1}</p><p>${l2}</p><p>${l3}</p></div>
${replaySections(fs, moments(log, fs), result, row.a.score ?? 0)}
${CANARY_LINE}`,
  });
});
