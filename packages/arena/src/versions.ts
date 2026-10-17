import { HARD3_TASKS, HARD_TASKS, TASKS } from "./tasks/index";
import type { TaskVersion } from "./traps";

// Versions every Arena result runs under (ADR 0023 §5): the rules (referee, harness and scoring) and the task set.
// A result's rules version comes from its finish date and the history below; its task version from the task id.

/** The rules in force now. A change to the referee, harness, caps or scoring bumps it, with a changelog entry. */
export const RULES_VERSION = "rules 0.3";

export const RULES_HISTORY: { version: string; date: string; change: string }[] = [
  { version: "rules 0.1", date: "2026-10-15", change: "Season 0 rules: the referee scores the sandbox's end state and the call log, never the model's claims; every log is signed; seeded variants; 3 attempts per variant; fixed caps and official weights (ADR 0013, ADR 0014)." },
  { version: "rules 0.2", date: "2026-10-16", change: "The Hard tier (ADR 0021): each Hard job has its own stamina caps, Hard results are kept apart from Normal ones, and every result says whether a model got the same variant right on all 3 attempts." },
  { version: "rules 0.3", date: "2026-10-17", change: "A read-only calculator on every Hard v3 job, with 20% more turns and tool calls for it (ADR 0021 amendment 4). Resumable bouts: a bout still running at the runner's deadline, or hit by a provider rate limit, is paused and resumed, never voided (ADR 0022)." },
];

/** The task versions, with the date each was published and its jobs. */
export const TASK_VERSIONS: { version: TaskVersion; date: string; tasks: string[]; change: string }[] = [
  { version: "Normal 1.0", date: "2026-10-15", tasks: TASKS.map((t) => t.id), change: "Six everyday jobs (refund, scam invoice, weekend planner, spreadsheet rescue, flaky supplier, impossible ask), each with planted traps named in advance." },
  { version: "Hard v2", date: "2026-10-16", tasks: HARD_TASKS.map((t) => t.id), change: "The same six jobs at volume, with the deciding fact spread across many reads (ADR 0021 amendment 1). Hard v1, the same day, was calibration only and was replaced by v2 before any result was shown." },
  { version: "Hard v3", date: "2026-10-17", tasks: HARD3_TASKS.map((t) => t.id), change: "Longer, realistic workloads of the six jobs, with a calculator tool on each (ADR 0021 amendments 3 and 4)." },
];

/** The task version a task id belongs to. */
export const taskVersion = (task: string): TaskVersion => TASK_VERSIONS.find((v) => v.tasks.includes(task))?.version ?? "Normal 1.0";

/** The rules version in force when a result finished (UTC date). */
export function rulesVersionAt(finishedAt: number) {
  const day = new Date(finishedAt).toISOString().slice(0, 10);
  return [...RULES_HISTORY].reverse().find((r) => r.date <= day)?.version ?? RULES_HISTORY[0]!.version;
}

/** "Rules 0.3 · Hard v3": the line every result shows. */
export const versionLine = (task: string, finishedAt: number) => {
  const rules = rulesVersionAt(finishedAt);
  return `${rules[0]!.toUpperCase()}${rules.slice(1)} · ${taskVersion(task)}`;
};

/** The dated changelog shown on /arena/methodology: task versions, rules versions and the catalog itself. */
export const CHANGELOG: { date: string; version: string; change: string }[] = [
  ...TASK_VERSIONS.map((v) => ({ date: v.date, version: v.version, change: v.change })),
  ...RULES_HISTORY.map((r) => ({ date: r.date, version: r.version, change: r.change })),
  { date: "2026-10-17", version: "catalog 1", change: "Trap catalog published: every trap has a stable public ID (FA-<family>-<number>), a provenance line and the version it entered (ADR 0023 §5)." },
].sort((a, b) => a.date.localeCompare(b.date));

/** How to cite the Arena (ADR 0023 §5): title, version, date, URL, a plain line and BibTeX. */
export function citation(origin: string) {
  const url = `${origin.replace(/\/$/, "")}/arena/methodology`;
  const date = [...RULES_HISTORY, ...TASK_VERSIONS].map((x) => x.date).sort().at(-1)!;
  const tasks = TASK_VERSIONS.map((v) => v.version).join(", ");
  const version = `${RULES_VERSION}; tasks ${tasks}`;
  const [y, m, d] = date.split("-");
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return {
    title: "The Forge Arena",
    author: "The Agent Forge",
    version,
    date,
    url,
    text: `The Agent Forge (${y}). The Forge Arena: methodology and trap catalog (${version}). ${Number(d)} ${months[Number(m) - 1]![0]!.toUpperCase()}${months[Number(m) - 1]!.slice(1)} ${y}. ${url}`,
    bibtex: `@misc{forgearena${y},
  title        = {The Forge Arena: methodology and trap catalog},
  author       = {{The Agent Forge}},
  year         = {${y}},
  month        = ${months[Number(m) - 1]},
  version      = {${version}},
  date         = {${date}},
  howpublished = {\\url{${url}}},
  url          = {${url}}
}`,
  };
}
