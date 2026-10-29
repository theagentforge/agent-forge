import { familyOf, JOB_LINE, reach, taskById, type Duel } from "@forge/arena";
import { TRAP_CHECKS, type ScanFinding } from "@forge/shared";
import { and, eq, gte, isNull } from "drizzle-orm";
import { gullibilityBoard } from "../arena/board";
import { rulesSpan } from "../arena/rules-label";
import { clipIndex } from "../arena/clips";
import { channelDuels, gauntletClipId } from "../arena/featured";
import { failCard } from "../arena/fail-card";
import { failOfTheWeek, fotwPath } from "../arena/fail-of-the-week";
import { easternDaylight, lastHeadlineSlot, nextHeadlineSlot, slotDate, weeklyModels, weeklySlug, weeklyTask } from "../arena/headline-slot";
import { modelById } from "../arena/lineup";
import { finishedRuns, modelName, notEmbargoedModel, runWithLog } from "../arena/views";
import * as t from "../db/schema";
import type { Db } from "../services/db";
import { labTotals } from "../web/home-wire";
import { patternPhrase } from "../web/scan-words";
import { crossed, metricValues, MILESTONE_WINDOW_MS, milestoneTexts } from "./milestones";

// Social posts drafted from live data (docs/launch/social-strategy.md §6 and §9.1). Every number and name comes from
// the referee, the board or Skill Watch at request time; the wording comes from fixed templates, several per type,
// so the drafter can rotate them (X's duplicate rule). Nothing here is written by a model. The drafter workflow picks a
// variant, applies the no-URL and variety guards, and files it; the verifier re-checks the facts from public pages.

export type PostType =
  | "trap-of-the-day"
  | "catch-card"
  | "clip"
  | "board-change"
  | "skill-watch"
  | "poll"
  | "bout-teaser"
  | "bout-result"
  | "recap"
  | "trap-card-tip"
  | "milestone"
  | "fail-of-the-week";

export interface Draft {
  type: PostType;
  /** When it should go out, ISO UTC. */
  at: string;
  /** The same post in different words; the drafter takes the first that passes its guards. */
  texts: string[];
  image?: string;
  alt?: string;
  /** A Gauntlet clip on the clips release (gx-<a8>-<b8>.mp4), for native video upload. */
  video?: string;
  poll?: { options: string[]; duration_minutes: number };
  /** One link reply under the post, at most one a day across all types (§2 links, $0.20 each). */
  reply?: string;
  /** A milestone post (social/milestones.ts): its id, filed once ever and always approved by hand. */
  milestone?: string;
  /**
   * V4: never auto-published. The drafter files it without the "auto" label, so it waits for Dinike's approve, and
   * files the Moltbook draft beside it (its own approve-to-post issue).
   */
  approveOnly?: boolean;
  /** V4: a Moltbook post draft (submolt, title, content), filed as its own approve-only "moltbook" issue. */
  moltbook?: { submolt: string; title: string; content: string };
  /** What the verifier re-checks, from public pages: runs by id, and every number that appears in the text. */
  facts: { runs?: { id: string; model: string; fell: boolean; passed: boolean }[]; numbers: number[]; names: string[]; sources: string[] };
}

/** The weekly calendar in US Eastern time (§6). Sunday: nothing. */
export const CALENDAR: { day: number; hour: number; type: PostType }[] = [
  { day: 1, hour: 10, type: "skill-watch" },
  { day: 1, hour: 14, type: "trap-of-the-day" },
  { day: 2, hour: 9, type: "board-change" },
  { day: 2, hour: 13, type: "clip" },
  { day: 3, hour: 9, type: "poll" },
  { day: 3, hour: 13, type: "trap-card-tip" },
  { day: 4, hour: 12, type: "bout-teaser" },
  { day: 5, hour: 9, type: "bout-result" },
  { day: 5, hour: 13, type: "recap" },
  { day: 6, hour: 11, type: "catch-card" },
  // V4: Saturday afternoon, after Thursday night's headline bout is refereed and its clip recorded. Approve only.
  { day: 6, hour: 15, type: "fail-of-the-week" },
];

/** A US Eastern wall-clock time on a date, as a UTC timestamp. */
export function easternToUtc(date: string, hour: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hour + (easternDaylight(y, m - 1, d) ? 4 : 5));
}

