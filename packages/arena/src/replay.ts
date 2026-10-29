import { stable } from "./engine";
import { rescore } from "./rescore";
import { taskById } from "./tasks/index";
import type { AttemptResult, LogEvent } from "./types";

// Replay format v2 (ADR 0066, docs/arena/replay-format.md): a run's referee log as a hash chain, closed by a seal that
// The Forge signs with an Ed25519 key whose public half is published at /.well-known/forge-keys.json. Anyone can
// recompute the chain, check the seal against the published key and re-run the open referee on the logged actions
// (`forge verify`). Format v1 (every run finished before v2) is the log plus an HMAC-SHA256 signature: only The
// Forge's server holds that key, so a v1 run verifies by its existing signature only, on the site.
//
// Pure: no clock, no network, no WebCrypto. The caller passes SHA-256 (the Worker uses crypto.subtle, the CLI
// node:crypto) and, for checking, an Ed25519 verify function.

export const REPLAY_FORMAT = "forge-replay/2";
export const REPLAY_V1_FORMAT = "forge-replay/1";
export const KEYS_FORMAT = "forge-keys/1";
export const KEYS_PATH = "/.well-known/forge-keys.json";
/** The chain's starting point: event 0's `prev`. */
export const GENESIS = "0".repeat(64);

/**
 * The public test key that signs the first-clone fixture (packages/cli/fixtures/replays). Its private seed is
 * SHA-256 of the text below, so anyone can sign with it: a fixture that verifies proves the file is intact and the
 * format works, not that The Forge produced it. The Forge never signs a real run with this key.
 */
export const FIXTURE_KEY = {
  kid: "fixture-1",
  kty: "OKP",
  crv: "Ed25519",
  x: "QVil1cjsGoHHSIU9P48Wg86mrbSBRm7PIhu_KIXsyKk",
  seed_text: "forge-replay-fixture-key/1",
} as const;
export const FIXTURE_ORIGIN = "fixture:dev-split";

/** SHA-256 of UTF-8 text, as 64 lower-case hex characters. */
export type Sha256Hex = (text: string) => Promise<string> | string;

/**
 * Canonical JSON: the value as JSON would store it (undefined dropped, non-finite numbers null), then object keys
 * sorted by UTF-16 code units, no whitespace, numbers and strings as JSON.stringify writes them. For the data in a
 * replay (strings, finite numbers, booleans, null, arrays, objects) this is RFC 8785 (JCS).
 */
export function canonical(v: unknown): string {
  return stable(JSON.parse(JSON.stringify(v ?? null)));
}

/** A key id: "forge-" + the first 16 hex characters of SHA-256 over the public key's base64url `x` text. */
export const keyIdOf = async (sha: Sha256Hex, x: string) => `forge-${(await sha(x)).slice(0, 16)}`;

/** One event's hash: SHA-256 over canonical {event, i, prev}. The index and the previous hash make order matter. */
export const eventHash = async (sha: Sha256Hex, i: number, prev: string, event: unknown) => sha(canonical({ event, i, prev }));

/** One link of the published chain: event i's `prev` (the hash of event i-1, or GENESIS) and its own hash. */
export interface ChainLink {
  prev: string;
  hash: string;
}

/** The chain for a log, in order. The last hash is the chain head. */
export async function replayChain(sha: Sha256Hex, log: readonly unknown[]): Promise<ChainLink[]> {
  const out: ChainLink[] = [];
  let prev = GENESIS;
  for (let i = 0; i < log.length; i++) {
    const hash = await eventHash(sha, i, prev, log[i]);
    out.push({ prev, hash });
    prev = hash;
  }
  return out;
}

/** The final record of a run: what the signature covers is every field but `signature`. */
export interface ReplaySeal {
  format: typeof REPLAY_FORMAT;
  alg: "Ed25519";
  key_id: string;
  /** The site that signed it (its key set is at origin + KEYS_PATH), or FIXTURE_ORIGIN for the test fixture. */
  origin: string;
  kind: "arena" | "gauntlet" | "fixture";
  /** Arena: the run id. Gauntlet: "<gauntlet id>/<job number>". */
  run_id: string;
  task: string;
  seed: number;
  /** The model that played (Arena); null when none is recorded (a Gauntlet run is an outside agent). */
  model: string | null;
  /** The referee rules that scored the run, e.g. "rules 0.6". */
  rules: string;
  /** The job's world version, e.g. "v3.1". */
  task_version: string;
  /** Number of log events. */
  steps: number;
  chain_head: string;
  /** SHA-256 over the canonical published result (the referee's full verdict). */
  result_sha256: string;
  verdict: { passed: boolean; reason: string };
  signed_at: string;
  /** "ed25519:" + base64url (no padding) signature over sealMessage(seal). */
  signature: string;
}

export type SealBody = Omit<ReplaySeal, "signature">;

