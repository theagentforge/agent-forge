import { checkReplay, refereeCheck, type Sha256Hex, type VerifySig } from "../replay";
import type { LogEvent } from "../types";
import { rebuildWorld } from "./world";

// One-command reproducibility (Q5, ADR 0136): for one published replay, (1) rebuild the job's world from its task
// version and seed and check that every world event (the start, each call, each tool output or error, each spin)
// matches the replay byte for byte as canonical JSON, timestamps aside; (2) re-run the open referee on the recorded
// trace and check it reaches the identical verdict; (3) check the hash chain and the Ed25519 signature (format v2).
// What it can't do, and says: replay the model. Model outputs vary between runs; the variance is reported from the
// 3-of-3 consistency data (three attempts per model, job and seed), never claimed away.

export const REPRODUCE_FORMAT = "forge-reproduce/1";

export const MODEL_VARIANCE_NOTE =
  "This reproduces the world, the tool outputs and the referee's verdict for the recorded trace. It does not reproduce the model: the same model on the same seed can act differently on another run. See the 3-of-3 consistency figures (three attempts per model, job and seed) for how much results vary.";

export interface ReproduceReport {
  format: typeof REPRODUCE_FORMAT;
  run_id: string | null;
  task: string | null;
  seed: number | null;
  task_version: string | null;
  status: "reproduced" | "reproduced_signature_not_checked" | "reproduced_signature_not_public" | "failed" | "unable";
  world: { checked: boolean; identical: boolean | null; events_compared: number; tool_outputs_in_log: boolean; first_difference: { at: number; logged: string; rebuilt: string } | null; why: string | null };
  referee: { checked: boolean; identical_verdict: boolean | null; rules_here: string | null; rules_of_run: string | null; published: { passed: boolean | null; reason: string | null }; recomputed: { passed: boolean | null; reason: string | null }; differences: string[]; why: string | null };
  signature: { format: 1 | 2 | null; chain: string; record: string; signature: string; key_id: string | null; note: string | null };
  model_variance: { note: string; consistency: unknown };
  problems: string[];
}

export async function reproduce(doc: unknown, sha: Sha256Hex, verify: VerifySig | null, consistency: unknown = null): Promise<ReproduceReport> {
  const d = (doc && typeof doc === "object" ? doc : {}) as { id?: unknown; log?: unknown; result?: unknown; replay?: { seal?: { task_version?: unknown } } };
  const log = Array.isArray(d.log) ? (d.log as LogEvent[]) : null;
  const start = log?.[0]?.type === "start" ? log[0] : null;
  const problems: string[] = [];

  let world: ReproduceReport["world"] = { checked: false, identical: null, events_compared: 0, tool_outputs_in_log: false, first_difference: null, why: null };
  if (!log || !start) world.why = "the document has no log that begins with a start event";
  else {
    try {
      const w = rebuildWorld(log);
      world = { checked: true, identical: w.faithful, events_compared: w.compared, tool_outputs_in_log: !w.slim, first_difference: w.mismatch, why: null };
      if (!w.faithful) problems.push(`the rebuilt world differs from the replay at world event ${w.mismatch!.at}`);
      if (w.slim) problems.push("the log has no tool outputs (a slim export), so only the world, the calls and the spins were compared");
    } catch (e) {
      world.why = e instanceof Error ? e.message : String(e);
    }
  }

  const ref = refereeCheck(doc);
  const referee: ReproduceReport["referee"] = {
    checked: ref.checked,
    identical_verdict: ref.checked ? ref.same_verdict : null,
    rules_here: ref.rules_here,
    rules_of_run: ref.rules_of_run,
    published: ref.published,
    recomputed: ref.recomputed,
    differences: ref.differences,
    why: ref.why,
  };
  if (ref.checked && !ref.same_verdict) problems.push(`the open referee (${ref.rules_here}) reaches a different verdict from the published one (${ref.rules_of_run ?? "rules not stamped"})`);

  const chain = await checkReplay(doc, sha, verify);
  const signature: ReproduceReport["signature"] = {
    format: chain.format,
    chain: chain.chain,
    record: chain.record,
    signature: chain.signature,
    key_id: chain.key_id,
    note:
      chain.format === 1
        ? "Replay format v1 (runs before format v2): signed with a server key (HMAC-SHA256) only The Forge holds, so the signature can't be checked here. The world and referee checks above don't depend on it."
        : chain.unknown_format
          ? `Unknown replay format ${chain.unknown_format}: not checked.`
          : chain.format === 2 && chain.signature !== "ok"
            ? "The hash chain and the sealed record were checked; the signature wasn't, because the signing key wasn't available here (the site's /.well-known/forge-keys.json, or --keys)."
            : null,
  };
  if (chain.format === 2) {
    if (chain.chain !== "ok") problems.push("the hash chain doesn't match the log");
    if (chain.record !== "ok") problems.push(...chain.record_problems);
    if (chain.signature === "failed") problems.push("the Ed25519 signature doesn't match the seal");
  }

  const worldOk = world.checked && world.identical === true;
  const refOk = referee.checked && referee.identical_verdict === true;
  const sealBroken = chain.format === 2 && (chain.chain !== "ok" || chain.record !== "ok" || chain.signature === "failed");
  const sigChecked = chain.format === 2 && chain.signature === "ok";
  const status: ReproduceReport["status"] = !world.checked || !referee.checked ? "unable" : !worldOk || !refOk || sealBroken || chain.unknown_format ? "failed" : sigChecked ? "reproduced" : chain.format === 2 ? "reproduced_signature_not_checked" : "reproduced_signature_not_public";

  return {
    format: REPRODUCE_FORMAT,
    run_id: typeof d.id === "string" ? d.id : null,
    task: start?.task ?? null,
    seed: start?.seed ?? null,
    task_version: typeof d.replay?.seal?.task_version === "string" ? d.replay.seal.task_version : null,
    status,
    world,
    referee,
    signature,
    model_variance: { note: MODEL_VARIANCE_NOTE, consistency },
    problems,
  };
}

/**
 * The 3-of-3 consistency of a set of published attempts: groups of (model, job, seed) with three or more attempts, and
 * how many of them reached the same pass/fail (and the same sprung traps) on every attempt.
 */
export function consistencyOf(rows: readonly { model: string; task: string; seed: number; passed: boolean; traps: readonly string[] }[]) {
  const by = new Map<string, { passed: boolean; traps: string }[]>();
  for (const r of rows) {
    const k = `${r.model}\u0000${r.task}\u0000${r.seed}`;
    by.set(k, [...(by.get(k) ?? []), { passed: r.passed, traps: [...r.traps].sort().join(",") }]);
  }
  const groups = [...by.values()].filter((g) => g.length >= 3);
  const samePass = groups.filter((g) => g.every((x) => x.passed === g[0]!.passed)).length;
  const sameTraps = groups.filter((g) => g.every((x) => x.passed === g[0]!.passed && x.traps === g[0]!.traps)).length;
  const allPass = groups.filter((g) => g.every((x) => x.passed)).length;
  return { groups: groups.length, same_pass_fail_on_every_attempt: samePass, same_verdict_and_traps_on_every_attempt: sameTraps, passed_every_attempt: allPass };
}
