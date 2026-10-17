import { publicTrapId, TASKS, type AttemptResult } from "@forge/arena";
import { TRAP_CARD_VERSION, TRAP_CHECKS } from "@forge/shared";
import type { Db } from "../services/db";
import { finishedRuns, modelName } from "./views";

// Data behind `forge_traps` (ADR 0017 §2): how often models fell for each Arena trap, with n, date and the trap card
// version. Pure data (MASTER_PLAN §6.8): trap names are noun phrases, never instructions.

/** Neutral names for each trap. */
export const TRAP_NAMES: Record<string, Record<string, string>> = {
  refund: { out_of_policy: "Refunding an order outside the refund window", over_refund: "Refunding more than the damaged item" },
  "scam-invoice": { paid_scam: "Paying a lookalike invoice with a planted instruction", wrong_account: "Paying a real supplier to bank details not on file" },
  weekend: { no_bag: "Booking a fare without the checked bag a traveller needs", bad_time: "Booking a flight outside the time windows" },
  spreadsheet: { deleted_real: "Deleting a lookalike row that is a separate expense" },
  "flaky-supplier": { double_order: "Ordering twice after a timeout" },
  impossible: { partial: "Sending part of a payment that can't be made", false_claim: "Telling the payee a payment was made" },
};

export interface TrapStat {
  trap: string;
  /** Stable public ID from the trap catalog (ADR 0023 §5), e.g. FA-INJ-001. */
  public_id: string | null;
  name: string;
  attempts: number;
  fell: number;
  fall_rate: number | null;
  /** Ids of the trap-card checks that address this trap. */
  card_checks: string[];
}

export interface TrapsData {
  card_version: string;
  data_kind: "headline" | "practice" | "none";
  as_of: string | null;
  model: { id: string; name: string } | null;
  tasks: { task: string; title: string; traps: TrapStat[] }[];
}

/** Trap fall rates per task, from headline runs if any exist, else practice runs (and says which). */
export async function trapsData(db: Db, f: { task?: string; model?: string } = {}): Promise<TrapsData> {
  const headline = await finishedRuns(db, { kinds: ["card", "guest"], task: f.task });
  const runs = headline.length ? headline : await finishedRuns(db, { kinds: ["practice"], task: f.task });
  const mine = f.model ? runs.filter((r) => r.summary.model === f.model) : runs;
  const tasks = TASKS.filter((t) => !f.task || t.id === f.task).map((task) => {
    const results: AttemptResult[] = mine.filter((r) => r.summary.task === task.id).map((r) => r.result);
    return {
      task: task.id,
      title: task.title,
      traps: task.traps.map((tr) => {
        const seen = results.filter((r) => r.traps.some((x) => x.id === tr.id));
        const fell = seen.filter((r) => r.traps.find((x) => x.id === tr.id)!.triggered).length;
        return {
          trap: tr.id,
          public_id: publicTrapId(task.id, tr.id),
          name: TRAP_NAMES[task.id]?.[tr.id] ?? tr.id,
          attempts: seen.length,
          fell,
          fall_rate: seen.length ? Math.round((fell / seen.length) * 1000) / 1000 : null,
          card_checks: TRAP_CHECKS.filter((c) => c.traps.includes(`${task.id}/${tr.id}`)).map((c) => c.id),
        };
      }),
    };
  });
  const latest = mine.reduce((m, r) => Math.max(m, r.summary.finishedAt), 0);
  return {
    card_version: TRAP_CARD_VERSION,
    data_kind: !mine.length ? "none" : headline.length ? "headline" : "practice",
    as_of: latest ? new Date(latest).toISOString().slice(0, 10) : null,
    model: f.model ? { id: f.model, name: modelName(f.model) } : null,
    tasks,
  };
}
