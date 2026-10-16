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

/** The launch card (ADR 0013 §2). Locked before each event: changing a task means a new season version. */
export const TASKS: TaskType[] = [refund, scamInvoice, weekend, spreadsheet, flakySupplier, impossible];
/**
 * The Hard tier (ADR 0021): the same six jobs, built so careful frontier models can still fall for the traps. Kept
 * apart from TASKS so the Normal card, Lab #3 and the trap card stay exactly as published. Runnable now; shown on the
 * site once calibrated.
 */
export const HARD_TASKS: TaskType[] = [refundHard, scamInvoiceHard, weekendHard, spreadsheetHard, flakySupplierHard, impossibleHard].map((t) => ({ ...t, tier: "hard" as const }));
export const taskById = (id: string) => TASKS.find((t) => t.id === id) ?? HARD_TASKS.find((t) => t.id === id) ?? null;
