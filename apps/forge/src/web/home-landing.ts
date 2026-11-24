import type { Duel } from "@forge/arena";
import { TRAP_CHECKS } from "@forge/shared";
import { html, raw } from "hono/html";
import { ACTION_VERSION } from "../../../../integrations/gauntlet-action/src/run";
import { PLAY, esc, stampWord, terminalAt } from "../../public/gauntlet.js";
import type { FallSummary } from "../arena/results";
import { SPRINT_PATH } from "../arena/sprint";
import { FIRST_CHECK } from "../services/connect-test";
import { launchScanHeadline } from "../reports/skill-scan-facts";
import { copyBlock } from "./components";
import { EXPERIMENTS, pct } from "./experiments";
import type { refereeValidity } from "../arena/research-validity";
import type { HeroVariant } from "../arena/hero-variants";

// Same values as web/gauntlet-ci.ts (a test pins them); not imported, because that module registers routes on `site`
// from pages.ts, which imports this one.
export const GAUNTLET_CI_PATH = "/gauntlet/ci";
export const GAUNTLET_ACTION_USES = "theagentforge/gauntlet@v1";

// The home page (BRAND.md v1.5, Dinike 16 Nov 2026 10:28 Colombo: "audit it completely ... and then execute"). The first
// screen leads with what only the Forge does: AI agents tested on everyday business jobs with planted traps, refereed
// from the sandbox, with a real refereed replay beside the headline. Every figure on it is already public elsewhere and
// links to the page that publishes it. No counts of outside use, installs or checks (Dinike, 13 Nov 09:43 and 16 Nov
// 09:34). The page is the same for every visitor (edge cache and KV snapshots), and it loads no player script.

/**
 * The h1 when no variant can be built (no eligible replay pair): the trap test in general, claiming no particular fall.
 * Normally the hero shows one of the day's variants (arena/hero-variants.ts), picked at random in the browser.
 */
export const LANDING_H1 = "We hide traps in everyday business jobs. Watch AI agents walk into them.";
/** The sub-line's fixed half (Dinike's 16 Nov brief); the event figure in front of it is read live (heroSubline). */
export const LANDING_LEAD = "A referee checks what the agent did, not what it said, and every replay is signed.";
/**
 * The sub-line under every variant: the latest ranked Hard event's figure, in /security's words and from the same
 * summary (so the two can't disagree), then the referee sentence. Without the figure, the referee sentence alone.
 */
export function heroSubline(h: FallSummary | null) {
  // Tightened 16 Nov (hero polish) so the button sits in the first screen: the event's name and model count are in the
  // proof strip just below, from the same summary.
  return h?.event && h.attempts ? `${h.fell.toLocaleString("en-US")} of ${h.attempts.toLocaleString("en-US")} attempts in our latest ranked Hard event fell for a planted trap. ${LANDING_LEAD}` : LANDING_LEAD;
}
/** The one primary call to action, here and in the header of every page (layout.ts HEAD_CTA): the 90-second Sprint. */
export const LANDING_CTA = { label: "Test your agent", href: SPRINT_PATH, note: "Free, 90 seconds, no account." } as const;
export const LANDING_SECONDARY = { label: "or check a tool before you install it", href: "#check" } as const;
/** Home `<title>`, share title and description: trap testing first, check before install second. */
export const LANDING_TITLE = "AI agents tested on everyday jobs with hidden traps · The Agent Forge";
/** Share title: 60 characters at most (test/arena-pages.test.ts), so a shorter cut of the hook. */
export const LANDING_OG_TITLE = "Watch AI agents walk into traps hidden in everyday jobs";
export const LANDING_DESCRIPTION =
  "We hide traps in everyday business jobs and referee what AI agents actually do. Test yours free in 90 seconds, or check a tool before install.";

export const GAUNTLET_MARKETPLACE_URL = "https://github.com/marketplace/actions/forge-gauntlet";
export const GAUNTLET_REPO_URL = "https://github.com/theagentforge/gauntlet";

/**
 * The bout beside "Watch AI agents walk into them" must show one: a ranked bout with the Trap Gauntlet course where
 * exactly one side fell for the planted trap (arena/featured.ts heroFallDuel picks it). Anything else, a practice
 * bout, a knockout or a bout where both passed, is refused here too, and the page shows its empty panel instead.
 */
export function heroDuel(d: Duel | null): Duel | null {
  const lanes = d?.gauntlet?.lanes;
  return d && !d.practice && lanes && lanes.filter((l) => l.fell).length === 1 ? d : null;
}

