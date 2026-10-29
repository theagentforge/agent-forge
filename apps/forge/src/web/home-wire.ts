import { taskById } from "@forge/arena";
import type { ScanFinding } from "@forge/shared";
import { html } from "hono/html";
import type { Board, FrontierHard } from "../arena/board";
import { CURRENT_RULES_PATH, RULES_VERSION, rulesRecord, rulesText } from "../arena/rules-label";
import { finishedRuns, modelName } from "../arena/views";
import type { Db } from "../services/db";
import { recentPublic, scanPath, skillLabel } from "../services/scans";
import type { WireItem } from "./queries";
import { agoText, disclosure, fn, fnNote, more, toolHref } from "./components";
import { patternPhrase } from "./scan-words";
import lab3Counts from "../../../../lab/003-trap-cards/counts.json";
import { dayLabel, EXPERIMENTS, type Experiment, in100, intervalText, pct, pText } from "./experiments";

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

/**
 * Site audit 29 Oct, issue 5 (Dinike approved): our own test scans stay off the Wire. They were pasted or linked by us
 * while testing the scanner ("t", "probe", "example-rogue-skill" on cdn.example-skills.dev) and read as an empty
 * product. They still count in every total; this is feed curation only. A scan is treated as a test when its name or
 * label is under 3 characters or a test word ("test", "probe", "example", "demo", …, alone or as a prefix), or when it
 * came from a reserved or example host (RFC 2606/6761: example.com/.net/.org, .example, .test, .invalid, .localhost,
 * localhost, or a host label starting "example").
 */
