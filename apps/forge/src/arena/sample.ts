import { CANARY, CANARY_GUID, checkReplay, familyOf, isAnyHeldOutSeed, KEYS_PATH, taskVersion, publicTrapId, refereeCheck, TRAP_FAMILIES, type AttemptResult, type KeySet, type LogEvent, type TrapFamily } from "@forge/arena";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import * as t from "../db/schema";
import { getDb } from "../services/db";
import { COMMERCIAL_LICENCE_LINE, DATASET_LICENCE, LICENCE_ID, LICENCE_PATH, modelProvenance } from "../services/provenance";
import { keySet, sha256Hex } from "../services/replay-keys";
import { zipStore } from "../services/zip";
import { verifyCommand } from "../web/replay-verify";
import { CROISSANT_CONTEXT } from "../web/croissant";
import { costOfFailure, modelResults, SAFE, TRAP_SET, TRAP_SET_NAME, trapSetEntries } from "./benchmark";
import { modelById } from "./lineup";
import { runDocument } from "./run-doc";
import { rulesFields } from "./rules-label";
import { finishedRuns, runWithLog, tierOf } from "./views";

// B3-07 (build plan 29 Oct, Boardy's spec; ADR 0100): the public sample dataset, a small fixed zip a buyer's engineers can
// open in five minutes. Records come only from bouts /arena/dataset.json already publishes (embargoed models, private
// families, held-out seeds, lab arms and held events are left out by the same filter), under rules 0.5 or 0.6, picked by
// a published seeded random draw within strata, never by hand. Built once per version on the Worker (an admin clicks
// Build on /admin/dataset-sample) and stored write-once in Workers KV: the bytes and checksum never change after that.

export const SAMPLE_VERSION = "v1";
export const SAMPLE_NAME = `forge-trap-sample-${SAMPLE_VERSION}`;
export const SAMPLE_DIR = "/dataset/sample";
export const SAMPLE_ZIP_PATH = `${SAMPLE_DIR}/${SAMPLE_NAME}.zip`;
export const SAMPLE_SCHEMA_PATH = `${SAMPLE_DIR}/schema.json`;
export const SAMPLE_INDEX_PATH = `${SAMPLE_DIR}/index.json`;
/** Each file of the zip, unzipped: `${SAMPLE_FILES_PATH}/<name>`. */
export const SAMPLE_FILES_PATH = `${SAMPLE_DIR}/${SAMPLE_VERSION}`;
export const SAMPLE_ADMIN_PATH = "/admin/dataset-sample";
/** The published random seed of the draw (the build plan's date). */
export const SAMPLE_SEED = 20261029;
/** Rules versions a record may come from (native runs only; a re-scored group is its own version and is left out). */
export const SAMPLE_RULES = ["rules 0.5", "rules 0.6"] as const;
export const SAMPLE_LIMITS = { min: 20, target: 40, max: 50, minFailsPerKind: 2, maxPerFamily: 6, minModels: 3, replayTries: 40 } as const;
export const SAMPLE_FORMAT = "forge-sample/1";
export const SAMPLE_KV = { zip: `dataset:sample:${SAMPLE_VERSION}:zip`, meta: `dataset:sample:${SAMPLE_VERSION}:meta` } as const;
/** B3-02 (Dinike, 29 Oct): the commercial-licence line, word for word (one definition, in services/provenance.ts). */
export { COMMERCIAL_LICENCE_LINE } from "../services/provenance";
/** What the public never gets from this sample (and the full set keeps back). */
export const SAMPLE_WITHHELD = ["held-out seeds and their runs", "private trap families (FA-*-101 and up) and their jobs", "the trap generator", "embargoed models and events held for review"] as const;

/** One record: one public trap present in one public bout, and whether the model fell for it. */
export interface SampleRecord {
  record_id: string;
  trap_id: string;
  trap_version: string;
  trap_kind: { family: string; name: string };
  ruleset_version: string;
  job: string;
  task: string;
  task_version: string;
  tier: "normal" | "hard";
  event_kind: "card" | "guest" | "practice";
  ranked: boolean;
  model: string;
  model_version: string | null;
  provider: string | null;
  maker: string | null;
  frontier: boolean;
  run_date: string;
  seed: number;
  attempt: number;
  tool_calls: { name: string; arguments: Record<string, unknown> }[];
  verdict: "pass" | "fail";
  failure_category: string | null;
  bout_passed: boolean;
  expected_safe_behaviour: string;
  cost_of_failure: { low: number | null; high: number | null; unit: string; basis: string };
  replay_id: string;
  replay_url: string;
  canary_guid: string;
}

