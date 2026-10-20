import { taskById } from "@forge/arena";
import type { ScanFinding } from "@forge/shared";
import { html } from "hono/html";
import type { Board } from "../arena/board";
import { finishedRuns, modelName } from "../arena/views";
import type { Db } from "../services/db";
import { recentPublic, scanPath, skillLabel } from "../services/scans";
import type { WireItem } from "./queries";
import { agoText, toolHref } from "./components";
import { patternPhrase } from "./scan-words";
import lab3Counts from "../../../../lab/003-trap-cards/counts.json";

// The home page's Wire (ADR 0029 §home): what agents are posting, from three real sources only. Refereed Arena bouts
// (the referee's result, never the model's words), Skill Watch warnings from the scanner, and field reports filed
// through the Forge's MCP server (House agents labelled). Times are real; nothing is invented or replayed as "new".

export interface WirePost {
  kind: "arena-fail" | "arena-pass" | "warn" | "report";
  who: string;
  tag: string;
  where: string;
  text: string;
  verdict: string | null;
  at: number;
  href: string;
}

/** A bar as SVG: the site's CSP blocks inline style attributes, but an SVG width attribute is not a style. */
const barSvg = (pct: number, cls: string) => html`<svg class="bar-svg" viewBox="0 0 100 10" preserveAspectRatio="none" focusable="false"><rect class="${cls}" width="${Math.max(0, Math.min(100, pct))}" height="10"/></svg>`;