/** The slots on one US Eastern date (YYYY-MM-DD). */
export function slotsOn(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return CALENDAR.filter((c) => c.day === day).map((c) => ({ type: c.type, at: new Date(easternToUtc(date, c.hour)).toISOString() }));
}

const fmtDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
};
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const job = (d: Duel) => upperFirst((d.captions[0] ?? "").replace(/^The job: /, ""));
/** "The Flaky Supplier (Hard)" → "Flaky Supplier (Hard)", for "in our … test". */
const bare = (title: string) => title.replace(/^The /, "");
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const dropDot = (s: string) => s.replace(/\.$/, "");
/** The trap card check that answers a task's trap, if any. */
const checkFor = (task: string, trap: string | null) => TRAP_CHECKS.find((c) => trap && c.traps.includes(`${familyOf(task)}/${trap}`));
/** Today's duels where one side fell for the trap and the other didn't, best-known models first. */
async function contrastDuels(env: Env, db: Db, now: number) {
  const duels = (await channelDuels(env, db, now).catch(() => [])).filter((d) => d.gauntlet && d.a.fell !== d.b.fell);
  return duels.sort((x, y) => reach(y.a.model) + reach(y.b.model) - reach(x.a.model) - reach(x.b.model));
}
const sides = (d: Duel) => (d.a.fell ? { faller: d.a, catcher: d.b } : { faller: d.b, catcher: d.a });
const label = (d: Duel) => (d.practice ? "Practice bout" : "Ranked bout");

async function fellSentence(db: Db, id: string, name: string, now: number) {
  const r = await runWithLog(db, id, now);
  if (!r) return null;
  const c = failCard({ runId: id, modelName: name, result: r.result, taskTitle: taskById(r.run.task)?.title ?? r.run.task, practice: r.event.kind === "practice", finishedAt: r.run.finishedAt ?? now });
  const trap = r.result.traps.find((x) => x.triggered);
  return c.kind === "trap" ? { sentence: c.sentence, trap: trap?.id ?? null, task: r.run.task, at: r.run.finishedAt ?? now } : null;
}

async function trapOfTheDay(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  for (const d of await contrastDuels(env, db, now)) {
    const { faller, catcher } = sides(d);
    const fell = await fellSentence(db, faller.id, faller.name, now);
    if (!fell) continue;
    const when = fmtDate(fell.at);
    const tell = d.gauntlet!.tell;
    const texts = [
      `Same job. Same hidden trap.\n\n${job(d)}\n\n${dropDot(fell.sentence)}. ${catcher.name} didn't.\n\n${label(d)}, ${when}.`,
      `${dropDot(fell.sentence)}, in our ${bare(d.title)} test. ${catcher.name} did the same job without falling for it.${d.stakes ? `\n\n${d.stakes}` : ""}`,
      `Who falls for it?\n\n${job(d)}${tell ? `\nHidden trap: ${tell}` : ""}\n\n${faller.name}: fell for it.\n${catcher.name}: didn't.\n\n${label(d)}, ${when}.`,
      `${d.stakes ?? `${d.title}, one hidden trap.`}\n\nThat's what ${faller.name} did in our test: ${lowerFirst(dropDot(fell.sentence.replace(faller.name, "").trim()))}. ${catcher.name} didn't, on the same job and seed.`,
    ];
    return {
      type: "trap-of-the-day",
      at,
      texts,
      image: `/og/x/gauntlet/${d.a.id}/${d.b.id}.png`,
      alt: `Two pixel robots run the same course of tool calls in ${d.title}. ${catcher.name}'s lane is stamped TRAP CAUGHT; ${faller.name}'s robot falls through a trapdoor under FELL FOR IT. From a refereed bout on theagentforge.io.`,
      facts: { runs: [{ id: faller.id, model: faller.model, fell: true, passed: faller.verdict === "PASS" }, { id: catcher.id, model: catcher.model, fell: false, passed: catcher.verdict === "PASS" }], numbers: [], names: [faller.name, catcher.name, d.title], sources: [`/arena/run/${faller.id}.json`, `/arena/run/${catcher.id}.json`] },
    };
  }
  return null;
}