export interface SampleFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface SampleMeta {
  format: typeof SAMPLE_FORMAT;
  name: string;
  version: string;
  built_at: string;
  seed: number;
  zip: SampleFile & { url: string };
  files: SampleFile[];
  counts: { records: number; falls: number; passes: number; models: number; trap_kinds: number; candidates: number };
  pair: { task: string; seed: number; trap_id: string; pass: string; fail: string };
  replays: string[];
  licence_id: string;
  canary_guid: string;
}

// --- The seeded draw ------------------------------------------------------------------------------------------------

/** mulberry32: a small, published PRNG, so anyone can repeat the draw from the seed. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A candidate record before its log is read. */
export interface Candidate {
  run: string;
  trap: string;
  family: TrapFamily;
  task: string;
  seed: number;
  model: string;
  fell: boolean;
  boutPassed: boolean;
  sealed: boolean;
  rules: string;
  frontier: boolean;
}

const key = (c: Candidate) => `${c.run}\u0000${c.trap}`;
const byKey = (a: Candidate, b: Candidate) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

export interface Draw {
  picked: Candidate[];
  pair: { pass: Candidate; fail: Candidate };
}

/**
 * The draw (ADR 0100), deterministic from the candidates and the seed:
 * 1. the same-seed pair: a (job, seed, trap) with a fall and a clean pass (the pass's bout passed), both sealed with
 *    replay format v2 under rules 0.6; groups tried in seeded order until `replayOk` accepts both replays;
 * 2. a frontier fall: a Heavyweight model shown on /benchmark falling for a trap, if the pair didn't give one;
 * 3. at least `minFailsPerKind` falls of every trap kind that has them;
 * 4. filled round-robin over trap kinds, one seeded pick a turn, to `target`, never more than `maxPerFamily` a kind.
 */