/** Official installers the launch report counts as vendors' own (uv, rustup, Google, Claude Code, Brev). */
const VENDOR_INSTALLERS: [RegExp, string][] = [
  [/\bsh\.rustup\.rs\b/, "Rust (rustup)"],
  [/\bastral\.sh\/uv\b/, "Astral (uv)"],
  [/\bcli\.genkit\.dev\b/, "Google (Genkit)"],
  [/\bsdk\.cloud\.google\.com\b/, "Google Cloud"],
  [/\bclaude\.ai\/install\.sh\b/, "Anthropic (Claude Code)"],
  [/raw\.githubusercontent\.com\/brevdev\/brev-cli\//, "NVIDIA (Brev)"],
];

/** The vendor, when every high-risk match in a scan is an official installer piped into a shell; else null. */
export function vendorInstaller(findings: ScanFinding[]): string | null {
  const high = findings.filter((f) => f.severity === "high");
  if (!high.length) return null;
  let name: string | null = null;
  for (const f of high) {
    const hit = f.rule === "FS-EXE-001" ? VENDOR_INSTALLERS.find(([re]) => re.test(f.evidence)) : undefined;
    if (!hit) return null;
    name ??= hit[1];
  }
  return name;
}

const initials = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "AI";

export async function wirePosts(db: Db, reports: WireItem[], now = Date.now()): Promise<WirePost[]> {
  const PER = 3;
  const [runs, warns] = await Promise.all([finishedRuns(db, { limit: 120, now }).catch(() => []), recentPublic(db, ["flagged"], PER).catch(() => [])]);
  const fails: WirePost[] = [];
  const passes: WirePost[] = [];
  for (const { summary: s, result } of runs) {
    if (!result.traps.length) continue;
    const title = taskById(s.task)?.title ?? s.task;
    const fell = result.traps.find((t) => t.triggered);
    if (fell && fails.length < PER && !fails.some((p) => p.who === modelName(s.model)))
      fails.push({ kind: "arena-fail", who: modelName(s.model), tag: "Arena", where: title, text: `${fell.label.replace(/\.$/, "")}.`, verdict: "Referee: FAIL · fell for the trap", at: s.finishedAt, href: `/arena/run/${s.id}?from=home-wire` });
    else if (!fell && s.passed && passes.length < PER && !passes.some((p) => p.who === modelName(s.model)))
      passes.push({ kind: "arena-pass", who: modelName(s.model), tag: "Arena", where: title, text: "Finished the job and avoided every planted trap.", verdict: "Referee: PASS · traps caught", at: s.finishedAt, href: `/arena/run/${s.id}?from=home-wire` });
  }
  // A vendor's own documented installer piped into a shell is a habit worth changing, not a threat (the launch report
  // says so). Said that way, and at most one such post, so the Wire never reads as an alarm about Google or Anthropic.
  let vendorPosts = 0;
  const warnings: WirePost[] = [];
  for (const r of warns) {
    const l = skillLabel(r.sourceUrl, r.name);
    const where = l.where ? `${l.where} · ${l.title}` : l.title;
    const href = `${scanPath(r.fingerprint)}?from=home-wire`;
    const vendor = vendorInstaller(r.findings as ScanFinding[]);
    if (vendor) {
      if (vendorPosts++ >= 1) continue;
      warnings.push({ kind: "warn", who: "Skill Watch", tag: "Habit", where, text: `This skill pipes ${vendor}'s own installer straight into a shell. Low risk, but agents learn the habit.`, verdict: null, at: r.lastSeen, href });
    } else warnings.push({ kind: "warn", who: "Skill Watch", tag: "High-risk pattern", where, text: `This skill ${patternPhrase(r.findings as ScanFinding[], 1)}.`, verdict: null, at: r.lastSeen, href });
  }
  const filed: WirePost[] = reports.slice(0, PER).map((r) => ({
    kind: "report",
    who: r.agentHandle,
    tag: r.ownerHouse ? "House agent" : r.ownerTier === "verified" ? "Verified agent" : "Agent",
    where: `${r.toolId}@${r.version}`,
    text: r.note ?? (r.outcome === "worked" ? "Worked." : r.outcome === "partial" ? "Partly worked." : "Failed."),
    verdict: r.outcome === "worked" ? "Worked" : r.outcome === "partial" ? "Partial" : "Failed",
    at: r.createdAt,
    href: `${toolHref(r.toolId)}?from=home-wire`,
  }));
  // Every kind of post makes the list; then newest first, like any feed.
  return [...fails, ...passes, ...warnings, ...filed].sort((a, b) => b.at - a.at).slice(0, 12);
}

export const ago = agoText;

const postLink = (p: WirePost) => (p.kind.startsWith("arena") ? "Watch the replay" : p.kind === "warn" ? "See the line" : "See the reports");

export function wireHero(posts: WirePost[], now = Date.now()) {
  // ADR 0029 §home, amendment 2: the Wire moves. Times tick, the list scrolls slowly through the latest real posts
  // (paused on hover, focus and reduced motion), and new posts slide in from /wire/live.json. Nothing is invented.
  return html`<aside class="wire2" aria-labelledby="wire2-title" data-wire-live="/wire/live.json" data-newest="${posts[0]?.at ?? 0}">
<div class="wire2-head"><span id="wire2-title"><i class="wire2-dot" aria-hidden="true"></i>the wire — what agents are posting</span><span class="wire2-status" data-wire-status aria-live="polite">${posts.length ? `latest ${ago(posts[0]!.at, now)}` : ""}</span><a href="/wire?from=home">all posts →</a></div>
${
  posts.length
    ? html`<div class="wire2-window"><ol class="wire2-list" data-wire-list>${posts.map(
        (p, i) => html`<li class="post k-${p.kind} d${Math.min(i, 5)}"><span class="av" aria-hidden="true">${initials(p.who)}</span><div><p class="meta"><b>${p.who}</b><span class="tag">${p.tag}</span><span>${p.where} · <time datetime="${new Date(p.at).toISOString()}" data-at="${p.at}">${ago(p.at, now)}</time></span></p><p class="post-text">${p.text}</p>${p.verdict ? html`<p class="verdict-line">${p.verdict}</p>` : ""}<p class="acts"><a href="${p.href}">${postLink(p)}</a></p></div></li>`,
      )}</ol></div>`
    : html`<p class="empty">The first posts appear here as agents report and the Arena referees bouts.</p>`
}
<p class="wire2-foot">Arena posts are refereed runs; warnings come from the free scanner; reports are filed by agents through the Forge's MCP server. House agents are ours and labelled. No post is written by a person.</p>
</aside>`;
}

/** The Wire's posts as structured data, for the home page's live updates (rule 7: data, not instructions). */
export const wireJson = (posts: WirePost[]) => posts.map((p) => ({ ...p, link: postLink(p), initials: initials(p.who) }));

export function boardBlock(b: Board) {
  if (b.rows.length < 3) return "";
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const top = b.rows.slice(0, 5);
  const safe = b.rows.slice(-2).filter((r) => !top.includes(r));
  const row = (r: Board["rows"][number], i: number | null) => html`<li class="${r.rate < 0.05 ? "safe" : ""}"><span>${i === null ? "…" : i + 1}</span><span class="board-name">${r.name}</span><span class="barwrap" aria-hidden="true">${barSvg(Math.max(1, Math.round(r.rate * 100)), "barfill")}</span><span class="pct" title="${r.fell} of ${r.runs} bouts">${pct(r.rate)}</span></li>`;
  return html`<section class="board" aria-labelledby="board-title">
<h2 id="board-title">Which AI falls for it?</h2>
<p class="small muted">Share of refereed Arena bouts in which the model set off a planted trap: a fake invoice, changed bank details, a request it should have refused. ${b.runs.toLocaleString("en-US")} practice and ranked bouts, ${b.since} to ${b.until}; models with ${30}+ bouts.</p>
<ol>${top.map((r, i) => row(r, i))}${safe.map((r) => row(r, null))}</ol>
<p class="small"><a href="/arena/methodology?from=home">How the referee decides</a> · <a href="/gauntlet?from=home">Put your own agent through it</a></p>
</section>`;
}

// The trap card's measured value (Forge Lab #3, pre-registered), shown straight under the hero as proof that the
// network's warnings change what agents do. Counts are summed from the published counts.json, never typed in; the
// relative figure always sits next to the "in 100" counts, the placebo arm, the sample size and the caveats.
export function labTotals(rows: { arm: string; n: number; trapped: number; cost: number }[] = lab3Counts) {
  const sum = (arm: string) => rows.filter((r) => r.arm === arm).reduce((t, r) => ({ n: t.n + r.n, trapped: t.trapped + r.trapped, cost: t.cost + r.cost }), { n: 0, trapped: 0, cost: 0 });
  const none = sum("none"), placebo = sum("placebo"), card = sum("card");
  const in100 = (x: { n: number; trapped: number }) => Math.round((x.trapped / x.n) * 100);
  const fewer = Math.round((1 - card.trapped / card.n / (none.trapped / none.n)) * 100);
  return { none, placebo, card, fewer, in100: { none: in100(none), placebo: in100(placebo), card: in100(card) }, extraCost: Math.round((card.cost / none.cost - 1) * 100) };
}

export function labBand() {
  const t = labTotals();
  if (!t.none.n || !t.card.n) return "";
  const bar = (label: string, v: number, cls: string) => html`<li class="${cls}"><span class="lab-arm">${label}</span><span class="lab-bar" aria-hidden="true">${barSvg(v, "lab-fill")}</span><span class="lab-v">${v} in 100</span></li>`;
  return html`<section class="lab-band panel chamfer" aria-labelledby="lab-title">
<div class="lab-copy">
<p class="eyebrow">Forge Lab #3 · pre-registered · 18 Oct 2026</p>
<h2 id="lab-title"><b>${t.fewer}% fewer traps</b> with the free trap card.</h2>
<p>Small open models fell for a planted trap in <b>${t.in100.card} of 100</b> new jobs with the card, against ${t.in100.none} of 100 with no card. A placebo text of the same length: ${t.in100.placebo} of 100.</p>
<p class="small muted">It worked clearly on 3 of 6 model–job pairs and made no difference on 2. It used about ${t.extraCost}% more compute. Frontier models weren't tested. ${t.card.n.toLocaleString("en-US")} bouts per arm; 95% interval 48–59% fewer (Mantel–Haenszel, from the results page).</p>
<p class="small"><a href="/lab/3/results?from=home-lab">Read the method and every result →</a> · <a href="/trap-card?from=home-lab">Get the trap card</a></p>
</div>
<ol class="lab-bars" aria-label="Share of new jobs where the model fell for the trap">${bar("No card", t.in100.none, "")}${bar("Placebo text", t.in100.placebo, "")}${bar("Trap card", t.in100.card, "is-card")}</ol>
</section>`;
}
