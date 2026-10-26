import { HARD3_TASKS, HARD_TASKS, taskById, TASKS, wilsonInterval } from "@forge/arena";
import type { Db } from "../services/db";
import { modelRow, RESULTS_METHOD, trapsFell, versionsAndDates, type Run } from "./results";
import { finishedRuns, isKnockout, RANKED_KINDS, tierOf, type Tier } from "./views";

// Answer pages for the Arena's everyday jobs (citations issue #234): one page per job, phrased as the question a person
// asks an AI assistant ("Which AI models fall for fake invoices?"), answered from refereed ranked runs only. Runs come
// through `finishedRuns`, so embargoed models (ADR 0041), events held for review, practice and Lab #3 arms never count.
// Wording is neutral: models "passed" or "fell for" something the referee recorded; nothing here calls a model safe.

export interface ArenaQuestion {
  slug: string;
  question: string;
  /** The Normal task id; its Hard v2 and Hard v3 versions are `<job>-hard` and `<job>-hard3`. */
  job: string;
  /**
   * Public trap ids (FA-*) that count as "did it" on this page, or null for any planted trap on the job. The table
   * still lists every trap id fallen for.
   */
  focus: string[] | null;
  /** What the referee recorded, in the past tense: "fell for a fake or redirected invoice". */
  did: string;
  /** The table column for `did`, a short phrase: "Fell for a fake invoice". */
  column: string;
  /** Whether the answer leads with which models did it, or with which passed most often. */
  lead: "fell" | "passed";
}

export const ANSWERS_PATH = "/answers";

/** The fixed questions, in page order. Slugs never change once published (they're cited). */
export const ARENA_QUESTIONS: ArenaQuestion[] = [
  { slug: "which-ai-models-fall-for-fake-invoices", question: "Which AI models fall for fake invoices?", job: "scam-invoice", focus: ["FA-PAY-001", "FA-PAY-002", "FA-INJ-001"], did: "fell for a fake or redirected invoice", column: "Fell for a fake invoice", lead: "fell" },
  { slug: "which-ai-model-can-be-trusted-with-refunds", question: "Which AI model can be trusted with refunds?", job: "refund", focus: null, did: "fell for a planted refund trap", column: "Fell for a trap", lead: "passed" },
  { slug: "which-ai-models-break-the-rules-booking-travel", question: "Which AI models break the rules when booking travel?", job: "weekend", focus: null, did: "fell for a planted booking trap", column: "Fell for a trap", lead: "fell" },
  { slug: "which-ai-models-delete-real-data-cleaning-spreadsheets", question: "Which AI models delete real records when cleaning up a spreadsheet?", job: "spreadsheet", focus: ["FA-DAT-001", "FA-DAT-002", "FA-DAT-003"], did: "deleted or merged a record that had to stay", column: "Lost a real record", lead: "fell" },
  { slug: "which-ai-models-order-twice-when-restocking", question: "Which AI models order stock twice when a supplier times out?", job: "flaky-supplier", focus: ["FA-DUP-001"], did: "ordered the same items twice", column: "Ordered twice", lead: "fell" },
  { slug: "will-an-ai-agent-lie-that-a-payment-went-through", question: "Will an AI agent lie that a payment went through?", job: "impossible", focus: ["FA-CLM-001"], did: "told a payee the money was sent when it wasn't", column: "Said it was sent", lead: "fell" },
];

export const answerPagePath = (q: ArenaQuestion) => `${ANSWERS_PATH}/${q.slug}`;
export const arenaQuestion = (slug: string) => ARENA_QUESTIONS.find((q) => q.slug === slug) ?? null;
/** The answer page for a task id (any tier), for links from the task guides. */
export const questionForTask = (task: string) => ARENA_QUESTIONS.find((q) => q.job === task.replace(/-hard3?$/, "")) ?? null;

/** A job's versions, newest and hardest first: the answer leads with the first one that has ranked results. */
const versionsOf = (job: string) =>
  [
    { task: HARD3_TASKS.find((x) => x.id === `${job}-hard3`), version: "Hard v3" as const },
    { task: HARD_TASKS.find((x) => x.id === `${job}-hard`), version: "Hard v2" as const },
    { task: TASKS.find((x) => x.id === job), version: "Normal" as const },
  ].filter((v): v is { task: NonNullable<typeof v.task>; version: "Hard v3" | "Hard v2" | "Normal" } => !!v.task);

const pctOf = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : 0);

/** One model's row: the Arena results row plus how many attempts did the page's thing. */
function answerRow(q: ArenaQuestion, model: string, rs: Run[], origin: string) {
  const row = modelRow(model, rs, origin);
  const did = rs.filter((r) => {
    const fell = trapsFell(r.summary.task, r.result);
    return q.focus ? fell.some((id) => q.focus!.includes(id)) : fell.length > 0;
  }).length;
  return { ...row, attempts: rs.length, did, did_ci_95: wilsonInterval(did, rs.length) };
}

export type AnswerRow = ReturnType<typeof answerRow>;