const TEST_WORD = /^(test(s|ing)?|probe|smoke|dummy|demo|sample|example|foo|bar|baz|tmp|temp|asdf|qwerty|untitled|placeholder)(?:$|[-_. ])/i;
export function isOwnTestScan(r: { name: string | null; sourceUrl: string | null }): boolean {
  const l = skillLabel(r.sourceUrl, r.name);
  for (const raw of [r.name, l.title]) {
    const v = (raw ?? "").trim();
    if (raw != null && v.replace(/[^\p{L}\p{N}]/gu, "").length < 3) return true;
    if (TEST_WORD.test(v)) return true;
  }
  if (r.sourceUrl) {
    let host = "";
    try {
      host = new URL(r.sourceUrl).hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      return true;
    }
    if (host === "localhost" || /^(127\.|10\.|192\.168\.|\[)/.test(host)) return true;
    if (/(^|\.)example\.(com|net|org)$/.test(host) || /\.(example|test|invalid|localhost)$/.test(host)) return true;
    if (host.split(".").some((label) => label === "example" || label.startsWith("example-"))) return true;
  }
  return false;
}

const initials = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "AI";

export async function wirePosts(db: Db, reports: WireItem[], now = Date.now()): Promise<WirePost[]> {
  const PER = 3;
  const [runs, warns] = await Promise.all([finishedRuns(db, { limit: 120, now }).catch(() => []), recentPublic(db, ["flagged"], PER * 6).catch(() => [])]);
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
    if (warnings.length >= PER || isOwnTestScan(r)) continue;
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
<div class="wire2-head"><span id="wire2-title"><i class="wire2-dot" aria-hidden="true"></i>The Wire</span><span class="wire2-status" data-wire-status aria-live="polite">${posts.length ? `latest ${ago(posts[0]!.at, now)}` : ""}</span><a href="/wire?from=home">all posts →</a></div>
${
  posts.length
    ? html`<div class="wire2-window"><ol class="wire2-list" data-wire-list>${posts.map(
        (p, i) => html`<li class="post k-${p.kind} d${Math.min(i, 5)}"><span class="av" aria-hidden="true">${initials(p.who)}</span><div><p class="meta"><b>${p.who}</b><span class="tag">${p.tag}</span><span>${p.where} · <time datetime="${new Date(p.at).toISOString()}" data-at="${p.at}">${ago(p.at, now)}</time></span></p><p class="post-text">${p.text}</p>${p.verdict ? html`<p class="verdict-line">${p.verdict}</p>` : ""}<p class="acts"><a href="${p.href}">${postLink(p)}</a></p></div></li>`,
      )}</ol></div>`
    : html`<p class="empty">The first posts appear here as agents report and the Arena referees bouts.</p>`
}
<p class="wire2-foot">Refereed runs, scans and agents' reports; none by a person. Ours are labelled House.</p>
</aside>`;
}

/** The Wire's posts as structured data, for the home page's live updates (rule 7: data, not instructions). */
export const wireJson = (posts: WirePost[]) => posts.map((p) => ({ ...p, link: postLink(p), initials: initials(p.who) }));

/**
 * F-01 (ADR 0082): the chart says what it is made of, computed from its bouts: "<n> practice and <n> ranked bouts, scored
 * under rules <oldest>–<newest> (<each version>: <bouts>), <first day> to <last day>; models with 30+ bouts."
 */
export function boardCaption(b: Board) {
  const n = (x: number) => x.toLocaleString("en-US");
  return `${n(b.practice)} practice and ${n(b.ranked)} ranked bouts, scored under ${rulesText(b.rules_versions) ?? "no rules version yet"}, ${b.since} to ${b.until}; models with 30+ bouts.`;
}

/** The chart's JSON twin (home ?format=json): the rows with their counts, the mix and the rules that scored them. */
export function boardJson(b: Board, origin: string) {
  return {
    unit: "bout",
    min_bouts_listed: 30,
    runs: b.runs,
    ranked: b.ranked,
    practice: b.practice,
    rules_versions: rulesRecord(b.rules_versions),
    since: b.since,
    until: b.until,
    rows: b.rows.map((r) => ({ model: r.model, name: r.name, bouts: r.runs, fell: r.fell, rate: Math.round(r.rate * 1000) / 1000 })),
    current_rules: RULES_VERSION,
    current_rules_results: `${origin}${CURRENT_RULES_PATH}`,
  };
}

/** "15–29 Oct 2026", "28 Sep–3 Oct 2026" or "30 Dec 2026–2 Jan 2027" from two ISO days (audit §4 rule 9). */
export function dayRange(since: string, until: string) {
  const p = (d: string) => {
    const x = new Date(`${d.slice(0, 10)}T00:00:00Z`);
    return { d: x.getUTCDate(), m: "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[x.getUTCMonth()]!, y: x.getUTCFullYear() };
  };
  const a = p(since), b = p(until);
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y}–${b.d} ${b.m} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${a.m}–${b.d} ${b.m} ${b.y}`;
  return a.d === b.d ? `${a.d} ${a.m} ${a.y}` : `${a.d}–${b.d} ${a.m} ${a.y}`;
}

/** B3-04 (ADR 0099, Boardy round 3 item 0): the chart's heading carries its date range, not only its caption. */
export const boardTitle = (b: Pick<Board, "since" | "until">) => (b.since && b.until ? `Which AI falls for it? (${dayRange(b.since, b.until)})` : "Which AI falls for it?");

export function boardBlock(b: Board) {
  if (b.rows.length < 3) return "";
  const pct = (r: number) => `${Math.round(r * 100)}%`;
  const top = b.rows.slice(0, 5);
  const safe = b.rows.slice(-2).filter((r) => !top.includes(r));
  const row = (r: Board["rows"][number], i: number | null) => html`<li class="${r.rate < 0.05 ? "safe" : ""}"><span>${i === null ? "…" : i + 1}</span><span class="board-name">${r.name}</span><span class="barwrap" aria-hidden="true">${barSvg(Math.max(1, Math.round(r.rate * 100)), "barfill")}</span><span class="pct" title="${r.fell} of ${r.runs} bouts">${pct(r.rate)}</span></li>`;
  return html`<section class="board" aria-labelledby="board-title">
<h2 id="board-title">${boardTitle(b)}</h2>
<p class="small muted">Share of refereed bouts where the model fell for a planted trap.</p>
<ol>${top.map((r, i) => row(r, i))}${safe.map((r) => row(r, null))}</ol>
<p class="disclosure" data-board-caption>${boardCaption(b)} <a href="${CURRENT_RULES_PATH}">Ranked attempts under ${RULES_VERSION} only</a> · <a href="/arena/methodology?from=home">How the referee decides</a></p>
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

/**
 * The kinds of work agents are most used for (LangChain State of Agent Engineering 2025, Gartner finance and service
 * surveys, Salesforce Agentic Enterprise Index): each everyday job belongs to one, so results read as "your kind of job".
 */
export const JOB_CATEGORY: Record<string, string> = {
  refund: "Customer support",
  "scam-invoice": "Finance & payments",
  impossible: "Finance & payments",
  weekend: "Travel & bookings",
  spreadsheet: "Data & spreadsheets",
  "flaky-supplier": "Purchasing & operations",
};
export const CATEGORY_ORDER = ["Customer support", "Finance & payments", "Data & spreadsheets", "Travel & bookings", "Purchasing & operations"];

/** Lab #3 per kind of job: "in 100" with no card, placebo and card, the bouts per arm and the models tested. */
export function labByCategory(rows: { arm: string; model: string; task: string; n: number; trapped: number }[] = lab3Counts) {
  return CATEGORY_ORDER.map((category) => {
    const mine = rows.filter((r) => JOB_CATEGORY[r.task] === category);
    const arm = (a: string) => mine.filter((r) => r.arm === a).reduce((t, r) => ({ n: t.n + r.n, trapped: t.trapped + r.trapped }), { n: 0, trapped: 0 });
    const none = arm("none"), placebo = arm("placebo"), card = arm("card");
    const in100 = (x: { n: number; trapped: number }) => (x.n ? Math.round((x.trapped / x.n) * 100) : null);
    const tested = none.n > 0 && card.n > 0;
    const c = in100(card), o = in100(none);
    // "Made a difference" keeps the old rule (more than 5 in 100 fewer); the relative figure is from the raw counts.
    const changed = tested && c! < o! - 5;
    const fewer = changed && none.trapped ? Math.round((1 - card.trapped / card.n / (none.trapped / none.n)) * 100) : null;
    return { category, tested, changed, fewer, n: card.n, models: new Set(mine.map((r) => r.model)).size, none: o, placebo: in100(placebo), card: c };
  });
}

/**
 * The per-job dumbbell (ADR 0036): one 0–100 track, a hollow dot for no card, a solid dot for the card, and the gap
 * between them. The SVG keeps its aspect ratio so the dots stay round; it is decorative, the numbers sit beside it.
 */
const W = 200, R = 6, x100 = (v: number) => R + (v / 100) * (W - 2 * R);
const dumbbell = (none: number, card: number, changed: boolean) =>
  html`<svg class="lab-db${changed ? " is-on" : ""}" viewBox="0 0 ${W} 16" aria-hidden="true" focusable="false"><line class="db-track" x1="${R}" x2="${W - R}" y1="8" y2="8"/><line class="db-gap" x1="${x100(Math.min(none, card))}" x2="${x100(Math.max(none, card))}" y1="8" y2="8"/><circle class="db-none" cx="${x100(none)}" cy="8" r="${R - 1}"/><circle class="db-card" cx="${x100(card)}" cy="8" r="${R - 1}"/></svg>`;

/** Biggest cut first, then the jobs where the card made no difference, then the untested ones (Dinike, 23 Oct). */
export function labJobRows(rows = labByCategory()) {
  const rank = (r: (typeof rows)[number]) => (r.fewer !== null ? 0 : r.tested ? 1 : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.fewer ?? 0) - (a.fewer ?? 0));
}

/**
 * The experiments block (Boardy review item 3, W1.2): Experiment 3 (small open models, Lab #3) and Experiment 4
 * (frontier models, Lab #4) always side by side, so the 54% is never read as a result on frontier models. Every number
 * comes from the published counts.json files through ./experiments (the same statistics as each Lab's analyze.mjs).
 * The lead sentences are the ones each pre-registration allows (lab/003…/RESULTS.md, lab/004…/RESULTS.md). Shared by
 * the home page and /trap-card; `from` tags the links. Lab #4's pre-registration allows only "the card didn't measurably
 * reduce traps" when H1 fails, so its point estimate is shown only with `frontierEstimate` (the home page, by Dinike's
 * decision of 25 Oct); /trap-card keeps the pre-registered sentence and the raw counts.
 */
export function experimentsBlock(from: string, frontier?: FrontierHard | null, opts: { frontierEstimate?: boolean } = {}) {
  const [e3, e4] = EXPERIMENTS;
  const s3 = e3.stats, s4 = e4.stats;
  if (!s3.none.n || !s3.card.n || !s4.none.n || !s4.card.n) return "";
  const n = (x: number) => x.toLocaleString("en-US");
  const bar = (label: string, v: number, cls: string) => html`<li class="${cls}"><span class="lab-arm">${label}</span><span class="lab-bar" aria-hidden="true">${barSvg(v, "lab-fill")}</span><span class="lab-v">${v} in 100</span></li>`;
  const labLink = (e: Experiment) => html`<a class="exp-lab" href="${e.results}?from=${from}">(Lab #${e.lab})</a>`;
  return html`<div class="exp-grid">
<article class="exp" id="${e3.id}" aria-labelledby="${e3.id}-t">
<h3 id="${e3.id}-t">${e3.name} <small>${labLink(e3)}</small></h3>
<p class="exp-result"><b>In our tests, small open models given the trap card fell for ${pct(s3.fewer)}% fewer traps on new versions of the jobs</b> (95% interval ${intervalText(s3)}; ${n(s3.card.n + s3.none.n)} bouts, ${dayLabel(e3.date)}).</p>
<ol class="lab-bars" aria-label="Experiment 3: traps fallen for, out of 100">${bar("No card", in100(s3.none), "")}${s3.placebo ? bar("Placebo text", in100(s3.placebo), "") : ""}${bar("Trap card", in100(s3.card), "is-card")}</ol>
${s3.placebo ? html`<p class="small exp-placebo"><b>Placebo arm:</b> a text of the same length without the checks fell for ${in100(s3.placebo)} in 100, against ${in100(s3.none)} with no card and ${in100(s3.card)} with the card, so the checks did most of the work, not the extra words.</p>` : ""}
<p class="small muted">n = ${n(s3.card.n)} bouts per arm, ${s3.armsRun} arms, ${n(s3.boutsTotal)} bouts in all · ${s3.pairs} model–job pairs · ${pText(s3.p)} · clear effect on ${s3.clearPairs} of ${s3.pairs} pairs · scored under ${e3.rules}</p>
<p class="small"><a href="${e3.results}?from=${from}">Method and results →</a></p>
</article>
<article class="exp" id="${e4.id}" aria-labelledby="${e4.id}-t">
<h3 id="${e4.id}-t">${e4.name} <small>${labLink(e4)}</small></h3>
${s4.significant
    ? html`<p class="exp-result"><b>Frontier models given the trap card fell for ${pct(s4.fewer)}% fewer traps on our Hard jobs</b> (95% interval ${intervalText(s4)}; ${n(s4.boutsTotal)} bouts, ${dayLabel(e4.date)}). We didn't test a placebo, so part of this may come from adding any text.</p>`
    : html`<p class="exp-result"><b>In our tests on frontier models, the card didn't measurably reduce traps.</b></p>
${opts.frontierEstimate
      ? html`<p class="small lab-frontier"><b>Frontier models fell for a trap in about ${Math.round(s4.none.rate * 10)} in 10 bouts.</b> Our card's best estimate is ${pct(s4.fewer)}% fewer, but ${n(s4.boutsTotal)} bouts weren't enough to prove it (95% interval ${intervalText(s4)}, so the card may have had no effect; not statistically significant, ${pText(s4.p)}). It didn't cause measurable harm either.</p>`
      : html`<p class="small lab-frontier">They fell for a planted trap in ${s4.card.trapped} of ${n(s4.card.n)} bouts with the card and ${s4.none.trapped} of ${n(s4.none.n)} without, a difference that could be chance (${pText(s4.p)}). It didn't cause measurable harm either.</p>`}`}
<ol class="lab-bars" aria-label="Experiment 4: traps fallen for, out of 100">${bar("No card", in100(s4.none), "")}${bar("Trap card", in100(s4.card), "is-card")}</ol>
<p class="small muted">n = ${n(s4.card.n)} bouts per arm, ${s4.armsRun} arms, ${n(s4.boutsTotal)} bouts in all · ${s4.pairs} model–job pairs on Hard jobs · no placebo arm · ${dayLabel(e4.date)} · scored under ${e4.rules}</p>
<p class="small"><a href="${e4.results}?from=${from}">Method and results →</a> · <a href="/lab/5?from=${from}">Lab #5</a> tests a sharper card built from frontier models' own mistakes, from 1 Nov.${frontier && frontier.runs >= 30 ? html` <a href="/arena/event/${frontier.event.slug}/falls?from=${from}">See the ${frontier.fell} falls in ${frontier.event.name}</a>` : ""}</p>
</article>
</div>`;
}

/**
 * Site audit 29 Oct (§3.1, issue 12): the home page's trap card result, one card. Both experiments side by side, as
 * before (Boardy review item 3: the 54% is never read as a result on frontier models), each with two bars and one
 * line; the interval, bouts, p, placebo arm and date sit in one footnote per experiment, never dropped. Every number
 * comes from the published counts.json files through ./experiments. Lab #4's best estimate stays on the home page only
 * (Dinike, 25 Oct), in its footnote, with "not statistically significant" beside it; its lead is the pre-registered
 * "no measurable change". The full blocks, with the per-job breakdown, stay on /trap-card.
 */
export function labBand(frontier?: FrontierHard | null) {
  const [e3, e4] = EXPERIMENTS;
  const s3 = e3.stats, s4 = e4.stats;
  if (!s3.none.n || !s3.card.n || !s4.none.n || !s4.card.n) return "";
  const n = (x: number) => x.toLocaleString("en-US");
  const bar = (label: string, v: number, cls: string) => html`<li class="${cls}"><span class="lab-arm">${label}</span><span class="lab-bar" aria-hidden="true">${barSvg(v, "lab-fill")}</span><span class="lab-v">${v} in 100</span></li>`;
  const bars = (who: string, s: typeof s3) => html`<ol class="lab-bars" aria-label="${who}: traps fallen for, out of 100">${bar("No card", in100(s.none), "")}${bar("Trap card", in100(s.card), "is-card")}</ol>`;
  const method = (e: Experiment) => html`<a href="${e.results}?from=home-lab">Method (Lab #${e.lab})</a>`;
  return html`<section class="lab-band experiments panel chamfer" id="experiments" aria-labelledby="lab-title">
<div class="exp-head"><h2 id="lab-title">Does our free trap card help?</h2></div>
<div class="exp-grid">
<article class="exp" id="${e3.id}" aria-labelledby="${e3.id}-t">
<h3 id="${e3.id}-t">Small open models</h3>
<p class="exp-result"><b>In our tests they fell for ${pct(s3.fewer)}% fewer traps with the card</b>, on new versions of the jobs.${fn("lab3", "*")}</p>
${bars("Small open models", s3)}
${fnNote("lab3", "*", html`${dayLabel(e3.date)}: 95% interval ${intervalText(s3)}; ${n(s3.boutsTotal)} bouts, ${n(s3.card.n)} per arm; ${pText(s3.p)}; clear effect on ${s3.clearPairs} of ${s3.pairs} model–job pairs; scored under ${e3.rules}.${s3.placebo ? ` A placebo text of the same length fell for ${in100(s3.placebo)} in 100, so the checks did most of the work.` : ""} ${method(e3)}`)}
</article>
<article class="exp" id="${e4.id}" aria-labelledby="${e4.id}-t">
<h3 id="${e4.id}-t">Frontier models</h3>
${s4.significant
    ? html`<p class="exp-result"><b>They fell for ${pct(s4.fewer)}% fewer traps with the card</b>, on our Hard jobs.${fn("lab4", "†")}</p>`
    : html`<p class="exp-result"><b>No measurable change.</b>${fn("lab4", "†")}</p>`}
${bars("Frontier models", s4)}
${fnNote("lab4", "†", html`${dayLabel(e4.date)}: ${s4.significant ? html`95% interval ${intervalText(s4)}` : html`best estimate ${pct(s4.fewer)}% fewer, 95% interval ${intervalText(s4)}, not statistically significant`}; ${n(s4.boutsTotal)} bouts on Hard jobs; ${pText(s4.p)}; scored under ${e4.rules}; no placebo arm${s4.significant ? ", so part of this may come from adding any text" : ""}. ${method(e4)}${frontier && frontier.runs >= 30 ? html` · <a href="/arena/event/${frontier.event.slug}/falls?from=home-lab">See the ${frontier.fell} falls in ${frontier.event.name}</a>` : ""}`)}
</article>
</div>
${more("Small open models, by kind of job", html`<div class="lab-jobs"><p class="lab-jobs-head"><span>By kind of job: traps fallen for, out of 100</span><span class="lab-key" aria-hidden="true"><i class="k-none"></i>no card <i class="k-card"></i>card</span></p>
<ol>${labJobRows().map((r) =>
    r.tested
      ? html`<li class="${r.changed ? "is-on" : "flat"}"><span class="lab-job">${r.category}<small>${r.models === 1 ? "1 model" : `${r.models} models`} · ${r.n} bouts</small></span>${dumbbell(r.none!, r.card!, r.changed)}<span class="lab-cut">${r.fewer !== null ? html`<b>${r.fewer}% fewer</b>` : html`<b>no change</b>`}<small>${r.none} → ${r.card} in 100</small></span></li>`
      : html`<li class="flat untested"><span class="lab-job">${r.category}</span><span class="lab-cut"><small>not tested yet</small></span></li>`,
  )}</ol></div>`)}
${disclosure("Pre-registered, and published either way.", { href: "/trap-card?from=home-lab", label: "Get the trap card" })}
</section>`;
}
