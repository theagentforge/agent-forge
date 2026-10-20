import { TEASE_LINE, type Duel, type DuelSide } from "@forge/arena";
import { html, raw } from "hono/html";
import { PLAY, esc, svgAt, terminalAt } from "../../public/gauntlet.js";

// The Arena duel player (ADR 0016, 0019). The server renders the finished box score of the first duel: every caption,
// each corner's full action feed, final bars and the result stamps. That is the no-JS and reduced-motion view.
// site.js then plays the duels: on the home page it cycles through the day's pool; on /arena it follows the clock.
// The Pause button is the player's first focusable control (WCAG 2.2 SC 2.2.2).

/** The referee line (ADR 0018 §1), shown under the player wherever it appears. */
export const REFEREE_LINE = "Every result is checked by a referee, never taken from the AI's word, and every replay can be verified.";

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function stampOf(s: DuelSide): { text: string; cls: string } {
  if (s.fell) return { text: "FELL FOR IT", cls: "stamp-foul" };
  if (s.caught) return { text: "TRAP CAUGHT", cls: "stamp-caught" };
  return s.verdict === "PASS" ? { text: "PASS", cls: "stamp-caught" } : { text: s.verdict, cls: "stamp-foul" };
}

function contender(s: DuelSide, slot: "a" | "b") {
  const st = stampOf(s);
  return html`<div class="contender house-${s.house}" data-side="${slot}">
<div class="who"><span class="avatar" aria-hidden="true"><i></i><i></i><b></b></span><span class="name" data-name title="${s.name}">${s.name}</span></div>
<p class="stamp-row"><span class="stamp ${st.cls}" data-stamp>${st.text}</span></p>
<ol class="feed-log mono" data-feed aria-label="What ${s.name} did">${s.feed.map((l) => html`<li class="fl-${l.kind}">${l.text}</li>`)}</ol>
<label class="bar">Verified progress <progress data-progress max="1" value="${s.progress.at(-1) ?? 0}"></progress></label>
<label class="bar bar-stamina">Stamina used <progress data-stamina max="1" value="${s.stamina.at(-1) ?? 0}"></progress></label>
<p class="final"><span class="verdict ${s.verdict === "PASS" ? "v-clear" : "v-flagged"} chamfer" data-verdict>${s.verdict}</span> <span class="claim" data-claim>${s.claim} · ${s.check}</span></p>
<p class="said-checked" data-said-checked><span class="said">${s.claim}</span><span class="checked ${s.verdict === "PASS" ? "ok" : "bad"}">${s.check.replace("Checked: ", "Referee: ")}</span></p>
</div>`;
}

/**
 * The Trap Gauntlet player (ADR 0029): two pixel robots run the job as a course, one tile per real tool call, beside
 * a terminal of the real calls. The server draws the finished frame with the same renderer the browser plays.
 */
/** The Wordle-style result people paste anywhere: both corners' grids, the job, and a link back to the bout. */
export const shareGrid = (d: Duel) =>
  `Same job, one hidden trap (${d.title}):\n${d.gauntlet!.lanes.map((l) => `${l.grid} ${l.name}`).join("\n")}\ntheagentforge.io/arena/run/${d.gauntlet!.lanes[0].id}`;