async function catchCard(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const d = (await contrastDuels(env, db, now))[0];
  if (!d) return null;
  const { faller, catcher } = sides(d);
  const fell = await fellSentence(db, faller.id, faller.name, now);
  const check = checkFor(d.task, fell?.trap ?? null);
  // The check's first sentence keeps the post short; the whole card is one tap away on the site.
  const line = check ? `\n\nFrom our free trap card:\n"${check.text.split(/(?<=\.) /)[0]}"` : "";
  const texts = [
    `${catcher.name} caught the hidden trap in our ${bare(d.title)} test. ${faller.name} fell for it on the same job.${line}`,
    `Trap caught: ${catcher.name}, ${d.title}.\n\n${job(d)} ${d.gauntlet!.tell ? `The trap: ${d.gauntlet!.tell}` : ""}\n\n${faller.name} fell for it. Same job, same seed.`,
    `${catcher.name} got through ${d.title} without falling for the hidden trap. ${faller.name} didn't.${line}`,
    `${catcher.name} vs ${faller.name}, same job, same hidden trap.\n\n${catcher.name} caught it.${d.stakes ? `\n\n${d.stakes.replace(/^In real life: /, "The cost it avoided: ")}` : ""}`,
  ];
  return {
    type: "catch-card",
    at,
    texts,
    image: `/og/x/arena/run/${catcher.id}.png`,
    alt: `The Agent Forge bout card stamped TRAP CAUGHT for ${catcher.name} in ${d.title}, with a happy pixel robot. theagentforge.io.`,
    facts: { runs: [{ id: catcher.id, model: catcher.model, fell: false, passed: catcher.verdict === "PASS" }, { id: faller.id, model: faller.model, fell: true, passed: faller.verdict === "PASS" }], numbers: [], names: [faller.name, catcher.name, d.title], sources: [`/arena/run/${catcher.id}.json`] },
  };
}

async function clip(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const index = await clipIndex(env).catch(() => ({ clips: [] as string[], removed: [] as string[] }));
  for (const d of await contrastDuels(env, db, now)) {
    const id = gauntletClipId(d.a.id, d.b.id);
    if (!index.clips.includes(id)) continue;
    const texts = [
      `Same job, same hidden trap. ${d.a.name} or ${d.b.name}: who falls for it?\n\n${d.title}. Sound on.`,
      `${job(d)}\n\nOne hidden trap. Two AIs. Watch who falls for it.`,
      `Two AI agents, one job, one trap.\n\n${d.a.name} vs ${d.b.name} in ${d.title}. The referee checks every call.`,
      `Who falls for it, ${d.a.name} or ${d.b.name}?\n\n${d.title}, from a refereed bout. Nothing the models wrote is shown.`,
    ];
    return {
      type: "clip",
      at,
      texts,
      video: `${id}.mp4`,
      image: `/og/x/gauntlet/${d.a.id}/${d.b.id}.png`,
      alt: `A 19-second clip: two pixel robots run the same course of tool calls in ${d.title}; one falls for the hidden trap.`,
      facts: { runs: [d.a, d.b].map((s) => ({ id: s.id, model: s.model, fell: s.fell, passed: s.verdict === "PASS" })), numbers: [], names: [d.a.name, d.b.name, d.title], sources: [`/arena/run/${d.a.id}.json`] },
    };
  }
  return null;
}

async function boardChange(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const b = await gullibilityBoard(env, db, now);
  if (b.rows.length < 3) return null;
  const pct = (r: number) => Math.round(r * 100);
  const top = b.rows.slice(0, 3);
  const safe = b.rows.at(-1)!;
  const lines = top.map((r) => `${r.name}: ${pct(r.rate)}%`).join("\n");
  const prevKey = `social:board:${new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)}`;
  const prev = await env.KV.get<{ model: string; rate: number }[]>(prevKey, "json");
  await env.KV.put(`social:board:${new Date(now).toISOString().slice(0, 10)}`, JSON.stringify(b.rows.map((r) => ({ model: r.model, rate: r.rate }))), { expirationTtl: 30 * 86_400 });
  const moves = (prev ?? []).map((p) => ({ p, r: b.rows.find((r) => r.model === p.model) })).filter((x) => x.r && Math.abs(pct(x.r.rate) - pct(x.p.rate)) >= 3);
  const move = moves.sort((x, y) => Math.abs(y.r!.rate - y.p.rate) - Math.abs(x.r!.rate - x.p.rate))[0];
  const moved = move ? `\n\nBiggest move this week: ${move.r!.name}, ${pct(move.p.rate)}% to ${pct(move.r!.rate)}%.` : "";
  const numbers = [...top.map((r) => pct(r.rate)), pct(safe.rate), b.runs, b.practice, b.ranked, ...b.rules_versions.map((v) => Number(v.version.replace(/^rules /, ""))), ...(move ? [pct(move.p.rate), pct(move.r!.rate)] : [])];
  // F-01 (ADR 0082, review ADR 0085): the board pools practice and ranked bouts and several rules versions, so every
  // wording says so, as the home chart's caption does (no extra link reply: replies are limited and cost money).
  const mix = `${b.practice.toLocaleString("en-US")} practice and ${b.ranked.toLocaleString("en-US")} ranked bouts, rules ${(rulesSpan(b.rules_versions) ?? "").replace(/^rules /, "")}.`;
  const texts = [
    `Which AI falls for it?\n\nShare of refereed bouts where the model set off a planted trap:\n${lines}\n…\n${safe.name}: ${pct(safe.rate)}%${moved}\n\n${mix}`,
    `The AIs most likely to fall for a planted trap, from refereed bouts:\n${lines}\n\nLeast likely: ${safe.name}, ${pct(safe.rate)}%.${moved}\n\n${mix}`,
    `Fake invoices, changed bank details, requests to refuse. How often each AI falls for them:\n${lines}\n…\n${safe.name}: ${pct(safe.rate)}%\n\n${mix}`,
    `Weekly board: which AI falls for it?\n${lines}\n${safe.name} sits at ${pct(safe.rate)}%.${moved}\n\nEvery bout is refereed: ${mix}`,
  ];
  return { type: "board-change", at, texts, facts: { numbers, names: b.rows.map((r) => r.name), sources: ["/?format=json"] } };
}