export async function draw(all: Candidate[], seed: number, replayOk: (c: Candidate) => Promise<boolean>, L = SAMPLE_LIMITS): Promise<Draw | { error: string }> {
  const rng = mulberry32(seed);
  const pickFrom = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)]!;
  const pool = [...all].sort(byKey);
  const picked: Candidate[] = [];
  const taken = new Set<string>();
  const count = (f: TrapFamily, fell?: boolean) => picked.filter((p) => p.family === f && (fell === undefined || p.fell === fell)).length;
  const take = (c: Candidate) => {
    picked.push(c);
    taken.add(key(c));
  };

  // 1. The same-seed pair.
  const groups = new Map<string, Candidate[]>();
  for (const c of pool.filter((c) => c.sealed && c.rules === "rules 0.6")) {
    const g = `${c.task}\u0000${c.seed}\u0000${c.trap}`;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const eligible = [...groups.entries()].filter(([, cs]) => cs.some((c) => c.fell) && cs.some((c) => !c.fell && c.boutPassed)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let pair: Draw["pair"] | null = null;
  const verdicts = new Map<string, boolean>();
  const ok = async (c: Candidate) => {
    if (!verdicts.has(c.run)) verdicts.set(c.run, await replayOk(c));
    return verdicts.get(c.run)!;
  };
  for (let tries = 0; eligible.length && tries < L.replayTries && !pair; tries++) {
    const [, cs] = eligible.splice(Math.floor(rng() * eligible.length), 1)[0]!;
    const fails = cs.filter((c) => c.fell);
    const passes = cs.filter((c) => !c.fell && c.boutPassed);
    const fail = pickFrom(fails);
    const pass = pickFrom(passes);
    if ((await ok(fail)) && (await ok(pass))) pair = { pass, fail };
  }
  if (!pair) return { error: "No job, seed and trap yet has both a fall and a clean pass with verifiable replay format v2 bouts under rules 0.6." };
  take(pair.fail);
  take(pair.pass);

  // 2. A frontier fall.
  if (!picked.some((p) => p.fell && p.frontier)) {
    const frontier = pool.filter((c) => c.fell && c.frontier && !taken.has(key(c)) && count(c.family) < L.maxPerFamily);
    if (!frontier.length) return { error: "No public fall by a frontier model shown on /benchmark." };
    take(pickFrom(frontier));
  }

  // 3. Falls of every kind.
  const families = (Object.keys(TRAP_FAMILIES) as TrapFamily[]).filter((f) => pool.some((c) => c.family === f));
  for (const f of families)
    while (count(f, true) < L.minFailsPerKind && count(f) < L.maxPerFamily) {
      const left = pool.filter((c) => c.family === f && c.fell && !taken.has(key(c)));
      if (!left.length) break;
      take(pickFrom(left));
    }

  // 4. Fill.
  for (let added = true; added && picked.length < L.target; ) {
    added = false;
    for (const f of families) {
      if (picked.length >= L.target || count(f) >= L.maxPerFamily) continue;
      const left = pool.filter((c) => c.family === f && !taken.has(key(c)));
      if (!left.length) continue;
      take(pickFrom(left));
      added = true;
    }
  }
  if (picked.length < L.min) return { error: `Only ${picked.length} records could be drawn (at least ${L.min} needed).` };
  if (new Set(picked.map((p) => p.model)).size < L.minModels) return { error: `Fewer than ${L.minModels} models in the draw.` };
  return { picked, pair };
}

// --- Reading the public bouts -------------------------------------------------------------------------------------

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every candidate record: public trap set traps, in finished (not knocked-out) public bouts under rules 0.5 or 0.6. */
export async function candidates(env: Env, now: number): Promise<Candidate[]> {
  const db = getDb(env);
  // The same rows /arena/dataset.json publishes (both tiers, practice and ranked, no lab arms).
  const runs = await finishedRuns(db, { hard: true, now });
  const sealed = new Set((await db.select({ id: t.arenaRuns.id }).from(t.arenaRuns).where(and(eq(t.arenaRuns.status, "done"), isNotNull(t.arenaRuns.replaySeal)))).map((r) => r.id));
  const shown = new Set((await modelResults(db)).models.map((m) => m.model));
  const ids = new Map(trapSetEntries().map((e) => [e.id, e] as const));
  const out: Candidate[] = [];
  for (const r of runs) {
    const s = r.summary;
    const res = r.result as AttemptResult | null;
    if (!res || res.reason !== "finished" || s.finishedAt > now || isAnyHeldOutSeed(s.seed)) continue;
    const rules = rulesFields(s.finishedAt, res).rules_version;
    if (!(SAMPLE_RULES as readonly string[]).includes(rules)) continue;
    const frontier = modelById(s.model)?.division === "heavyweight" && shown.has(s.model);
    const seen = new Map<string, boolean>();
    for (const tr of res.traps ?? []) {
      const pid = publicTrapId(s.task, tr.id);
      if (pid && ids.has(pid)) seen.set(pid, (seen.get(pid) ?? false) || tr.triggered);
    }
    for (const [pid, fell] of seen)
      out.push({ run: s.id, trap: pid, family: ids.get(pid)!.family as TrapFamily, task: s.task, seed: s.seed, model: s.model, fell, boutPassed: s.passed, sealed: sealed.has(s.id), rules, frontier });
  }
  return out;
}

/** A replay accepted for the sample: what `forge verify` calls VERIFIED (chain, record, signature, same referee verdict). */
export async function replayVerifies(env: Env, doc: unknown) {
  const ks: KeySet = await keySet(env);
  const enc = new TextEncoder();
  const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
  const c = await checkReplay(doc, sha256Hex, async (kid, message, signature) => {
    const k = ks.keys.find((x) => x.kid === kid);
    if (!k) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x }, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, unb64(signature.replace(/^ed25519:/, "")), enc.encode(message));
  });
  const ref = refereeCheck(doc);
  return c.format === 2 && c.chain === "ok" && c.record === "ok" && c.signature === "ok" && ref.checked && ref.same_verdict === true && ref.faithful === true && ref.rules_of_run === ref.rules_here;
}

// --- The files ----------------------------------------------------------------------------------------------------

const costs = new Map<string, ReturnType<typeof costOfFailure>>();
const costOf = (id: string) => {
  if (!costs.has(id)) costs.set(id, costOfFailure(trapSetEntries().find((e) => e.id === id)!));
  return costs.get(id)!;
};

export function sampleRecord(origin: string, c: Candidate, run: { modelId: string; provider: string | null; finishedAt: number | null; attemptNo: number; result: unknown }, log: LogEvent[], kind: SampleRecord["event_kind"]): SampleRecord {
  const cof = costOf(c.trap);
  const prov = modelProvenance(run.modelId, run.provider);
  return {
    record_id: `${c.run}:${c.trap}`,
    trap_id: c.trap,
    trap_version: TRAP_SET.version,
    trap_kind: { family: c.family, name: TRAP_FAMILIES[c.family].name },
    ruleset_version: c.rules,
    job: familyOf(c.task),
    task: c.task,
    task_version: taskVersion(c.task, run.finishedAt!),
    tier: tierOf(c.task),
    event_kind: kind,
    ranked: kind !== "practice",
    model: run.modelId,
    model_version: prov.exact,
    provider: prov.served_by,
    maker: prov.maker,
    frontier: c.frontier,
    run_date: day(run.finishedAt!),
    seed: c.seed,
    attempt: run.attemptNo,
    tool_calls: log.filter((e): e is Extract<LogEvent, { type: "call" }> => e.type === "call").map((e) => ({ name: e.name, arguments: e.args })),
    verdict: c.fell ? "fail" : "pass",
    failure_category: c.fell ? TRAP_FAMILIES[c.family].name : null,
    bout_passed: c.boutPassed,
    expected_safe_behaviour: SAFE[c.trap]!,
    cost_of_failure: { low: cof.min, high: cof.max, unit: cof.unit, basis: cof.basis },
    replay_id: c.run,
    replay_url: `${origin}/arena/run/${c.run}.json`,
    canary_guid: CANARY_GUID,
  };
}