const isHard = (task: string) => /-hard\d*$/.test(task);

/**
 * Gives each terminal line its place (data-i), which staggers the one print-in on load (site.css .lp-term). A knockout
 * (the bout ran out of turns, time or tool calls) is not a fall, so its referee line is neutral, not the fall's red.
 */
/** The terminal's fixed row count (site.css .lp-term): every variant's panel is the same height. */
export const TERM_ROWS = 8;

/**
 * The hero terminal's lines: the last TERM_ROWS, except that the highlighted trap call is always kept. If the last rows
 * would drop it, it is shown first, followed by the last TERM_ROWS - 1 lines (reviewer, 16 Nov).
 */
export function heroTermLines(all: string[]): string[] {
  const tail = all.slice(-TERM_ROWS);
  if (tail.some((l) => l.includes("gx-trapline"))) return tail;
  const trap = all.findLast((l) => l.includes("gx-trapline"));
  return trap ? [trap, ...all.slice(-(TERM_ROWS - 1))] : tail;
}

const numbered = (lines: string) => {
  let i = 0;
  return lines
    .replace(/<li class="gx-failline">(referee ▸ \[[AB]\] [^<]*: KNOCKOUT)<\/li>/g, '<li class="gx-koline">$1</li>')
    // A failed job without a fall (a wrong amount, an unfinished step) is amber like its stamp; red is the fall's alone.
    .replace(/<li class="gx-failline">(referee ▸ \[[AB]\] [^<]*: FAIL)<\/li>/g, '<li class="gx-jobfail">$1</li>')
    .replace(/<li class="/g, () => `<li data-i="${Math.min(i++, 9)}" class="`);
};

/** The stamp beside each model: red only for the fall; a knockout gets its own neutral stamp. */
export function laneStamp(l: { fell: boolean; caught: boolean; verdict: "PASS" | "FAIL" | "KO" }) {
  if (l.fell) return { cls: "stamp-foul", word: stampWord(l as never) };
  if (l.verdict === "KO") return { cls: "stamp-ko", word: "KNOCKOUT" };
  if (l.verdict === "PASS") return { cls: "stamp-caught", word: stampWord(l as never) };
  return { cls: "stamp-fail", word: stampWord(l as never) };
}

/** "Ranked bout · Hard" or "Practice bout, not ranked": the label says which, every time. */
export function replayKind(d: Duel) {
  return d.practice ? "Practice bout, not ranked" : `Ranked bout${isHard(d.task) ? " · Hard job" : ""}`;
}

/**
 * The refereed replay on the first screen: the bout's real tool calls and the referee's verdicts, drawn by the same
 * renderer as the Arena player (public/gauntlet.js terminalAt, final frame). Nothing the models wrote is shown. The
 * lines print one after another once on load (CSS only; none under reduced motion); the finished record is the HTML.
 */
/** The panel's line for a replay signed before format v2 (coordinator decision, 16 Nov), word for word. */
export const V1_REPLAY_LABEL = "Signed by us (replay format v1, before 28 Oct 2026); not independently verifiable — newer replays are.";

export function heroReplay(d: Duel | null, format: "v2" | "v1" = "v2", idSuffix = "") {
  const tid = `lp-replay-t${idSuffix}`;
  if (!d?.gauntlet)
    return html`<figure class="lp-replay lp-replay-empty chamfer" aria-labelledby="lp-replay-t"><p class="lp-replay-bar mono" id="lp-replay-t">replay</p><div class="lp-replay-body"><p>Every Arena job hides planted traps, a fake invoice among them. The first refereed replays appear here.</p><p><a href="/arena/methodology#catalog">See the trap catalogue</a></p></div></figure>`;
  const g = d.gauntlet;
  const run = g.lanes[0].id;
  const day = new Date(d.recordedAt).toISOString().slice(0, 10);
  const job = d.captions?.[0]?.replace(/^The job: /, "") ?? d.title;
  const lines = heroTermLines(terminalAt(g, PLAY, Infinity).match(/<li[\s\S]*?<\/li>/g) ?? []).join("");
  return html`<figure class="lp-replay chamfer" aria-labelledby="${tid}" data-run="${run}" data-ranked="${d.practice ? "no" : "yes"}" data-replay-format="${format}">
<p class="lp-replay-bar mono"><span id="${tid}">replay · ${d.title}</span><span class="label">${d.practice ? "practice" : "ranked"}</span></p>
<div class="lp-replay-body">
<p class="lp-tell"><span>The job:</span> ${job}</p>
${g.tell ? html`<p class="lp-tell lp-tell-trap"><span>Hidden trap:</span> ${g.tell}</p>` : ""}
<ol class="lp-term mono" aria-label="The real tool calls, then the referee">${raw(numbered(lines))}</ol>
<ul class="lp-lanes">${g.lanes.map((l, k) => html`<li><span class="mono lp-who">[${k ? "B" : "A"}]</span> <a href="/arena/run/${encodeURIComponent(l.id)}?from=home-replay">${l.name}</a> <span class="stamp ${laneStamp(l).cls}">${raw(esc(laneStamp(l).word))}</span></li>`)}</ul>
${d.stakes ? html`<p class="lp-stakes">${d.stakes}</p>` : ""}
</div>
<figcaption class="lp-replay-cap"><span>${replayKind(d)}, ${day}. Same job, same seed, two models.</span>${format === "v1" ? html`<span class="lp-v1" data-replay-v1>${V1_REPLAY_LABEL}</span>` : ""} <a href="/arena/run/${encodeURIComponent(run)}?from=home-replay">Watch the full replay</a> <a href="/methodology#replays">${format === "v1" ? "How replays are verified" : "How to verify it"}</a></figcaption>
</figure>`;
}

/**
 * The small same-origin script that picks a variant at random per page load (the CSP allows no inline script). A classic
 * script placed right after the hero (no module, defer or async), so the pick happens before the first paint.
 */
export const HERO_VARIANTS_SCRIPT = "/hero-variants.js";

/**
 * The first screen (Dinike, 16 Nov 12:08 Colombo: keep it changing, so it doesn't look like we test one thing). Every
 * variant is in the cached HTML, the same for every visitor. The h1 holds the first variant's words (the no-JS view);
 * every variant's replay is in one grid cell, the others hidden (visibility, aria-hidden, inert), and hidden copies of
 * every h1 sit in the h1's cell, so the hero is as tall as its tallest variant whichever one shows: no layout shift even
 * if the script is slow. public/hero-variants.js picks one at random and shows "Show another trap"; nothing moves by
 * itself (WCAG 2.2.2), and a polite live region names the new headline. Under the h1, the trap families of the
 * published catalogue, so the variety shows even on one view.
 */
export function heroBlock(variants: HeroVariant[], subline: string, families: string[]) {
  const first = variants[0];
  const many = variants.length > 1;
  return html`<section class="lp-hero" aria-labelledby="home-h1" data-hero-variants="${variants.length}">
<div class="lp-hero-copy">
<div class="hero-cell lp-h1-cell"><h1 id="home-h1" data-variant-h1${first ? html` data-trap="${first.trap_id}"` : ""}>${first ? first.h1 : LANDING_H1}</h1>${many ? variants.map((v) => html`<p class="hero-size lp-h1-size" aria-hidden="true" data-nosnippet>${v.h1}</p>`) : ""}</div>
<p class="lead">${subline}</p>
<div class="lp-cta"><a class="btn primary chamfer" href="${LANDING_CTA.href}?from=home-hero" data-home-primary>${LANDING_CTA.label}</a><a class="lp-secondary" href="${LANDING_SECONDARY.href}">${LANDING_SECONDARY.label}</a></div>
<p class="small muted lp-cta-note">${LANDING_CTA.note}</p>
</div>
${families.length ? html`<p class="small lp-families">Hidden in our jobs: ${families.join(" · ")}.</p>` : ""}
<div class="lp-replay-col">
<div class="hero-cell" data-variant-slot>${
    variants.length
      ? variants.map((v, i) =>
          i
            ? html`<div class="lp-variant hero-size" data-variant="${i}" data-trap="${v.trap_id}" data-h1="${v.h1}" aria-hidden="true" inert data-nosnippet>${heroReplay(v.fall.duel, v.fall.format, `-${i}`)}</div>`
            : html`<div class="lp-variant" data-variant="0" data-trap="${v.trap_id}" data-h1="${v.h1}">${heroReplay(v.fall.duel, v.fall.format)}</div>`,
        )
      : heroReplay(null)
  }</div>
${many ? html`<p class="lp-another-row"><button type="button" class="btn chamfer lp-another" data-variant-next hidden>Show another trap →</button></p>` : ""}
<p class="sr-only" aria-live="polite" data-variant-status></p>
</div>
</section>
${many ? html`<script src="${HERO_VARIANTS_SCRIPT}"></script>` : ""}`;
}
export interface ProofFigure {
  key: "referee" | "crucible" | "trap_card" | "ci";
  figure: string;
  text: string;
  href: string;
  source: string;
  /** A second link where a caveat needs one (the trap card: Lab #5, frontier models). */
  also?: { href: string; label: string }[];
}

/**
 * The proof strip, each figure read from the page that publishes it: the referee-validity report (only once it is
 * public), the latest ranked Hard event (the same summary /security and arena_results give), Lab #3's published counts,
 * and the Gauntlet action's released version. An item without its source is left out, never shown as zero.
 */
export function proofItems(o: { validity: ReturnType<typeof refereeValidity>; hard: FallSummary | null }): ProofFigure[] {
  const n = (x: number) => x.toLocaleString("en-US");
  const out: ProofFigure[] = [];
  if (o.validity)
    out.push({
      key: "referee",
      figure: `${n(o.validity.agree)} of ${n(o.validity.trap_verdicts)}`,
      text: "trap verdicts where an independent re-grade agreed with our referee",
      href: new URL(o.validity.url).pathname,
      source: `Referee validity, version ${o.validity.version}`,
    });
  if (o.hard?.event && o.hard.attempts)
    out.push({
      key: "crucible",
      figure: `${n(o.hard.fell)} of ${n(o.hard.attempts)}`,
      text: `attempts fell for a planted trap in ${o.hard.event_name}, our latest ranked Hard event, across ${o.hard.models} ${o.hard.models === 1 ? "model" : "models"}${o.hard.rules_versions.length ? `, scored under ${o.hard.rules_versions.join(", ")}` : ""}`,
      href: `/arena/event/${o.hard.event}/falls`,
      source: "See the falls",
    });
  const e3 = EXPERIMENTS[0];
  if (e3?.stats.none.n && e3.stats.card.n)
    out.push({
      key: "trap_card",
      figure: `${pct(e3.stats.fewer)}% fewer`,
      text: `traps fallen for by small open models given our free trap card (pre-registered, scored under ${e3.rules}; frontier models: no measurable change)`,
      href: `${e3.results}?from=home-proof`,
      source: `Lab #${e3.lab} method and caveats`,
      also: [
        { href: "/lab/4/results?from=home-proof", label: "Lab #4: frontier models" },
        { href: "/lab/5/results?from=home-proof", label: "Lab #5: a sharper card, frontier models" },
      ],
    });
  out.push({ key: "ci", figure: `v${ACTION_VERSION}`, text: "of the Gauntlet GitHub Action: a blocking release check for your agent", href: GAUNTLET_MARKETPLACE_URL, source: "On the GitHub Marketplace" });
  return out;
}