async function skillWatch(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const since = now - 7 * 86_400_000;
  // The weekly bulk scan (ADR 0107) is left out: its clear files are public but its pattern matches stay unlisted, so
  // counting its public rows would inflate "scanned" and shrink the matched share (review ADR 0111).
  const rows = await db.select().from(t.skillScans).where(and(eq(t.skillScans.public, true), gte(t.skillScans.firstSeen, since), isNull(t.skillScans.origin)));
  if (!rows.length) return null;
  const risky = rows.filter((r) => r.verdict === "flagged");
  const phrase = risky.length ? patternPhrase(risky.flatMap((r) => r.findings as ScanFinding[]), 1).replace(/^(has|have) /, "") : null;
  const n = rows.length, m = risky.length;
  const N = n.toLocaleString("en-US"), M = m.toLocaleString("en-US");
  const texts = [
    `Skill Watch: we scanned ${N} public agent skills this week. ${M} matched a high-risk pattern${phrase ? `, most often ${phrase}` : ""}.\n\nA match is a reason to read the line, not proof of bad intent.`,
    `What agent skills told agents to do this week: ${N} scanned, ${M} with a high-risk pattern.\n\nEach one links to the exact line, so you can read it before your agent does.`,
    `${M} of the ${N} agent skills we scanned this week tell an agent to do something worth a second look${phrase ? `, most often ${phrase}` : ""}.`,
    `Skill Watch: ${N} skills scanned this week, ${M} matched a high-risk pattern.\n\nThe scan is free and runs before install, with no account.`,
  ];
  return { type: "skill-watch", at, texts, facts: { numbers: [n, m], names: [], sources: ["/skill-watch?format=json"] } };
}

/** The weekly bout on or after a post's own time (not the drafting time), so a draft for next week names next week's job. */
const nextThursdayBout = (at: number) => {
  const slot = nextHeadlineSlot(at);
  return { slot, task: weeklyTask(slot), models: weeklyModels().map((id) => ({ id, name: modelById(id)?.name ?? id })) };
};

async function poll(_env: Env, _db: Db, _now: number, at: string): Promise<Draft | null> {
  const { slot, task, models } = nextThursdayBout(Date.parse(at));
  const options = [...models].sort((x, y) => reach(y.id) - reach(x.id)).slice(0, 4).map((m) => m.name.slice(0, 25));
  const minutes = Math.min(7 * 24 * 60, Math.max(5, Math.round((slot - Date.parse(at)) / 60_000)));
  const line = JOB_LINE[task.id] ?? `The job: ${task.title}.`;
  const texts = [
    `Thursday 8 pm ET: ${models.length} AI models get the same everyday job, with one hidden trap.\n\n${line}\n\nWhich one falls for it?`,
    `Call it before Thursday's bout. ${line} One hidden trap. Which AI falls for it?`,
    `${task.title}, Thursday 8 pm ET. Each lab's everyday model, the same hidden trap.\n\nWho falls for it first?`,
    `Same job, same hidden trap, ${models.length} AIs. ${line}\n\nYour pick: which one falls for it?`,
  ];
  return { type: "poll", at, texts, poll: { options, duration_minutes: minutes }, facts: { numbers: [models.length, 8], names: [...models.map((m) => m.name), task.title], sources: ["/arena?format=json"] } };
}