/** JSON Schema (2020-12) for one line of sample.jsonl, published at SAMPLE_SCHEMA_PATH. Fixed for v1. */
export function sampleSchema(origin: string) {
  const str = { type: "string", minLength: 1 };
  const strOrNull = { type: ["string", "null"] };
  const intOrNull = { type: ["integer", "null"], minimum: 0 };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${origin}${SAMPLE_SCHEMA_PATH}`,
    title: `${TRAP_SET_NAME} sample ${SAMPLE_VERSION}: one record`,
    description: "One public trap present in one public Arena bout, and whether the model fell for it.",
    type: "object",
    additionalProperties: false,
    required: [
      "record_id", "trap_id", "trap_version", "trap_kind", "ruleset_version", "job", "task", "task_version", "tier", "event_kind", "ranked", "model", "model_version", "provider", "maker", "frontier",
      "run_date", "seed", "attempt", "tool_calls", "verdict", "failure_category", "bout_passed", "expected_safe_behaviour", "cost_of_failure", "replay_id", "replay_url", "canary_guid",
    ],
    properties: {
      record_id: str,
      trap_id: { type: "string", pattern: "^FA-(PAY|INJ|DUP|POL|AMT|CLM|DAT|TIM|PRM)-0\\d{2}$" },
      trap_version: str,
      trap_kind: { type: "object", additionalProperties: false, required: ["family", "name"], properties: { family: { enum: Object.keys(TRAP_FAMILIES) }, name: str } },
      ruleset_version: { enum: [...SAMPLE_RULES] },
      job: str,
      task: str,
      task_version: str,
      tier: { enum: ["normal", "hard"] },
      event_kind: { enum: ["card", "guest", "practice"] },
      ranked: { type: "boolean" },
      model: str,
      model_version: strOrNull,
      provider: strOrNull,
      maker: strOrNull,
      frontier: { type: "boolean" },
      run_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      seed: { type: "integer" },
      attempt: { type: "integer", minimum: 1 },
      tool_calls: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "arguments"], properties: { name: str, arguments: { type: "object" } } } },
      verdict: { enum: ["pass", "fail"] },
      failure_category: strOrNull,
      bout_passed: { type: "boolean" },
      expected_safe_behaviour: str,
      cost_of_failure: {
        type: "object",
        additionalProperties: false,
        required: ["low", "high", "unit", "basis"],
        properties: { low: intOrNull, high: intOrNull, unit: { enum: ["usd_cents_sandbox", "records", "units", "none"] }, basis: str },
      },
      replay_id: str,
      replay_url: { type: "string", pattern: "^https?://" },
      canary_guid: { const: CANARY_GUID },
    },
  };
}

const FIELDS: [keyof SampleRecord, string][] = [
  ["record_id", "`<replay_id>:<trap_id>`, unique in the file."],
  ["trap_id", "Public trap id from the Trap Set (FA-PAY-001 and so on)."],
  ["trap_version", "Trap Set version the trap record is published under."],
  ["trap_kind", "The trap's kind: `family` code and plain `name`."],
  ["ruleset_version", "Referee and scoring rules that scored the bout (rules 0.5 or rules 0.6)."],
  ["job", "Job family (refund, scam-invoice, weekend, spreadsheet, flaky-supplier, impossible)."],
  ["task", "Exact task id (Hard tiers contain -hard)."],
  ["task_version", "Task version at the bout's finish time."],
  ["tier", "normal or hard."],
  ["event_kind", "card or guest (ranked) or practice (calibration, never ranked)."],
  ["ranked", "True for card and guest events."],
  ["model", "The Forge's lineup id of the model."],
  ["model_version", "Exact model id sent to the gateway."],
  ["provider", "Serving provider recorded for the bout."],
  ["maker", "Lab that makes the model, as named in the lineup (not an affiliation)."],
  ["frontier", "True for the lineup's Heavyweight division (each lab's everyday model) when the model is shown on /benchmark."],
  ["run_date", "UTC date the bout finished."],
  ["seed", "Seed that built the sandbox: the same seed and task give the same world."],
  ["attempt", "Attempt number on that seed."],
  ["tool_calls", "Every tool call the model made, in order: `name` and `arguments`."],
  ["verdict", "fail if the referee marked this trap sprung, pass if it was present and not sprung."],
  ["failure_category", "The trap kind's name when the verdict is fail; null on a pass."],
  ["bout_passed", "Whether the whole attempt passed (a pass on one trap can still be a failed bout)."],
  ["expected_safe_behaviour", "The end state the referee accepts for this trap (from /benchmark/v1.json)."],
  ["cost_of_failure", "Sandbox amount at stake: `low` and `high` over the published dev-split seeds, `unit` (usd_cents_sandbox is invented money in cents; records; units; none) and `basis`. Never an estimate of real losses."],
  ["replay_id", "Run id of the bout."],
  ["replay_url", "The bout's signed replay (JSON)."],
  ["canary_guid", "The benchmark canary GUID, on every record so a copied record still carries it."],
];

/** The five-line Python loader in the README (CI runs it against the test fixture's zip). */
export const PYTHON_LOADER = [
  "import json, zipfile",
  `with zipfile.ZipFile("${SAMPLE_NAME}.zip") as z:`,
  '    rows = [json.loads(line) for line in z.read("sample.jsonl").decode("utf-8").splitlines() if line]',
  'falls = [r for r in rows if r["verdict"] == "fail"]',
  'print(len(rows), "records,", len(falls), "falls")',
].join("\n");

function readme(origin: string, m: { builtAt: string; records: SampleRecord[]; replays: { id: string; verdict: string }[]; pair: Draw["pair"]; candidates: number }) {
  const falls = m.records.filter((r) => r.verdict === "fail").length;
  const kinds = [...new Set(m.records.map((r) => r.trap_kind.family))].sort();
  const models = [...new Set(m.records.map((r) => r.model))].sort();
  return `# ${TRAP_SET_NAME}: public sample ${SAMPLE_VERSION}

${CANARY}

## What it is

${m.records.length} records from The Forge Arena, where AI models do everyday business jobs (refunds, supplier payments, bookings, stock, records) in invented sandboxes with planted traps, and a referee scores the sandbox's end state and the call log, never the model's own account. Each record is one public trap present in one bout: the model's tool calls in order, whether it fell for the trap, the safe behaviour the referee accepts and the sandbox amount at stake. ${falls} records are falls and ${m.records.length - falls} are passes, across ${kinds.length} trap kinds and ${models.length} models.

Contains no personal data: tools, traps and model runs only.

Drawn from already-public bouts: every record is a bout that ${origin}/arena/dataset.json already publishes, with its signed replay at ${origin}/arena/run/<replay_id>.json. Built ${m.builtAt} from the ${m.candidates} candidate records then public.

## Files

- \`sample.jsonl\`: one record per line (schema: \`schema.json\`, also at ${origin}${SAMPLE_SCHEMA_PATH}).
- \`replays/\`: two raw signed replays, byte for byte as ${origin}/arena/run/<id>.json served them at build time: ${m.replays.map((r) => `\`${r.id}.json\` (bout ${r.verdict})`).join(" and ")}.
- \`croissant.json\`: Croissant 1.0 metadata for this sample.
- \`LICENSE.txt\`: the licence.
- \`SHA256SUMS\`: SHA-256 of every other file (\`sha256sum -c SHA256SUMS\`).

## Field dictionary (sample.jsonl)

| Field | Meaning |
|---|---|
${FIELDS.map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n")}

## How the records were picked

Not by hand. A seeded random draw within strata (ADR 0100), with seed **${SAMPLE_SEED}** and the mulberry32 generator, over every candidate record sorted by \`record_id\`:

1. Candidates: each public trap present in a public bout that finished normally (no knockout) under ${SAMPLE_RULES.join(" or ")}, on a public seed.
2. One pass and one fail on the same seed, job and trap, both bouts sealed with replay format v2 and verifiable (this sample: ${m.pair.fail.trap} on \`${m.pair.fail.task}\` seed ${m.pair.fail.seed}).
3. At least one fall by a frontier model (the lineup's Heavyweight division) already shown on ${origin}/benchmark.
4. At least ${SAMPLE_LIMITS.minFailsPerKind} falls of every trap kind that has public falls, then filled round-robin across trap kinds to ${SAMPLE_LIMITS.target} records, at most ${SAMPLE_LIMITS.maxPerFamily} from any one trap kind.

## What is withheld

${SAMPLE_WITHHELD.map((w) => `- ${w.charAt(0).toUpperCase()}${w.slice(1)}.`).join("\n")}

These stay private so the test stays clean; aggregates about them (the public-against-held-out gap) are on ${origin}/benchmark.

## Verify a replay

Each replay is hash-chained and signed with Ed25519 (public keys at ${origin}${KEYS_PATH}). Check one on your machine:

\`\`\`
${verifyCommand(`replays/${m.replays[0]!.id}.json`)}
\`\`\`

## Load it in Python

\`\`\`python
${PYTHON_LOADER}
\`\`\`

## Licence

${DATASET_LICENCE}

${COMMERCIAL_LICENCE_LINE}

Full terms: ${origin}${LICENCE_PATH}. Licence id: \`${LICENCE_ID}\`.

## More

- The sample's page: ${origin}${SAMPLE_DIR}
- The dataset spec: ${origin}/dataset
- The Trap Set: ${origin}/benchmark

Canary: ${CANARY}
`;
}

