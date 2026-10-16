import type { Duel, DuelSide } from "@forge/arena";
import { html } from "hono/html";

// The Arena duel player (ADR 0016, 0019). The server renders the finished box score of the first duel: every caption,
// each corner's full action feed, final bars and the result stamps. That is the no-JS and reduced-motion view.
// site.js then plays the duels: on the home page it cycles through the day's pool; on /arena it follows the clock.
// The Pause button is the player's first focusable control (WCAG 2.2 SC 2.2.2).

/** The referee line (ADR 0018 §1), shown under the player wherever it appears. */
export const REFEREE_LINE = "Every result is checked by a referee, never taken from the AI's word, and every replay can be verified.";

const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

export function stampOf(s: DuelSide): { text: string; cls: string } {
  if (s.fell) return { text: "FOUL", cls: "stamp-foul" };
  if (s.caught) return { text: "TRAP CAUGHT", cls: "stamp-caught" };
  return s.verdict === "PASS" ? { text: "PASS", cls: "stamp-caught" } : { text: s.verdict, cls: "stamp-foul" };
}

function contender(s: DuelSide, slot: "a" | "b") {
  const st = stampOf(s);
  return html`<div class="contender house-${s.house}" data-side="${slot}">
<div class="who"><span class="avatar" aria-hidden="true"><i></i><i></i><b></b></span><span class="name" data-name title="${s.name}">${s.name}</span></div>
<p class="stamp-row"><span class="stamp ${st.cls}" data-stamp>${st.text}</span></p>
<ol class="feed-log mono" data-feed aria-label="What ${s.name} did">${s.feed.map((l) => html`<li class="fl-${l.kind}">${l.text}</li>`)}</ol>
<label class="bar">Progress (verified) <progress data-progress max="1" value="${s.progress.at(-1) ?? 0}"></progress></label>
<label class="bar">Stamina used <progress data-stamina max="1" value="${s.stamina.at(-1) ?? 0}"></progress></label>
<p class="final"><span class="verdict ${s.verdict === "PASS" ? "v-clear" : "v-flagged"} chamfer" data-verdict>${s.verdict}</span> <span class="claim" data-claim>${s.claim} · ${s.check}</span></p>
</div>`;
}

export function duelPlayer(d: Duel, o: { mode: "cycle" | "channel"; channel?: Duel[] }) {
  const list = o.channel?.length ? o.channel : [d];
  return html`<figure class="duel" data-duel="${JSON.stringify(list)}" data-mode="${o.mode}" aria-labelledby="duel-bug">
<div class="duel-top"><button type="button" class="btn chamfer duel-pause" data-duel-pause hidden aria-pressed="false">Pause</button><span class="label" data-duel-label>${d.practice ? "Practice replay" : "Replay"} · ${date(d.recordedAt)}</span></div>
<p class="scorebug" id="duel-bug"><span data-bug-title>${d.title}</span> · Round <span data-bug-round>${d.round}</span>/<span data-bug-rounds>${d.rounds}</span> · <span data-bug-clock>${clock(d.seconds)}</span></p>
<div class="duel-sides">${contender(d.a, "a")}<span class="vs" aria-hidden="true">vs</span>${contender(d.b, "b")}</div>
<div class="predict" data-predict hidden><span>Who falls for it?</span><button type="button" class="btn chamfer" data-pick="a">${d.a.name}</button><button type="button" class="btn chamfer" data-pick="b">${d.b.name}</button><span class="predict-result" data-pick-result aria-live="polite"></span></div>
<ol class="captions" data-captions aria-live="polite">${d.captions.map((c) => html`<li>${c}</li>`)}</ol>
<div class="duel-foot"><span class="dots" data-dots aria-hidden="true">${list.map((_, i) => html`<i class="${i === 0 ? "on" : ""}"></i>`)}</span><span class="small muted" data-next></span></div>
<figcaption class="small muted">${REFEREE_LINE} Pairs are chosen for contrast by a <a href="/arena/rules#featured">published rule</a>, not a ranking.</figcaption>
</figure>`;
}

/** Shown in the player's place before any bout with a contrasting result has been fought. */
export const duelEmpty = html`<div class="duel duel-empty panel chamfer panel-body"><p class="scorebug">The Forge Arena · Season 0</p><p>The first bouts air when Crucible 1 is fought.</p><p class="small muted">${REFEREE_LINE}</p><p><a href="/arena">See the Arena</a></p></div>`;