/** The exact text that is signed (as UTF-8 bytes): canonical JSON of the seal without its signature. */
export function sealMessage(seal: SealBody | ReplaySeal): string {
  const { signature: _s, ...body } = seal as ReplaySeal;
  return canonical(body);
}

/** The seal body for a finished run (sign `sealMessage` of it, then add the signature). */
export async function sealBody(
  sha: Sha256Hex,
  r: { keyId: string; origin: string; kind: ReplaySeal["kind"]; runId: string; model: string | null; rules: string; taskVersion: string; log: readonly LogEvent[]; result: AttemptResult; signedAt: number },
): Promise<SealBody> {
  const chain = await replayChain(sha, r.log);
  return {
    format: REPLAY_FORMAT,
    alg: "Ed25519",
    key_id: r.keyId,
    origin: r.origin,
    kind: r.kind,
    run_id: r.runId,
    task: r.result.task,
    seed: r.result.seed,
    model: r.model,
    rules: r.rules,
    task_version: r.taskVersion,
    steps: r.log.length,
    chain_head: chain.at(-1)?.hash ?? GENESIS,
    result_sha256: await sha(canonical(r.result)),
    verdict: { passed: r.result.passed, reason: r.result.reason },
    signed_at: new Date(r.signedAt).toISOString(),
  };
}

/** The `replay` block of a published v2 replay document. */
export interface ReplayBlockV2 {
  format: typeof REPLAY_FORMAT;
  chain: ChainLink[];
  seal: ReplaySeal;
}

/** The `replay` block for a v2 run: the chain recomputed from the stored log, and the stored seal. */
export async function replayBlock(sha: Sha256Hex, log: readonly unknown[], seal: ReplaySeal): Promise<ReplayBlockV2> {
  return { format: REPLAY_FORMAT, chain: await replayChain(sha, log), seal };
}

export const isSeal = (v: unknown): v is ReplaySeal =>
  !!v && typeof v === "object" && (v as ReplaySeal).format === REPLAY_FORMAT && typeof (v as ReplaySeal).signature === "string" && typeof (v as ReplaySeal).key_id === "string";

/** One published key, as in the key set at KEYS_PATH: a JWK plus its id, status and dates. */
export interface ReplayKey {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  use: "sig";
  status: "current" | "retired";
  /** First day it signed (ISO date), when known. */
  from: string | null;
  /** The day it stopped signing; null while current. */
  retired: string | null;
}

export interface KeySet {
  format: typeof KEYS_FORMAT;
  origin: string;
  keys: ReplayKey[];
  rotation: string[];
}

/** An Ed25519 check: true or false, or null when the key id isn't in the key set. */
export type VerifySig = (keyId: string, message: string, signature: string) => Promise<boolean | null> | boolean | null;

export type Check = "ok" | "failed" | "not_checked";

/** What the hash chain and the seal say about a published replay document. */
export interface ChainReport {
  format: 1 | 2 | null;
  run_id: string | null;
  steps: number;
  /** v2: every event's recomputed hash and `prev` match the published chain and the sealed head and step count. */
  chain: Check;
  /** The first event (0-based) where the chain breaks, when it failed. */
  chain_break_at: number | null;
  /** v2: the result hashes to the sealed result_sha256, and the run id, task, seed and verdict agree with the seal. */
  record: Check;
  record_problems: string[];
  /** v2: the Ed25519 signature over the seal, against the key set. */
  signature: Check | "unknown_key";
  key_id: string | null;
  seal: ReplaySeal | null;
  /**
   * A replay format (or seal algorithm) this code doesn't know, e.g. a later "forge-replay/3". Nothing else is checked:
   * a verifier fails closed (can't check) rather than falling back to an older format.
   */
  unknown_format: string | null;
  /** The rules a later re-score used, when The Forge re-scored the run after sealing it (the seal covers the original). */
  rescored_rules: string | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
/** "ed25519:" + exactly 64 bytes as unpadded base64url (86 characters), so one signature has one spelling. */
export const SIGNATURE_PATTERN = /^ed25519:[A-Za-z0-9_-]{85}[AQgw]$/;

/** What's wrong with a v2 seal's shape, or null when every field has the type the format says. */
export function sealShapeProblem(v: unknown): string | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the seal is missing";
  const s = v as Record<string, unknown>;
  const str = (k: string) => typeof s[k] === "string" && (s[k] as string).length > 0;
  for (const k of ["key_id", "origin", "kind", "run_id", "task", "rules", "task_version", "signed_at"]) if (!str(k)) return `the seal's ${k} is missing or not text`;
  if (!Number.isSafeInteger(s.seed)) return "the seal's seed isn't a whole number";
  if (s.model !== null && typeof s.model !== "string") return "the seal's model isn't text or null";
  if (!Number.isSafeInteger(s.steps) || (s.steps as number) < 0) return "the seal's step count isn't a whole number";
  if (typeof s.chain_head !== "string" || !HEX64.test(s.chain_head)) return "the seal's chain head isn't a SHA-256 hash";
  if (typeof s.result_sha256 !== "string" || !HEX64.test(s.result_sha256)) return "the seal's result hash isn't a SHA-256 hash";
  const vd = s.verdict as Record<string, unknown> | null;
  if (!vd || typeof vd !== "object" || typeof vd.passed !== "boolean" || typeof vd.reason !== "string") return "the seal's verdict is malformed";
  if (typeof s.signature !== "string" || !SIGNATURE_PATTERN.test(s.signature)) return "the seal's signature isn't one Ed25519 signature in base64url";
  return null;
}