const licenceText = (origin: string) => `${TRAP_SET_NAME}: public sample ${SAMPLE_VERSION}

${DATASET_LICENCE}

${COMMERCIAL_LICENCE_LINE}

Full terms: ${origin}${LICENCE_PATH}
Licence id: ${LICENCE_ID}

${CANARY}
`;

function sampleCroissant(origin: string, builtAt: string, jsonl: { bytes: number; sha256: string }) {
  const col = (name: keyof SampleRecord | string, dataType: string, description: string) => ({
    "@type": "cr:Field",
    "@id": `records/${name}`,
    name,
    description,
    dataType,
    source: { fileObject: { "@id": "sample-jsonl" }, extract: { column: name } },
  });
  return {
    "@context": CROISSANT_CONTEXT,
    "@type": "sc:Dataset",
    conformsTo: ["http://mlcommons.org/croissant/1.0", "http://mlcommons.org/croissant/RAI/1.0"],
    name: `${TRAP_SET_NAME} sample ${SAMPLE_VERSION}`,
    description: "A fixed sample of public Arena records: one public trap in one public bout per record, with the model's tool calls, the referee's verdict on the trap, the expected safe behaviour and the sandbox cost of failure. Drawn by a seeded random pick within strata from already-public bouts.",
    url: `${origin}${SAMPLE_DIR}`,
    license: `${origin}${LICENCE_PATH}`,
    licenceText: `${DATASET_LICENCE} ${COMMERCIAL_LICENCE_LINE}`,
    creator: { "@type": "sc:Organization", name: "The Agent Forge", url: origin },
    publisher: { "@type": "sc:Organization", name: "The Agent Forge", url: origin },
    isAccessibleForFree: true,
    isLiveDataset: false,
    datePublished: builtAt.slice(0, 10),
    version: SAMPLE_VERSION.replace(/^v/, "") + ".0.0",
    keywords: ["AI agents", "evaluation", "benchmark", "tool use", "agent safety", "sample"],
    inLanguage: "en",
    "rai:dataCollection": "Each record comes from a bout The Forge ran itself (the model called through its provider's API, given the job brief and sandbox tools) and refereed from the sandbox's end state and call log.",
    "rai:dataUseCases": "Evaluation, research and reporting. Not for training or fine-tuning AI models.",
    "rai:dataLimitations": "A small sample: not for rates. Per-model rates with intervals are on /benchmark.",
    "rai:personalSensitiveInformation": "None. The sandboxes are invented: no real companies, people or money.",
    "rai:hasSyntheticData": true,
    distribution: [
      {
        "@type": "cr:FileObject",
        "@id": "sample-jsonl",
        name: "sample.jsonl",
        description: "One record per line.",
        contentUrl: "sample.jsonl",
        contentSize: `${jsonl.bytes} B`,
        encodingFormat: "application/jsonlines",
        sha256: jsonl.sha256,
      },
    ],
    recordSet: [
      {
        "@type": "cr:RecordSet",
        "@id": "records",
        name: "records",
        description: "One public trap in one public bout.",
        key: { "@id": "records/record_id" },
        field: [
          col("record_id", "sc:Text", "Unique record id."),
          col("trap_id", "sc:Text", "Public trap id."),
          col("ruleset_version", "sc:Text", "Rules that scored the bout."),
          col("job", "sc:Text", "Job family."),
          col("task", "sc:Text", "Task id."),
          col("tier", "sc:Text", "normal or hard."),
          col("model", "sc:Text", "Lineup id of the model."),
          col("model_version", "sc:Text", "Exact model id."),
          col("provider", "sc:Text", "Serving provider."),
          col("run_date", "sc:Date", "UTC date the bout finished."),
          col("seed", "sc:Integer", "Sandbox seed."),
          col("verdict", "sc:Text", "pass or fail on this trap."),
          col("failure_category", "sc:Text", "Trap kind name on a fail."),
          col("expected_safe_behaviour", "sc:Text", "End state the referee accepts."),
          col("replay_url", "sc:URL", "Signed replay of the bout."),
        ],
      },
    ],
  };
}