export function gauntletPlayer(d: Duel, o: { mode: "cycle" | "channel"; channel?: Duel[]; clipUrl?: string | null }) {
  const g = d.gauntlet!;
  const list = (o.channel?.length ? o.channel : [d]).filter((x) => x.gauntlet);
  const meta = (l: (typeof g.lanes)[number], tag: string) =>
    `<li>[${tag}] <a href="/arena/run/${esc(l.id)}">${esc(l.model)}</a>${l.provider ? ` via ${esc(l.provider)}` : ""} · ${l.turns} turns · ${l.tokens.toLocaleString("en-US")} tokens · $${l.cost.toFixed(4)}</li>`;
  return html`<figure class="gx" data-gauntlet="${JSON.stringify(list)}" data-mode="${o.mode}" aria-labelledby="gx-head">
<div class="duel-top"><span class="gx-controls"><button type="button" class="btn chamfer duel-pause" data-gx-pause hidden aria-pressed="false">Pause</button><button type="button" class="btn chamfer gx-sound" data-gx-sound hidden aria-pressed="false">🔇 Sound off</button></span><span class="label" data-gx-label>${d.practice ? "Practice replay" : "Replay"} · ${date(d.recordedAt)} · ${d.title}</span></div>
<p class="duel-headline" id="gx-head" data-headline data-tease="${TEASE_LINE}" aria-live="polite">${d.headline ?? TEASE_LINE}</p>
<p class="gx-tell" data-gx-tell${g.tell ? "" : " hidden"}><span>The job:</span> <span data-gx-job>${d.captions[0]?.replace(/^The job: /, "") ?? d.title}</span> <span class="gx-tell-trap">Hidden trap: <span data-gx-trap>${g.tell ?? ""}</span></span></p>
<div class="gx-body">
<div class="gx-stage" data-gx-stage>${raw(svgAt(g, PLAY, { label: d.headline }))}</div>
<div class="gx-term" aria-label="The real tool calls">
<p class="gx-term-head mono" data-gx-termhead>$ forge replay --task ${esc(g.task)} --seed ${g.seed}</p>
<ol class="gx-term-lines mono" data-gx-term>${raw(terminalAt(g, PLAY))}</ol>
<ul class="gx-term-foot mono" data-gx-foot>${raw(meta(g.lanes[0], "A") + meta(g.lanes[1], "B"))}<li>Same seed, same sandbox: the referee re-checks every call. Nothing the models wrote is shown.</li></ul>
</div>
</div>
<div class="predict" data-predict hidden><span>Who falls for it?</span><button type="button" class="btn chamfer" data-pick="a">${g.lanes[0].name}</button><button type="button" class="btn chamfer" data-pick="b">${g.lanes[1].name}</button><span class="predict-result" data-pick-result aria-live="polite"></span></div>
<p class="duel-stakes small" data-gx-stakes${d.stakes ? "" : " hidden"}>${d.stakes ?? ""}</p>
<div class="gx-share"><code data-gx-grid id="gx-grid-${esc(g.lanes[0].id).slice(0, 8)}">${shareGrid(d)}</code><button type="button" class="btn primary chamfer" data-native-share data-share-from="gx-grid-${esc(g.lanes[0].id).slice(0, 8)}" hidden>Share…</button><button class="btn chamfer" type="button" data-copy="gx-grid-${esc(g.lanes[0].id).slice(0, 8)}" hidden>Copy result</button>${o.clipUrl ? html`<a class="btn chamfer" href="${o.clipUrl}" data-clip-link>Download the clip (MP4, with sound)</a>` : ""}</div>
<figcaption class="small muted">${REFEREE_LINE} Pairs are chosen for contrast by a <a href="/arena/rules#featured">published rule</a>, not a ranking.</figcaption>
<script type="module" src="/gauntlet.js"></script>
</figure>`;
}

export function duelPlayer(d: Duel, o: { mode: "cycle" | "channel"; channel?: Duel[]; clipUrl?: string | null }) {
  if (d.gauntlet) return gauntletPlayer(d, o);
  const list = o.channel?.length ? o.channel : [d];
  return html`<figure class="duel" data-duel="${JSON.stringify(list)}" data-mode="${o.mode}" aria-labelledby="duel-bug">
<div class="duel-top"><button type="button" class="btn chamfer duel-pause" data-duel-pause hidden aria-pressed="false">Pause</button><span class="label" data-duel-label>${d.practice ? "Practice replay" : "Replay"} · ${date(d.recordedAt)}</span></div>
<p class="duel-headline" data-headline data-tease="${TEASE_LINE}" aria-live="polite">${d.headline ?? TEASE_LINE}</p>
<p class="scorebug" id="duel-bug"><span data-bug-title>${d.title}</span> · Round <span data-bug-round>${d.round}</span>/<span data-bug-rounds>${d.rounds}</span> · <span data-bug-clock>${clock(d.seconds)}</span></p>
<ol class="captions" data-captions aria-live="polite">${d.captions.map((c) => html`<li>${c}</li>`)}</ol>
<div class="duel-sides">${contender(d.a, "a")}<span class="vs" aria-hidden="true">vs</span>${contender(d.b, "b")}</div>
<div class="predict" data-predict hidden><span>Who falls for it?</span><button type="button" class="btn chamfer" data-pick="a">${d.a.name}</button><button type="button" class="btn chamfer" data-pick="b">${d.b.name}</button><span class="predict-result" data-pick-result aria-live="polite"></span></div>
<p class="duel-stakes small" data-stakes ${d.stakes ? "" : "hidden"}>${d.stakes ?? ""}</p>
<div class="duel-foot"><span class="dots" data-dots aria-hidden="true">${list.map((_, i) => html`<i class="${i === 0 ? "on" : ""}"></i>`)}</span><span class="small muted" data-next></span></div>
<figcaption class="small muted">${REFEREE_LINE} Pairs are chosen for contrast by a <a href="/arena/rules#featured">published rule</a>, not a ranking.</figcaption>
</figure>`;
}

/** Shown in the player's place before any bout with a contrasting result has been fought. */
export const duelEmpty = html`<div class="duel duel-empty panel chamfer panel-body"><p class="scorebug">The Forge Arena · Season 0</p><p>The first bouts air when Crucible 1 is fought.</p><p class="small muted">${REFEREE_LINE}</p><p><a href="/arena">See the Arena</a></p></div>`;