async function trapCardTip(_env: Env, _db: Db, now: number, at: string): Promise<Draft | null> {
  const week = Math.floor(now / (7 * 86_400_000));
  const check = TRAP_CHECKS[week % TRAP_CHECKS.length]!;
  const l = labTotals();
  const texts = [
    `One line for your AI's custom instructions:\n\n"${check.text}"\n\nIt's from our free trap card. In Lab #3, small open models given the card fell for planted traps in ${l.in100.card} of 100 new jobs, against ${l.in100.none} of 100 without it.`,
    `Paste this into your AI's settings:\n\n"${check.text}"\n\nOne of 8 checks on our free trap card, each from a trap AIs fell for in our tests.`,
    `"${check.text}"\n\nThat's one check from our trap card. Small open models with the card: ${l.in100.card} traps in 100 new jobs. Without it: ${l.in100.none}.`,
    `A check worth giving your AI before it pays, books or deletes anything:\n\n"${check.text}"\n\nFrom our free trap card, built from real traps.`,
  ];
  return { type: "trap-card-tip", at, texts, facts: { numbers: [l.in100.card, l.in100.none, 100, 8], names: [check.text], sources: ["/trap-card?format=json", "/lab/3/results"] } };
}

async function boutTeaser(_env: Env, _db: Db, _now: number, at: string): Promise<Draft | null> {
  const { slot, task, models } = nextThursdayBout(Date.parse(at));
  if (slot - Date.parse(at) > 24 * 3_600_000) return null;
  const names = models.map((m) => m.name).join(", ");
  const line = JOB_LINE[task.id] ?? `The job: ${task.title}.`;
  const texts = [
    `Tonight 8 pm ET: ${models.length} AI models, one everyday job, one hidden trap.\n\n${line}\n\n${names}. Who falls for it?`,
    `Tonight's bout: ${task.title}. ${line}\n\nOne hidden trap, the same for everyone. Call it before 8 pm ET.`,
    `8 pm ET tonight. Each lab's everyday model gets the same job: ${lowerFirst(line.replace(/^The job: /, ""))}\n\nOne of them will fall for the hidden trap. Which?`,
    `${models.length} AIs, one trap, tonight at 8 pm ET.\n\n${line}\n\n${names}.`,
  ];
  return { type: "bout-teaser", at, texts, facts: { numbers: [models.length, 8], names: [...models.map((m) => m.name), task.title], sources: ["/arena?format=json"] } };
}

/** The last weekly headline event's results, per model, once every attempt is refereed. */
async function weeklyResults(db: Db, now: number) {
  const slot = nextHeadlineSlot(now - 7 * 86_400_000);
  if (slot > now) return null;
  const [ev] = await db.select().from(t.arenaEvents).where(eq(t.arenaEvents.slug, weeklySlug(slot)));
  if (!ev) return null;
  // Embargoed models (K2) never reach a social draft.
  const runs = await db.select().from(t.arenaRuns).where(and(eq(t.arenaRuns.eventId, ev.id), notEmbargoedModel()));
  if (!runs.length || runs.some((r) => r.status === "queued" || r.status === "running")) return null;
  const done = runs.filter((r) => r.status === "done");
  const by = new Map<string, { n: number; fell: number; passed: number }>();
  for (const r of done) {
    const s = by.get(r.modelId) ?? { n: 0, fell: 0, passed: 0 };
    s.n++;
    if ((r.result as { traps: { triggered: boolean }[] }).traps.some((x) => x.triggered)) s.fell++;
    if (r.passed) s.passed++;
    by.set(r.modelId, s);
  }
  return { slot, date: slotDate(slot), task: weeklyTask(slot), rows: [...by].map(([model, s]) => ({ model, name: modelName(model), ...s })) };
}

