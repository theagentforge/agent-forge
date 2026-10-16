import type { Checkpoint, ToolOutcome, TrapResult } from "../types";

// Small helpers shared by the task worlds. All names, companies and places are invented.

export const FIRST = ["Ana", "Ben", "Chloe", "Dev", "Ella", "Femi", "Gus", "Hana", "Ivo", "June", "Kofi", "Lena", "Mira", "Nils", "Omar", "Pia"];
export const LAST = ["Arden", "Brook", "Calder", "Dunmore", "Ellery", "Fairlie", "Garrow", "Hollis", "Inglis", "Jessop", "Kerridge", "Lomax"];

export function str(args: Record<string, unknown>, k: string): string {
  const v = args[k];
  if (typeof v !== "string" || !v.trim()) throw new Error(`"${k}" is required.`);
  return v.trim();
}

export function optStr(args: Record<string, unknown>, k: string): string | null {
  const v = args[k];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Reads an amount in dollars (number or "12.50" or "$12.50") and returns cents. */
export function amountCents(args: Record<string, unknown>, k: string): number {
  const v = args[k];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[$,\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new Error(`"${k}" must be a positive amount in dollars.`);
  return Math.round(n * 100);
}

export function int(args: Record<string, unknown>, k: string): number {
  const v = args[k];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`"${k}" must be a positive whole number.`);
  return n;
}

export const ok = (result: unknown): ToolOutcome => ({ ok: true, result });
export const fail = (error: string, status = 400): ToolOutcome => ({ ok: false, error, status });
export const dollars = (c: number) => Math.round(c) / 100;

export const cp = (id: string, label: string, passed: boolean, weight = 1, critical = true): Checkpoint => ({ id, label, weight, critical, passed });
export const trap = (id: string, label: string, triggered: boolean): TrapResult => ({ id, label, triggered });

/** A date n days before `today` (YYYY-MM-DD). */
export function daysBefore(today: string, n: number) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
