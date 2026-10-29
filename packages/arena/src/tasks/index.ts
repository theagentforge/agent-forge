import type { TaskType } from "../types";
import { flakySupplier } from "./flaky-supplier";
import { flakySupplierHard } from "./flaky-supplier-hard";
import { impossible } from "./impossible";
import { impossibleHard } from "./impossible-hard";
import { refund } from "./refund";
import { refundHard } from "./refund-hard";
import { scamInvoice } from "./scam-invoice";
import { scamInvoiceHard } from "./scam-invoice-hard";
import { spreadsheet } from "./spreadsheet";
import { spreadsheetHard } from "./spreadsheet-hard";
import { weekend } from "./weekend";
import { weekendHard } from "./weekend-hard";
import { flakySupplierHard3, flakySupplierHard32 } from "./flaky-supplier-hard3";
import { impossibleHard3 } from "./impossible-hard3";
import { refundHard3, refundHard32 } from "./refund-hard3";
import { scamInvoiceHard3 } from "./scam-invoice-hard3";
import { spreadsheetHard3 } from "./spreadsheet-hard3";
import { weekendHard3 } from "./weekend-hard3";
import { calculatorTool } from "./calculator";
import { PRIVATE_TASKS } from "../private";

/** The launch card (ADR 0013 §2). Locked before each event: changing a task means a new season version. */
export const TASKS: TaskType[] = [refund, scamInvoice, weekend, spreadsheet, flakySupplier, impossible];
/**
 * The Hard tier (ADR 0021): the same six jobs, built so careful frontier models can still fall for the traps. Kept
 * apart from TASKS so the Normal card, Lab #3 and the trap card stay exactly as published. Runnable now; shown on the
 * site once calibrated.
 */
export const HARD_TASKS: TaskType[] = [refundHard, scamInvoiceHard, weekendHard, spreadsheetHard, flakySupplierHard, impossibleHard].map((t) => ({ ...t, tier: "hard" as const }));
/**
 * Hard v3 (ADR 0021 amendment 3): longer, realistic workloads of the same six jobs, for Crucible 2: Hard. Runnable now
 * (calibration first); the site's Hard view keeps showing v2 (Crucible 1: Hard) until v3 has a ranked event.
 */
const hard3 = (t: TaskType) =>
  ({
    ...t,
    tier: "hard" as const,
    // Amendment 4: a calculator on every v3 job, so exact amounts test judgement, not mental arithmetic. Its calls
    // count like any other, so the tool-call and turn caps get 20% more room.
    tools: (v) => [...t.tools(v), calculatorTool()],
    caps: t.caps && { ...t.caps, toolCalls: Math.ceil(t.caps.toolCalls * 1.2), turns: Math.ceil(t.caps.turns * 1.2) },
  }) as TaskType;
export const HARD3_TASKS: TaskType[] = ([refundHard3, scamInvoiceHard3, weekendHard3, spreadsheetHard3, flakySupplierHard3, impossibleHard3] as TaskType[]).map(hard3);
/**
 * Hard v3.2 (ADR 0054): new task ids for the two v3 jobs that gained a trap (a stale approval in the refund queue, an
 * accepted-then-rejected order in the restock). The v3.1 tasks above stay exactly as Crucible 2 ran them, so their
 * results and replays don't change. Registered and runnable; not yet in any event or on the site's Hard view.
 */
export const HARD3_2_TASKS: TaskType[] = ([refundHard32, flakySupplierHard32] as TaskType[]).map(hard3);
/** A public job by id (Normal, Hard v2, Hard v3, v3.2). Private families are never found here, so no public page shows one. */
export const taskById = (id: string) =>
  TASKS.find((t) => t.id === id) ?? HARD_TASKS.find((t) => t.id === id) ?? HARD3_TASKS.find((t) => t.id === id) ?? HARD3_2_TASKS.find((t) => t.id === id) ?? null;

/**
 * Private families promoted to ranked events (ADR 0057). Empty: a family joins only after calibration on the practice
 * ladder and Dinike's yes. Until then its runs are practice-only and hidden from every public surface.
 */
export const RANKED_PRIVATE_TASKS: readonly string[] = [];
/** Private job ids that may only run in practice events (the private families not yet promoted). */
export const PRACTICE_ONLY_TASK_IDS: readonly string[] = PRIVATE_TASKS.map((t) => t.id).filter((id) => !RANKED_PRIVATE_TASKS.includes(id));
export const isPracticeOnly = (id: string) => PRACTICE_ONLY_TASK_IDS.includes(id);
/** The private job ids (all tiers), selectable by id for practice and held-out panels. */
export const PRIVATE_TASK_IDS: readonly string[] = PRIVATE_TASKS.map((t) => t.id);
/** The private families by base id (the Normal job id), each with its tiers' job ids. */
export const PRIVATE_FAMILIES: Record<string, string[]> = Object.fromEntries(
  [...new Set(PRIVATE_TASKS.map((t) => t.id.replace(/-hard$/, "")))].map((f) => [f, PRIVATE_TASKS.filter((t) => t.id.replace(/-hard$/, "") === f).map((t) => t.id)]),
);
/** Any job the runner can play: public jobs, then private families (practice and held-out runs only). */
export const anyTaskById = (id: string) => taskById(id) ?? PRIVATE_TASKS.find((t) => t.id === id) ?? null;

/** The sandbox fee the Hard banking job charges for a declined payment or a returned direct debit (cents). Read by the
 * Trap Set's cost-of-failure figures, so the published number is the one the job really charges. */
export { FEE as IMPOSSIBLE_HARD_FEE } from "./impossible-hard";