const enc = new TextEncoder();

export interface BuiltSample {
  zip: Uint8Array;
  meta: SampleMeta;
}

/** Builds the sample from the public bouts as of `now`. Pure read: nothing is stored. */
export async function buildSample(env: Env, now = Date.now()): Promise<BuiltSample | { error: string }> {
  const origin = env.PUBLIC_ORIGIN;
  const db = getDb(env);
  const pool = await candidates(env, now);
  const docs = new Map<string, { text: string; run: NonNullable<Awaited<ReturnType<typeof runWithLog>>> }>();
  const load = async (id: string) => {
    if (!docs.has(id)) {
      const r = await runWithLog(db, id, now);
      if (!r) throw new Error(`run ${id} is no longer public`);
      docs.set(id, { text: JSON.stringify(await runDocument(origin, r)), run: r });
    }
    return docs.get(id)!;
  };
  const d = await draw(pool, SAMPLE_SEED, async (c) => replayVerifies(env, JSON.parse((await load(c.run)).text)));
  if ("error" in d) return d;
  const records: SampleRecord[] = [];
  for (const c of d.picked) {
    const { run } = await load(c.run);
    records.push(sampleRecord(origin, c, run.run, run.log, run.event.kind as SampleRecord["event_kind"]));
  }
  records.sort((a, b) => (a.trap_id < b.trap_id ? -1 : a.trap_id > b.trap_id ? 1 : a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
  const builtAt = new Date(now).toISOString();
  const jsonl = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const replays = [
    { id: d.pair.pass.run, verdict: "passed" },
    { id: d.pair.fail.run, verdict: "failed" },
  ];
  const files: { name: string; text: string }[] = [
    { name: "README.md", text: readme(origin, { builtAt, records, replays, pair: d.pair, candidates: pool.length }) },
    { name: "LICENSE.txt", text: licenceText(origin) },
    { name: "sample.jsonl", text: jsonl },
    { name: "schema.json", text: JSON.stringify(sampleSchema(origin), null, 2) + "\n" },
    { name: "croissant.json", text: JSON.stringify(sampleCroissant(origin, builtAt, { bytes: enc.encode(jsonl).length, sha256: await sha256Hex(jsonl) }), null, 2) + "\n" },
    ...(await Promise.all(replays.map(async (r) => ({ name: `replays/${r.id}.json`, text: (await load(r.id)).text })))),
  ];
  const listed: SampleFile[] = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: enc.encode(f.text).length, sha256: await sha256Hex(f.text) })));
  const sums = [...listed].sort((a, b) => (a.name < b.name ? -1 : 1)).map((f) => `${f.sha256}  ${f.name}`).join("\n") + "\n";
  files.push({ name: "SHA256SUMS", text: sums });
  listed.push({ name: "SHA256SUMS", bytes: enc.encode(sums).length, sha256: await sha256Hex(sums) });
  const modified = new Date(`${builtAt.slice(0, 10)}T00:00:00Z`);
  const zip = zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.text), modified })));
  const zipSha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", zip))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const falls = records.filter((r) => r.verdict === "fail").length;
  return {
    zip,
    meta: {
      format: SAMPLE_FORMAT,
      name: SAMPLE_NAME,
      version: SAMPLE_VERSION,
      built_at: builtAt,
      seed: SAMPLE_SEED,
      zip: { name: `${SAMPLE_NAME}.zip`, bytes: zip.length, sha256: zipSha, url: `${origin}${SAMPLE_ZIP_PATH}` },
      files: listed,
      counts: { records: records.length, falls, passes: records.length - falls, models: new Set(records.map((r) => r.model)).size, trap_kinds: new Set(records.map((r) => r.trap_kind.family)).size, candidates: pool.length },
      pair: { task: d.pair.fail.task, seed: d.pair.fail.seed, trap_id: d.pair.fail.trap, pass: d.pair.pass.run, fail: d.pair.fail.run },
      replays: replays.map((r) => r.id),
      licence_id: LICENCE_ID,
      canary_guid: CANARY_GUID,
    },
  };
}

