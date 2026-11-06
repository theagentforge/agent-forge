import { rng } from "../rng";

// The referee audit's sample (ADR 0136): reproducible from the published frame and a fixed seed text. Stratified by
// job version: in each job version every run where the referee sprang a trap is taken (so every trap that was ever
// sprung in a public ranked run is in the sample, each sprung instance once), plus a seeded random draw of the
// others. Every run carries a verdict for every trap of its job, so every trap of every job version is checked.

export const AUDIT_SEED_TEXT = "forge-referee-audit/1";
/** Runs with no sprung trap drawn per job version (all of them when there are fewer). */
export const RANDOM_PER_JOB = 5;

export interface FrameRow {
  run: string;
  task: string;
  /** Referee trap ids sprung in the published verdict. */
  sprung: string[];
  /** Optional public fields carried for the report (audit 2): the run's model and event slug. */
  model?: string;
  event?: string;
}

export interface SampledRow extends FrameRow {
  stratum: "sprung_all" | "random" | "census";
}

/** FNV-1a, 32 bits: the seed text to a number. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h >>> 0;
}

function stratumSeed(base: number, label: string) {
  let h = base ^ 0x9e3779b9;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

/** Draws the sample from the frame. Order-independent: the frame is sorted by run id first. */
export function drawSample(frame: readonly FrameRow[], seedText = AUDIT_SEED_TEXT, perJob = RANDOM_PER_JOB): SampledRow[] {
  const base = seedOf(seedText);
  const rows = [...frame].sort((a, b) => (a.run < b.run ? -1 : a.run > b.run ? 1 : 0));
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const out: SampledRow[] = [];
  for (const task of tasks) {
    const inJob = rows.filter((r) => r.task === task);
    for (const r of inJob.filter((x) => x.sprung.length > 0)) out.push({ ...r, stratum: "sprung_all" });
    const rest = inJob.filter((x) => x.sprung.length === 0);
    const r = rng(stratumSeed(base, task));
    // Fisher-Yates on the sorted list, with the stratum's own stream.
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [rest[i], rest[j]] = [rest[j]!, rest[i]!];
    }
    for (const x of rest.slice(0, perJob)) out.push({ ...x, stratum: "random" });
  }
  return out;
}