/**
 * The result the seal covers. A run The Forge re-scored after sealing it (rules changed) publishes the new verdict
 * with the sealed original kept under `rescored.sealed`; otherwise it's the published result itself.
 */
export function sealedResultOf(result: unknown): { sealed: unknown; rescoredRules: string | null } {
  const r = result && typeof result === "object" ? (result as { rescored?: { rules?: unknown; sealed?: unknown } }) : null;
  const rs = r?.rescored;
  if (rs && typeof rs === "object" && rs.sealed && typeof rs.sealed === "object") return { sealed: rs.sealed, rescoredRules: typeof rs.rules === "string" ? rs.rules : null };
  return { sealed: result, rescoredRules: null };
}

interface ReplayDoc {
  id?: unknown;
  model?: unknown;
  log?: unknown;
  result?: unknown;
  replay?: { format?: unknown; chain?: unknown; seal?: unknown } | null;
}

/** Recomputes the chain and checks the seal of a published v2 replay, or reports format v1 (or not a replay). */
export async function checkReplay(doc: unknown, sha: Sha256Hex, verify: VerifySig | null): Promise<ChainReport> {
  const d = (doc && typeof doc === "object" ? doc : {}) as ReplayDoc;
  const log = Array.isArray(d.log) ? (d.log as unknown[]) : null;
  const out: ChainReport = { format: null, run_id: typeof d.id === "string" ? d.id : null, steps: log?.length ?? 0, chain: "not_checked", chain_break_at: null, record: "not_checked", record_problems: [], signature: "not_checked", key_id: null, seal: null, unknown_format: null, rescored_rules: null };
  const block = d.replay && typeof d.replay === "object" ? d.replay : null;
  const raw = block?.seal ?? null;
  const fmt = block?.format;
  const sealFmt = raw && typeof raw === "object" ? (raw as { format?: unknown }).format : undefined;
  const sealAlg = raw && typeof raw === "object" ? (raw as { alg?: unknown }).alg : undefined;
  // Fail closed: a format or algorithm this code doesn't know is never read as an older one.
  if (block && fmt !== undefined && fmt !== REPLAY_FORMAT && fmt !== REPLAY_V1_FORMAT) {
    out.unknown_format = String(fmt).slice(0, 60);
    return out;
  }
  if (raw !== null && (sealFmt !== REPLAY_FORMAT || sealAlg !== "Ed25519")) {
    out.unknown_format = sealFmt !== REPLAY_FORMAT ? `seal ${String(sealFmt).slice(0, 60)}` : `${REPLAY_FORMAT} with alg ${String(sealAlg).slice(0, 30)}`;
    return out;
  }
  if (raw === null && fmt !== REPLAY_FORMAT) {
    out.format = log ? 1 : null;
    return out;
  }
  out.format = 2;
  // Format v2 says so, but the seal is gone or malformed: a stripped or edited record, never a quiet downgrade to v1.
  const shape = raw === null ? "the replay says format v2 but has no seal" : sealShapeProblem(raw);
  if (shape) {
    out.record = "failed";
    out.record_problems = [shape];
    out.signature = "failed";
    return out;
  }
  const seal = raw as ReplaySeal;
  out.key_id = seal.key_id;
  out.seal = seal;
  if (!log) {
    out.chain = "failed";
    out.chain_break_at = 0;
  } else {
    // Every event's hash recomputed from the log, against the published links, then the sealed head and length.
    const mine = await replayChain(sha, log);
    const theirs = Array.isArray(d.replay?.chain) ? (d.replay!.chain as Partial<ChainLink>[]) : [];
    let brk = mine.findIndex((l, i) => l.hash !== theirs[i]?.hash || l.prev !== theirs[i]?.prev);
    if (brk === -1 && theirs.length !== mine.length) brk = Math.min(theirs.length, mine.length);
    if (brk === -1 && (seal.steps !== mine.length || seal.chain_head !== (mine.at(-1)?.hash ?? GENESIS))) brk = Math.min(seal.steps, mine.length);
    out.chain = brk === -1 ? "ok" : "failed";
    out.chain_break_at = brk === -1 ? null : brk;
  }
  // The record: the published verdict and identity match the seal.
  const problems: string[] = [];
  const { sealed, rescoredRules } = sealedResultOf(d.result);
  out.rescored_rules = rescoredRules;
  const result = sealed && typeof sealed === "object" ? (sealed as Partial<AttemptResult>) : null;
  if (!result) problems.push("the document has no result");
  else {
    if ((await sha(canonical(result))) !== seal.result_sha256) problems.push(rescoredRules ? "the sealed original result (result.rescored.sealed) differs from the sealed result_sha256" : "the result differs from the sealed result_sha256");
    if (result.passed !== seal.verdict.passed || result.reason !== seal.verdict.reason) problems.push("the verdict differs from the sealed verdict");
    if (result.task !== seal.task || result.seed !== seal.seed) problems.push("the task or seed differs from the seal");
  }
  if (out.run_id !== seal.run_id) problems.push("the run id differs from the seal");
  if ("model" in d && d.model !== seal.model) problems.push("the model differs from the seal");
  const start = log?.[0] as Partial<Extract<LogEvent, { type: "start" }>> | undefined;
  if (start?.type !== "start" || start.task !== seal.task || start.seed !== seal.seed) problems.push("the log's start event differs from the seal");
  out.record = problems.length ? "failed" : "ok";
  out.record_problems = problems;
  if (verify) {
    const ok = await verify(seal.key_id, sealMessage(seal), seal.signature);
    out.signature = ok === null ? "unknown_key" : ok ? "ok" : "failed";
  }
  return out;
}