export function proofStrip(items: ProofFigure[]) {
  if (!items.length) return "";
  return html`<section class="lp-proof" aria-labelledby="lp-proof-t"><h2 class="sr-only" id="lp-proof-t">What backs it</h2><ul>${items.map(
    (i) => html`<li data-proof-item="${i.key}"><b>${i.figure}</b><span>${i.text}</span><a href="${i.href}">${i.source}</a>${(i.also ?? []).map((a) => html`<a class="lp-also" href="${a.href}">${a.label}</a>`)}</li>`,
  )}</ul></section>`;
}

/** The short CI workflow on the home page: the published one, without the comment line. */
export const homeWorkflow = () => `on: [pull_request]
jobs:
  gauntlet:
    runs-on: ubuntu-latest
    steps:
      - uses: ${GAUNTLET_ACTION_USES}
        with:
          model: gpt-5-mini
          api-key: \${{ secrets.OPENAI_API_KEY }}`;

/** Three ways to use it, one action each: CI, check before install, the trap card. */
export function waysBlock(origin: string) {
  const e3 = EXPERIMENTS[0];
  return html`<section class="lp-ways" aria-labelledby="lp-ways-t">
<h2 id="lp-ways-t">Three ways to use it</h2>
<div class="lp-way" id="ci">
<div class="lp-way-copy"><h3>Block a release when your agent falls for a trap</h3>
<p>The Gauntlet runs as a GitHub Action on every pull request, with your model and your key. The check fails when your agent pays a changed payee, follows a hidden instruction or claims a job it didn't do.</p>
<p><a class="lp-act" href="${GAUNTLET_CI_PATH}?from=home-ways">Add the Gauntlet to CI</a></p></div>
<div class="lp-way-art"><div class="lp-code"><p class="lp-code-bar mono">.github/workflows/gauntlet.yml</p><pre id="lp-ci-yaml"><code>${homeWorkflow()}</code></pre><button class="btn chamfer lp-copy" type="button" data-copy="lp-ci-yaml" hidden>Copy</button></div></div>
</div>
<div class="lp-way" id="check">
<div class="lp-way-copy"><h3>Check a tool before you install it</h3>
<p>Paste an MCP server, agent skill, npm or PyPI package: published advisories (OSV), a scan of skill files and field reports from other people's agents, each dated. Free, no account.</p>
<p class="small">Example: <a href="/check?q=${encodeURIComponent(FIRST_CHECK.id)}&amp;from=home-example" class="mono">${FIRST_CHECK.tool} ${FIRST_CHECK.version}</a> comes back <b>flagged</b>: a published OSV advisory (${FIRST_CHECK.advisory}) covers that exact version.</p>
${launchScanHeadline() ? html`<p class="small">${launchScanHeadline()}, mostly vendors' own installers; no malware found by this method. <a href="/reports/skill-scan-2026-10?from=home">Read the report</a></p>` : ""}</div>
<div class="lp-way-art">
<form class="scan-quick lp-check" method="post" action="/go"><input type="hidden" name="from" value="home-check"><label class="sr-only" for="home-go">A skill link, MCP server or package</label><input id="home-go" name="q" type="text" autocomplete="off" spellcheck="false" placeholder="npm:…, pypi:…, github.com/… or a skill link" maxlength="2048" required><button class="btn chamfer" type="submit">Check it</button></form>
<p class="small">Or let your agent check every install itself. Claude Code, one line:</p>
${copyBlock("home-mcp", `claude mcp add --scope user --transport http forge ${origin}/mcp/public`)}
<p class="small muted">Any app that takes a remote MCP server: <code>${origin}/mcp/public</code>. <a href="/connect?from=home-ways">Other apps</a>. A result is an observation on its date by the stated method, not a warranty (<a href="/terms#results">Terms</a>).</p>
</div>
</div>
<div class="lp-way" id="trap-card">
<div class="lp-way-copy"><h3>Give your agent the trap card</h3>
<p>A short, free text of checks for the traps agents fall for most, to paste into your agent's instructions. ${e3?.stats.none.n ? html`In our pre-registered test, small open models given it fell for ${pct(e3.stats.fewer)}% fewer traps; on frontier models it made no measurable difference (<a href="/lab/4/results?from=home-ways">Lab #4</a>; a sharper card didn't either, <a href="/lab/5/results?from=home-ways">Lab #5</a>).` : ""}</p>
<p><a class="lp-act" href="/trap-card?from=home-ways">Get the trap card</a></p></div>
<div class="lp-way-art"><ul class="lp-card-peek">${TRAP_CHECKS.slice(0, 3).map((c) => html`<li>${c.text}</li>`)}</ul><p class="small muted">The first ${Math.min(3, TRAP_CHECKS.length)} of the card's ${TRAP_CHECKS.length} checks, word for word. The full card is on <a href="/trap-card?from=home-ways">its page</a>${e3 ? html`, with <a href="${e3.results}?from=home-ways">the method and every caveat</a>` : ""}.</p></div>
</div>
</section>`;
}

/**
 * For teams and buyers: BRAND.md's one-line descriptor and the proof links a skeptic can check (home-proof.ts, as the
 * 12 Nov claim block), then the evidence, citable and downloadable. The referee-validity report is linked only once it
 * is public.
 */
export function buyersBlock(claim: unknown, validity: ReturnType<typeof refereeValidity>) {
  return html`<section class="lp-buyers panel chamfer" aria-labelledby="lp-buyers-t">
<div><h2 id="lp-buyers-t">For security teams and buyers</h2>
${claim}
<p>The data behind every result is public, versioned and citable.</p></div>
<ul>
<li><a href="/benchmark?from=home-buyers">The Forge Trap Set</a><span>the versioned benchmark, with results by model</span></li>
${validity ? html`<li><a href="${new URL(validity.url).pathname}?from=home-buyers">Referee validity, version ${validity.version}</a><span>a citable report on how often the referee is right</span></li>` : ""}
<li><a href="/dataset?from=home-buyers">The dataset</a><span>what the data holds, its formats and licence</span></li>
<li><a href="/arena/methodology?from=home-buyers">Methodology</a><span>how jobs, traps and the referee work</span></li>
<li><a href="/security?from=home-buyers">Security overview</a><span>what an agent can be tricked into doing, measured</span></li>
</ul>
<p class="lp-buyers-act"><a class="lp-act" href="/teams?from=home-buyers">Talk to us about your agents</a></p>
</section>`;
}
