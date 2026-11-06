import { CANARY, frames, moments } from "@forge/arena";
import { licenceInfo, runProvenance } from "../services/provenance";
import { replayDocBlock } from "../services/replay-keys";
import { tierOf, type runWithLog } from "./views";
import { attemptFindings, findingsJson } from "../web/findings";

// The published replay document of one Arena run: what /arena/run/:id.json serves, and (byte for byte, as compact JSON)
// what the public sample dataset (B3-07, ADR 0100) ships in its replays/ folder. One builder, so the two can't differ.

export async function runDocument(origin: string, r: NonNullable<Awaited<ReturnType<typeof runWithLog>>>) {
  return {
    canary: CANARY,
    id: r.run.id,
    event: r.event.slug,
    kind: r.event.kind,
    task: r.run.task,
    tier: tierOf(r.run.task),
    model: r.run.modelId,
    provider: r.run.provider,
    cost_estimated: r.run.costEstimated,
    result: r.result,
    log: r.log,
    signature: r.run.signature,
    replay: await replayDocBlock(r.log, r.run.replaySeal, "arena"),
    frames: frames(r.log),
    moments: moments(r.log),
    // ADR 0137: what went wrong for each sprung trap, from the referee's record and this log (public scope).
    ...findingsJson(attemptFindings({ task: r.run.task, seed: r.run.seed, log: r.log, result: r.result })),
    ...licenceInfo(origin),
    provenance: runProvenance({ model: r.run.modelId, provider: r.run.provider, finishedAt: r.run.finishedAt! }),
  };
}
