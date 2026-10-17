import { PUBLIC_NAME, publicTrapId, taskById, versionLine } from "@forge/arena";
import { html } from "hono/html";
import { CLIP_SECONDS, pendingClips } from "../arena/clips";
import { failCard, verifiedReplay } from "../arena/fail-card";
import { modelById } from "../arena/lineup";
import { modelName, runWithLog } from "../arena/views";
import { getDb } from "../services/db";
import { REFEREE_LINE } from "./duel";
import { securityHeaders } from "./layout";
import { CARD_LABEL } from "./og";
import { site } from "./pages";

// The clip view of a bout (ADR 0023 §1, amendment 1): a 1080×1920 page a headless browser records into a vertical MP4.
// Every caption comes from the fail-card templates (arena/fail-card.ts) or fixed text here, filled with our own
// lineup name, task title, trap id and date. Nothing the model wrote appears.
// The server renders the finished state, which is what no-JS and reduced-motion viewers see. /clip.js adds the
// "clip-play" class (only when motion is allowed), and /clip.css plays the beats once in ~20 s, then holds.

export const CLIP_WIDTH = 1080;
export const CLIP_HEIGHT = 1920;

site.get("/arena/run/:id{[A-Za-z0-9_-]+}/clip", async (c) => {
  const id = c.req.param("id");
  const r = await runWithLog(getDb(c.env), id);
  if (!r) return c.notFound();
  const task = taskById(r.run.task);
  const taskTitle = task?.title ?? r.run.task;
  const name = modelName(r.run.modelId);
  const exact = modelById(r.run.modelId)?.route.model ?? r.run.modelId;
  const practice = r.event.kind === "practice";
  const card = failCard({ runId: id, modelName: name, result: r.result, taskTitle, practice, finishedAt: r.run.finishedAt! });
  const ok = await verifiedReplay(c.env, id, r.log, r.run.signature);
  const first = r.result.traps.find((t) => t.triggered);
  const trapId = first ? (publicTrapId(r.run.task, first.id) ?? first.id) : null;
  const verdict = r.result.passed ? "PASS" : r.result.reason.startsWith("knockout") ? "KO" : "FAIL";
  const good = card.kind === "caught" || card.kind === "pass";
  const body = html`<!doctype html>
<html lang="en" class="clip-root">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${CLIP_WIDTH}, height=${CLIP_HEIGHT}, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="clip-size" content="${CLIP_WIDTH}x${CLIP_HEIGHT}">
<title>Clip: ${card.sentence} · ${PUBLIC_NAME}</title>
<link rel="canonical" href="${c.env.PUBLIC_ORIGIN}/arena/run/${id}">
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/clip.css">
<script src="/clip.js" defer></script>
</head>
<body class="clip clip-${good ? "good" : "bad"}" data-clip data-clip-seconds="${CLIP_SECONDS}" data-clip-moment="${card.kind}">
<main class="clip-frame">
<header class="clip-top"><span class="clip-brand">${PUBLIC_NAME}</span><span class="clip-tag">${practice ? "Practice · not ranked" : r.event.name}</span></header>
<section class="beat beat-1" aria-label="Model">
<p class="clip-label">The model</p>
<h1 class="clip-model">${name}</h1>
<p class="clip-exact">${exact}</p>
</section>
<section class="beat beat-2" aria-label="Task">
<p class="clip-label">The job</p>
<p class="clip-task">${taskTitle}</p>
<p class="clip-meta">Variant ${r.run.seed} · ${versionLine(r.run.task, r.run.finishedAt!)}</p>
</section>
<section class="beat beat-3 moment-${card.kind}" aria-label="What happened">
<p class="clip-label clip-flag">${CARD_LABEL[card.kind]}${trapId ? html` · <span class="mono">${trapId}</span>` : ""}</p>
<p class="clip-sentence">${card.sentence}</p>
${card.moreTraps ? html`<p class="clip-meta">and ${card.moreTraps} more ${card.moreTraps === 1 ? "trap" : "traps"} in this bout</p>` : ""}
</section>
<section class="beat beat-4" aria-label="Referee verdict">
<p class="clip-verdict v-${verdict === "PASS" ? "pass" : "fail"}">${verdict}</p>
<p class="clip-referee">${REFEREE_LINE}</p>
<p class="clip-dated">${card.dated[0]!.toUpperCase()}${card.dated.slice(1)}</p>
<p class="clip-verified ${ok ? "ok" : ""}">${ok ? "Verified replay" : "Replay not verified"}</p>
<p class="clip-link">${card.shortLink}</p>
</section>
<div class="clip-progress" aria-hidden="true"><i></i></div>
</main>
</body>
</html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...securityHeaders() });
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response((await body).toString(), { headers });
});

/** Bouts that need a clip, for the clips workflow (structured data only, AGENTS.md rule 7). */
site.get("/arena/clips/pending.json", async (c) => {
  const data = await pendingClips(c.env);
  return c.json(data, 200, { "Cache-Control": "public, max-age=300", "X-Robots-Tag": "noindex" });
});
