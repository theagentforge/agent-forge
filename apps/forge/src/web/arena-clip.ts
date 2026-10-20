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
import { CLIP_HOLD, PLAY, svgAt, terminalAt } from "../../public/gauntlet.js";
import { channelDuels, duelFromRuns, gauntletClipId } from "../arena/featured";
import { clipIndex } from "../arena/clips";
import { raw } from "hono/html";
import { TEASE_LINE } from "@forge/arena";

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


// The Trap Gauntlet clip (ADR 0029): a 1080×1920 page the recorder steps frame by frame with __gxSeek(t), then
// renders the soundtrack with __gxWav(). Safe zones for feeds: nothing that matters in the top 160 px or the bottom
// 480 px. Model-written text never appears; only tool calls, the referee's verdicts and our own templates.
const RUN = "[A-Za-z0-9_-]{1,64}";
site.get(`/arena/gauntlet/:a{${RUN}}/:b{${RUN}}/clip`, async (c) => {
  const d = await duelFromRuns(getDb(c.env), c.req.param("a"), c.req.param("b"));
  if (!d?.gauntlet) return c.notFound();
  const g = d.gauntlet;
  const final = PLAY;
  const body = html`<!doctype html>
<html lang="en" class="gxc-root">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${CLIP_WIDTH}, height=${CLIP_HEIGHT}, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Clip: ${d.headline ?? d.title} · ${PUBLIC_NAME}</title>
<link rel="canonical" href="${c.env.PUBLIC_ORIGIN}/arena/run/${g.lanes[0].id}">
<link rel="preload" href="/fonts/archivo.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/gauntlet-clip.css">
</head>
<body>
<main class="gxc gx" data-gauntlet="${JSON.stringify([d])}" data-mode="clip" data-clip-seconds="${PLAY + CLIP_HOLD}">
<p class="gxc-top"><b>The Forge Arena</b><span>theagentforge.io/arena</span></p>
<header class="gxc-head"><p class="duel-headline" data-headline data-tease="${TEASE_LINE}">${d.headline ?? TEASE_LINE}</p>
<p class="gxc-job">The job: ${d.captions[0]?.replace(/^The job: /, "") ?? d.title}${g.tell ? html`<span>Hidden trap: ${g.tell}</span>` : ""}</p></header>
<div class="gxc-stage" data-gx-stage>${raw(svgAt(g, final, { geo: "clip", label: d.headline }))}</div>
<div class="gxc-term"><ol class="gx-term-lines" data-gx-term>${raw(terminalAt(g, final))}</ol></div>
</main>
<script type="module" src="/gauntlet.js"></script>
</body>
</html>`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...securityHeaders() });
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "public, max-age=300");
  return new Response((await body).toString(), { headers });
});

/** Today's Arena channel duels that need a Gauntlet clip, for the clips workflow (structured data only). */
site.get("/arena/gauntlet/pending.json", async (c) => {
  const [duels, index] = await Promise.all([channelDuels(c.env, getDb(c.env)), clipIndex(c.env)]);
  const skip = new Set([...index.clips, ...index.removed]);
  const pending = duels
    .filter((d) => d.gauntlet)
    .map((d) => ({ id: gauntletClipId(d.a.id, d.b.id), a: d.a.id, b: d.b.id, task: d.task, clip_page: `/arena/gauntlet/${d.a.id}/${d.b.id}/clip` }))
    .filter((x) => !skip.has(x.id));
  return c.json({ clip_seconds: PLAY + CLIP_HOLD, pending }, 200, { "Cache-Control": "public, max-age=300", "X-Robots-Tag": "noindex" });
});