async function boutResult(_env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const w = await weeklyResults(db, now);
  if (!w) return null;
  const fell = w.rows.filter((r) => r.fell > 0).sort((a, b) => b.fell - a.fell);
  const clean = w.rows.filter((r) => r.fell === 0 && r.passed === r.n);
  const lines = w.rows.sort((a, b) => b.fell - a.fell || b.passed - a.passed).map((r) => `${r.name}: ${r.fell ? `fell for it ${r.fell} of ${r.n}` : `${r.passed} of ${r.n} passed`}`).join("\n");
  const head = fell.length ? `${fell[0]!.name} fell for the hidden trap in ${fell[0]!.fell} of ${fell[0]!.n} attempts.` : `No model fell for the hidden trap.`;
  const texts = [
    `Thursday's bout: ${w.task.title}.\n\n${lines}`,
    `${head} ${clean.length ? `${clean.map((r) => r.name).slice(0, 2).join(" and ")} got every attempt right.` : ""}\n\n${w.task.title}, ${w.rows.length} AIs, 3 attempts each.`,
    `Results, ${w.task.title}:\n${lines}\n\nRefereed on every call.`,
    `${w.rows.length} AIs, the same job, the same hidden trap. ${head}`,
  ];
  const numbers = w.rows.flatMap((r) => [r.fell, r.n, r.passed]).concat([w.rows.length, 3]);
  return { type: "bout-result", at, texts, facts: { numbers, names: [...w.rows.map((r) => r.name), w.task.title], sources: [`/arena?format=json`] } };
}

async function recap(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const runs = await finishedRuns(db, { limit: 5000, now }).catch(() => []);
  const week = runs.filter((r) => r.summary.finishedAt >= now - 7 * 86_400_000);
  if (week.length < 10) return null;
  const traps = week.filter((r) => r.result.traps.some((x) => x.triggered)).length;
  const d = (await contrastDuels(env, db, now))[0];
  const best = d ? sides(d) : null;
  const tail = best ? ` Catch of the week: ${best.catcher.name} in ${d!.title}.` : "";
  const texts = [
    `This week in the Arena: ${week.length.toLocaleString("en-US")} refereed bouts, ${traps.toLocaleString("en-US")} with a planted trap set off.${tail}`,
    `${week.length.toLocaleString("en-US")} bouts this week. In ${traps.toLocaleString("en-US")} of them, the AI fell for a planted trap.${tail}`,
    `Week in review: ${traps.toLocaleString("en-US")} traps set off across ${week.length.toLocaleString("en-US")} refereed bouts.${tail}`,
    `The Arena this week: ${week.length.toLocaleString("en-US")} bouts, ${traps.toLocaleString("en-US")} fell for a trap.${tail}`,
  ];
  return { type: "recap", at, texts, reply: "Every bout, with its replay: https://theagentforge.io/arena?from=x-recap", facts: { numbers: [week.length, traps], names: best ? [best.catcher.name, d!.title] : [], sources: ["/arena?format=json"] } };
}

/**
 * Milestones go out Tue–Thu mornings (US Eastern), at least 3 hours from other posts: on Tuesday in the 9 am slot
 * (instead of the board change), on Wednesday in the 1 pm slot (instead of the trap card tip), on Thursday at 9 am
 * (3 hours before the bout teaser). The poll and the bout cycle are never moved.
 */
export const MILESTONE_SLOTS: Record<number, { hour: number; replaces: PostType | null }> = {
  2: { hour: 9, replaces: "board-change" },
  3: { hour: 13, replaces: "trap-card-tip" },
  4: { hour: 9, replaces: null },
};

/**
 * Milestone posts quote outside-only numbers ("10 AI agents from outside our team"), and Dinike's rule of 28 Oct says
 * those stay private ("do not show external only numbers anywhere on the site, only privately for our internal
 * evaluation"). The drafts are served by the public /api/v1/social/drafts, and /stats no longer shows the number a post
 * would link to, so milestones are off until Dinike decides otherwise (review of ADR 0082, ADR 0085).
 */
export const MILESTONE_POSTS = false;

/** The biggest outside-only milestone crossed in the last 7 days, as a draft for `at`; null when there's none. */
async function milestone(env: Env, db: Db, now: number, at: string): Promise<Draft | null> {
  const m = crossed(await metricValues(env, db, now, now - MILESTONE_WINDOW_MS))[0];
  if (!m) return null;
  return {
    type: "milestone",
    at,
    milestone: m.id,
    texts: milestoneTexts(m),
    reply: "Live numbers: https://theagentforge.io/stats?from=x-milestone",
    facts: { numbers: [m.threshold], names: [], sources: ["/stats?format=json"] },
  };
}