/** The referee re-run: the logged actions replayed through the open referee, against the published verdict. */
export interface RefereeReport {
  checked: boolean;
  /** Why it wasn't checked (not a public job, no log, a log the referee can't read). */
  why: string | null;
  /** The referee bundled here, e.g. "rules 0.6". */
  rules_here: string | null;
  /** The rules that scored the run (seal, else the result's stamp); null on runs from before stamps. */
  rules_of_run: string | null;
  /** The re-run reached the same pass/fail, end reason, checkpoints and traps as the published result. */
  same_verdict: boolean | null;
  /** The re-run reproduced every logged world event (calls, results, errors) exactly. */
  faithful: boolean | null;
  differences: string[];
  published: { passed: boolean | null; reason: string | null };
  recomputed: { passed: boolean | null; reason: string | null };
}

/** Re-runs the open end-state referee on a published replay's logged actions (public jobs only). */
export function refereeCheck(doc: unknown): RefereeReport {
  const d = (doc && typeof doc === "object" ? doc : {}) as ReplayDoc;
  const result = d.result && typeof d.result === "object" ? (d.result as Partial<AttemptResult> & { rules?: unknown }) : null;
  const seal = isSeal(d.replay?.seal) ? d.replay!.seal : null;
  // A run re-scored after sealing publishes the re-scored verdict, so the rules it's compared under are the re-score's.
  const rescoredRules = sealedResultOf(result).rescoredRules;
  const empty: RefereeReport = {
    checked: false,
    why: null,
    rules_here: null,
    rules_of_run: rescoredRules ?? seal?.rules ?? (typeof result?.rules === "string" ? result.rules : null),
    same_verdict: null,
    faithful: null,
    differences: [],
    published: { passed: typeof result?.passed === "boolean" ? result.passed : null, reason: typeof result?.reason === "string" ? result.reason : null },
    recomputed: { passed: null, reason: null },
  };
  const log = Array.isArray(d.log) ? (d.log as LogEvent[]) : null;
  const start = log?.[0];
  if (!log || start?.type !== "start") return { ...empty, why: "the document has no log that begins with a start event" };
  if (!taskById(start.task)) return { ...empty, why: `job ${start.task} isn't a public job, so its referee isn't published` };
  try {
    const r = rescore({ task: start.task, seed: start.seed, log, result: result ?? null });
    const diffs: string[] = [];
    if (empty.published.passed !== r.result.passed) diffs.push(`pass/fail: published ${empty.published.passed}, recomputed ${r.result.passed}`);
    if (empty.published.reason !== r.result.reason) diffs.push(`end reason: published ${empty.published.reason}, recomputed ${r.result.reason}`);
    for (const f of r.flips) diffs.push(`${f.kind} ${f.id}: published ${f.before}, recomputed ${f.after}`);
    return {
      ...empty,
      checked: true,
      rules_here: r.rules,
      same_verdict: diffs.length === 0,
      faithful: r.faithful,
      differences: r.mismatch ? [...diffs, r.mismatch] : diffs,
      recomputed: { passed: r.result.passed, reason: r.result.reason },
    };
  } catch (e) {
    return { ...empty, why: `the referee couldn't replay this log: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) };
  }
}