/** Every version of the job with ranked results, each with its models (most passes per attempt first). */
export async function arenaAnswer(db: Db, q: ArenaQuestion, origin = "") {
  const sections = (
    await Promise.all(
      versionsOf(q.job).map(async ({ task, version }) => {
        const runs = await finishedRuns(db, { kinds: RANKED_KINDS, task: task.id });
        if (!runs.length) return null;
        const by = new Map<string, Run[]>();
        for (const r of runs) by.set(r.summary.model, [...(by.get(r.summary.model) ?? []), r]);
        const models = [...by.entries()]
          .map(([model, rs]) => answerRow(q, model, rs, origin))
          .sort((a, b) => pctOf(b.passes, b.attempts) - pctOf(a.passes, a.attempts) || a.did - b.did || a.name.localeCompare(b.name));
        const events = new Map<string, string>();
        for (const r of runs) events.set(r.summary.event, r.summary.eventName);
        return {
          task: task.id,
          title: task.title,
          tier: tierOf(task.id) as Tier,
          version,
          attempts: runs.length,
          knockouts: runs.filter((r) => isKnockout(r.result)).length,
          last: Math.max(...runs.map((r) => r.summary.finishedAt)),
          ...versionsAndDates(runs),
          events: [...events].map(([slug, name]) => ({ slug, name, page: `${origin}/arena/event/${slug}`, json: `${origin}/arena/events/${slug}.json`, csv: `${origin}/arena/events/${slug}.csv` })),
          guide_url: `${origin}/best/${task.id}`,
          models,
        };
      }),
    )
  ).filter((s): s is NonNullable<typeof s> => !!s);
  const last = sections.length ? Math.max(...sections.map((s) => s.last)) : null;
  return {
    question: q.question,
    slug: q.slug,
    url: `${origin}${answerPagePath(q)}`,
    job: q.job,
    focus_traps: q.focus,
    date_modified: last ? new Date(last).toISOString() : null,
    attempts: sections.reduce((a, s) => a + s.attempts, 0),
    method: { ...RESULTS_METHOD, counted: "ranked_card_and_guest_events_only", did: q.focus ? "focus_trap_marked_triggered_by_referee" : "any_trap_marked_triggered_by_referee" },
    sections,
  };
}

export type ArenaAnswer = Awaited<ReturnType<typeof arenaAnswer>>;
export type AnswerSection = ArenaAnswer["sections"][number];

const n = (x: number) => x.toLocaleString("en-US");
const models = (k: number) => `${n(k)} ${k === 1 ? "model" : "models"}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "A, B and C". */
export const listText = (xs: string[]) => (xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** One sentence about one version of the job, starting with its date and sample size. */
export function sectionSentence(q: ArenaQuestion, s: AnswerSection, lead = q.lead): string {
  const m = s.models.length;
  const head = `As of ${s.as_of}, in ${n(s.attempts)} refereed ${s.attempts === 1 ? "attempt" : "attempts"} by ${models(m)} on ${s.title}`;
  const fell = s.models.filter((r) => r.did > 0).sort((a, b) => pctOf(b.did, b.attempts) - pctOf(a.did, a.attempts) || a.name.localeCompare(b.name));
  const shown = fell.slice(0, 5).map((r) => `${r.name} (${r.did} of ${r.attempts})`);
  const fellList = fell.length > 5 ? `${shown.join(", ")} and ${models(fell.length - 5)} more` : listText(shown);
  const fellClause = fell.length ? `${fell.length} of ${models(m)} ${q.did} at least once: ${fellList}` : m === 1 ? `the model never ${q.did}` : `none of the ${models(m)} ${q.did}`;
  if (lead === "fell") return `${head}, ${fellClause}.`;
  const best = pctOf(s.models[0]!.passes, s.models[0]!.attempts);
  const top = s.models.filter((r) => pctOf(r.passes, r.attempts) === best);
  const t0 = top[0]!;
  const passed =
    best === 0
      ? "no model passed"
      : top.length === 1
        ? `${t0.name} passed most often (${t0.passes} of ${t0.attempts} attempts, 95% interval ${pct(t0.ci_95[0])}–${pct(t0.ci_95[1])})`
        : top.length <= 3
          ? `${listText(top.map((r) => `${r.name} (${r.passes} of ${r.attempts})`))} passed most often`
          : `${top.length} models tied for the most passes (${pct(best)} of their attempts)`;
  return `${head}, ${passed}; ${fell.length ? `${fell.length} of ${models(m)} ${q.did} at least once` : `none of them ${q.did}`}.`;
}

/** The answer paragraph: the lead version first (date and sample size in its first sentence), then the others. */
export function answerSentences(q: ArenaQuestion, a: ArenaAnswer): string {
  if (!a.sections.length) return `No ranked, refereed attempts on this job have been published yet, so the Forge has no answer to "${q.question}" from its own data.`;
  return a.sections.map((s) => sectionSentence(q, s)).join(" ");
}

/** The job's name without its tier: "The Scam Invoice". */
export const jobTitle = (q: ArenaQuestion) => taskById(q.job)?.title ?? q.job;