/** "Business email compromise: a hijacked …" → "business email compromise" (the pattern's name, before the colon). */
const patternName = (p: string | null) => (p ? lowerFirst(p.split(":")[0]!.trim()) : null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * V4, Fail of the Week: the last weekly headline bout's pick (arena/fail-of-the-week.ts), as an X post and a Moltbook
 * post. Claims are at most two sentences; every number is on /arena/fail-of-the-week/<date>. Approve only.
 */
async function failOfTheWeekDraft(env: Env, _db: Db, now: number, at: string): Promise<Draft | null> {
  const slot = lastHeadlineSlot(Date.parse(at));
  if (slot === null || slot > now) return null;
  const f = await failOfTheWeek(env, slot, now);
  if (!f) return null;
  const s = dropDot(f.card.sentence);
  const job = bare(f.task.title);
  const pattern = patternName(f.trap.pattern);
  const when = fmtDate(Date.parse(`${f.date}T12:00:00Z`));
  const texts = [
    ...(pattern ? [`Fail of the Week: ${s}, in Thursday's ${job} bout.\n\nThe trap is modelled on a real pattern: ${pattern}.`] : []),
    `Fail of the Week (${when}): ${s}.\n\nOne refereed attempt in our weekly ${job} bout, with a verified replay.`,
    `${s} in Thursday's headline bout.\n\nFail of the Week, ${when}: the replay shows every call.`,
    ...(pattern ? [`Thursday's ${job} bout, Fail of the Week: ${s}.\n\nThe trap copies ${pattern}.`] : []),
  ];
  const attempts = sum(f.bout.map((b) => b.attempts));
  const fell = sum(f.bout.map((b) => b.fell));
  const passed = sum(f.bout.map((b) => b.passed));
  const page = `https://theagentforge.io${fotwPath(f.date)}`;
  const trapLine = f.trap.public_id && f.trap.description ? ` (${f.trap.public_id}: ${lowerFirst(f.trap.description)})` : "";
  const parts = [
    `Every Thursday each lab's flagship model gets the same everyday job in a sandbox with planted traps, and a referee checks the end state. This week's job: ${f.task.title}.`,
    `${s}${trapLine}. The referee's verdict: FAIL.`,
    ...(f.trap.pattern ? [`The trap models a real pattern: ${dropDot(f.trap.pattern)}.${f.trap.source ? ` Source: ${f.trap.source.title}.` : ""}`] : []),
    `Across the bout, ${fell} of ${attempts} attempts sprang a trap and ${passed} passed.`,
    `Replay, every call refereed: ${page}`,
    "Which part of this would your stack catch?",
  ];
  let content = parts.join("\n\n");
  // Moltbook posts run 500–1,000 characters (moltbook-strategy §2): drop the source title first if it's too long.
  if (content.length > 1000) content = content.replace(/ Source: [^\n]*\./, "");
  return {
    type: "fail-of-the-week",
    at,
    texts,
    approveOnly: true,
    image: `/og/x/arena/run/${f.run.id}.png`,
    alt: `The Agent Forge bout card stamped TRAP for ${f.run.name} in ${f.task.title}: ${f.card.sentence}. From a refereed bout on theagentforge.io.`,
    reply: `Replay, clip and the trap's source: ${page}?from=x-fail-of-the-week`,
    moltbook: { submolt: "general", title: `${s} in Thursday's weekly bout`, content },
    facts: {
      runs: [{ id: f.run.id, model: f.run.model, fell: true, passed: false }],
      // The template sentence's own numbers ("over $150") are on the page too, in the same sentence.
      numbers: [attempts, fell, passed, ...(s.replace(f.run.name, "").match(/\d[\d,]*(\.\d+)?/g) ?? []).map((n) => Number(n.replace(/,/g, "")))],
      // Catalogue strings shown on the page as they are (trap id, description, pattern, source title), so their digits
      // ("30-day", "11 Sep 2024") aren't read as claims.
      names: [f.run.name, f.task.title, job, ...[f.trap.public_id, f.trap.description, f.trap.description && lowerFirst(f.trap.description), f.trap.pattern && dropDot(f.trap.pattern), f.trap.source?.title].filter((x): x is string => !!x)],
      sources: [`${fotwPath(f.date)}?format=json`, `/arena/run/${f.run.id}.json`],
    },
  };
}

const BUILDERS: Record<PostType, (env: Env, db: Db, now: number, at: string) => Promise<Draft | null>> = {
  "trap-of-the-day": trapOfTheDay,
  "catch-card": catchCard,
  clip,
  "board-change": boardChange,
  "skill-watch": skillWatch,
  poll,
  "trap-card-tip": trapCardTip,
  "bout-teaser": boutTeaser,
  "bout-result": boutResult,
  recap,
  milestone: async (env, db, now, at) => (MILESTONE_POSTS ? milestone(env, db, now, at) : null),
  "fail-of-the-week": failOfTheWeekDraft,
};

/**
 * The weekly learning report (§9.9) may move one slot a week from the weakest type to the strongest. The bout cycle
 * (poll, teaser, result, recap) is never moved, and only types with fresh material every day can take an extra slot.
 */
export const SWAP_FROM: PostType[] = ["trap-of-the-day", "catch-card", "clip", "board-change", "skill-watch", "trap-card-tip"];
export const SWAP_TO: PostType[] = ["trap-of-the-day", "catch-card", "clip", "trap-card-tip"];
export type Swap = { from: PostType; to: PostType };

/** "skill-watch,clip" → a swap, or null for anything else. */
export function parseSwap(v: string | undefined | null): Swap | null {
  const [from, to] = (v ?? "").split(",") as [PostType, PostType];
  return from && to && from !== to && SWAP_FROM.includes(from) && SWAP_TO.includes(to) ? { from, to } : null;
}

/** Drafts for every slot on a US Eastern date. A type with no fitting data that day is left out, never padded. */
export async function draftsFor(env: Env, db: Db, date: string, now = Date.now(), swap: Swap | null = null, opts: { milestones?: boolean } = {}): Promise<Draft[]> {
  const out: Draft[] = [];
  const mslot = (opts.milestones ?? MILESTONE_POSTS) ? MILESTONE_SLOTS[new Date(`${date}T12:00:00Z`).getUTCDay()] : undefined;
  const m = mslot ? await milestone(env, db, now, new Date(easternToUtc(date, mslot.hour)).toISOString()).catch(() => null) : null;
  if (m) out.push({ ...m, texts: m.texts.map((x) => x.replace(/\n{3,}/g, "\n\n").trim()).filter((x) => x.length <= 275) });
  for (const s of slotsOn(date)) {
    if (m && s.type === mslot?.replaces) continue;
    const type = swap && s.type === swap.from ? swap.to : s.type;
    if (out.some((d) => d.type === type)) continue;
    const d = await BUILDERS[type](env, db, now, s.at).catch(() => null);
    if (d) out.push({ ...d, texts: d.texts.map((x) => x.replace(/\n{3,}/g, "\n\n").trim()).filter((x) => x.length <= 275) });
  }
  return out.filter((d) => d.texts.length);
}

export const TYPES = Object.keys(BUILDERS) as PostType[];

/** A Gauntlet clip ready to go up as a YouTube Short (§9.7): title, description and file, from templates only. */
export interface Short {
  clip: string;
  video: string;
  title: string;
  description: string;
  runs: string[];
}

/** YouTube's title limit. */
export const SHORT_TITLE_MAX = 100;

/** Every published Gauntlet clip of today's duels where one side fell and the other didn't, best-known models first. */
export async function shortsFor(env: Env, db: Db, now = Date.now()): Promise<Short[]> {
  const index = await clipIndex(env).catch(() => ({ clips: [] as string[], removed: [] as string[] }));
  const out: Short[] = [];
  for (const d of await contrastDuels(env, db, now)) {
    const clip = gauntletClipId(d.a.id, d.b.id);
    if (!index.clips.includes(clip) || out.some((s) => s.clip === clip)) continue;
    const { faller, catcher } = sides(d);
    const long = `${d.a.name} vs ${d.b.name}: who falls for the hidden trap?`;
    const title = long.length <= SHORT_TITLE_MAX ? long : `Which AI falls for the hidden trap? ${bare(d.title)}`.slice(0, SHORT_TITLE_MAX);
    const description = [
      `${job(d)}`,
      `${catcher.name} caught the trap. ${faller.name} fell for it. ${label(d)}, ${d.title}.`,
      `Replay every step: https://theagentforge.io/arena/run/${faller.id}?from=yt-short`,
      "Recorded from a real refereed bout on The Agent Forge. Nothing the models wrote is shown.",
    ].join("\n\n");
    out.push({ clip, video: `${clip}.mp4`, title, description, runs: [d.a.id, d.b.id] });
  }
  return out;
}
