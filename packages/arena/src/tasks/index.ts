import type { TaskType } from "../types";
import { flakySupplier } from "./flaky-supplier";
import { impossible } from "./impossible";
import { refund } from "./refund";
import { scamInvoice } from "./scam-invoice";
import { spreadsheet } from "./spreadsheet";
import { weekend } from "./weekend";

/** The launch card (ADR 0013 §2). Locked before each event: changing a task means a new season version. */
export const TASKS: TaskType[] = [refund, scamInvoice, weekend, spreadsheet, flakySupplier, impossible];
export const taskById = (id: string) => TASKS.find((t) => t.id === id) ?? null;