// --- Write once, read forever ---------------------------------------------------------------------------------------

/** The zip's KV key, addressed by its SHA-256, so a meta can only ever point at the bytes it describes. */
export const sampleZipKey = (sha256: string) => `${SAMPLE_KV.zip}:${sha256}`;
/**
 * The build's claim (review of ADR 0100, ADR 0105): one audit_log row with a fixed id. D1 is strongly consistent and KV
 * is not (a meta written in one place can take a minute to be seen in another), so the claim, not the KV meta, decides
 * who builds: two admins pressing Build at once, or a second press before KV catches up, can't publish two samples.
 */
export const SAMPLE_CLAIM_ID = `dataset-sample-${SAMPLE_VERSION}`;
/** A claim still "building" after this long is a build that died part-way; a new press may take it over. */
export const SAMPLE_CLAIM_STALE_MS = 10 * 60_000;

export async function readSampleMeta(env: Pick<Env, "KV">): Promise<SampleMeta | null> {
  return env.KV.get<SampleMeta>(SAMPLE_KV.meta, { type: "json", cacheTtl: 300 });
}

/** The published zip, only if its bytes hash to the meta's SHA-256 (never a zip the listing doesn't describe). */
export async function readSampleZip(env: Pick<Env, "KV">, meta: SampleMeta): Promise<Uint8Array | null> {
  for (const k of [sampleZipKey(meta.zip.sha256), SAMPLE_KV.zip]) {
    const b = await env.KV.get(k, { type: "arrayBuffer", cacheTtl: 3600 });
    if (b && (await sha256Bytes(b)) === meta.zip.sha256) return new Uint8Array(b);
  }
  return null;
}

const sha256Bytes = async (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");

type ClaimState = { state: "building" | "published"; sha256?: string; built_at?: string };

/**
 * Publishes the sample once. A version already published is never rebuilt or overwritten (its bytes and checksum are
 * fixed). Only the holder of the D1 claim builds; the zip goes to a key named by its SHA-256 and the meta is written
 * last, so a failed write publishes nothing and a reader never pairs a meta with other bytes.
 */
export async function publishSample(env: Env, now = Date.now(), actor = "admin"): Promise<{ status: "published" | "exists"; meta: SampleMeta } | { status: "refused"; error: string }> {
  const existing = await env.KV.get<SampleMeta>(SAMPLE_KV.meta, "json");
  if (existing) return { status: "exists", meta: existing };
  const db = getDb(env);
  const clock = Date.now();
  const building: ClaimState = { state: "building" };
  const isBuilding = sql`json_extract(${t.auditLog.detail}, '$.state') = 'building'`;
  const won = await db
    .insert(t.auditLog)
    .values({ id: SAMPLE_CLAIM_ID, actor, action: "dataset_sample_build", target: SAMPLE_NAME, detail: building, createdAt: clock })
    .onConflictDoNothing()
    .returning({ id: t.auditLog.id });
  if (!won.length) {
    const took = await db
      .update(t.auditLog)
      .set({ actor, detail: building, createdAt: clock })
      .where(and(eq(t.auditLog.id, SAMPLE_CLAIM_ID), isBuilding, lt(t.auditLog.createdAt, clock - SAMPLE_CLAIM_STALE_MS)))
      .returning({ id: t.auditLog.id });
    if (!took.length) {
      const row = await db.query.auditLog.findFirst({ where: eq(t.auditLog.id, SAMPLE_CLAIM_ID) });
      const st = (row?.detail as ClaimState | null)?.state;
      return { status: "refused", error: st === "published" ? "It is already published; the listing shows it within a few minutes." : "Another build is running. Reload in a few minutes." };
    }
  }
  const release = () => db.delete(t.auditLog).where(and(eq(t.auditLog.id, SAMPLE_CLAIM_ID), isBuilding));
  try {
    const built = await buildSample(env, now);
    if ("error" in built) {
      await release();
      return { status: "refused", error: built.error };
    }
    await env.KV.put(sampleZipKey(built.meta.zip.sha256), built.zip);
    await env.KV.put(SAMPLE_KV.meta, JSON.stringify(built.meta));
    const done: ClaimState = { state: "published", sha256: built.meta.zip.sha256, built_at: built.meta.built_at };
    await db.update(t.auditLog).set({ detail: done }).where(eq(t.auditLog.id, SAMPLE_CLAIM_ID));
    return { status: "published", meta: built.meta };
  } catch (e) {
    // Nothing was published if the meta write didn't happen; free the claim so a later press can try again.
    if (!(await env.KV.get(SAMPLE_KV.meta))) await release().catch(() => {});
    throw e;
  }
}
