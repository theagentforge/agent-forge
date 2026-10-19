import { SCAN_RULES, type ScanFinding, type ScanSeverity } from "@forge/shared";
import * as t from "../db/schema";
import { getDb } from "./db";
import { isLean } from "./ops-mode";
import heldFile from "../seed/skill-scan-held.json";

// The launch scan (ADR 0026): every SKILL.md in 277 public GitHub repositories, scanned on 19 Oct 2026 with the same
// rules the site runs, published as a dataset at /data/skill-scan-2026-10-19.json and loaded into skill_scans a slice
// at a time by the hourly cron, so each result gets its page and badge. No model, no GitHub calls from the Worker.

export const SEED_PATH = "/data/skill-scan-2026-10-19.json";
// v2: the held rows moved out of the public file on 19 Oct, so the order changed; reloading what's there is a no-op.
const CURSOR_KEY = "seed:skill-scan-2026-10-19:v2";
const SEEDED_AT = Date.UTC(2026, 9, 19, 12);
/**
 * Disclosure (report v1.1, 19 Oct): flagged and caution results stay unlisted until maintainers have heard from us,
 * except the four vendors' official installers, which the report names. They go public on NOTICE_ENDS. Until then
 * their rows aren't in the public dataset either: they're bundled from src/seed/skill-scan-held.json (an empty stub
 * in the public mirror).
 */
export const NAMED_AT_LAUNCH = new Set(["google/skills", "NVIDIA/skills", "anthropics/claude-agent-sdk-python", "trailofbits/skills"]);
export const NOTICE_ENDS = Date.UTC(2026, 10, 2);
const SEV: Record<string, ScanSeverity> = { h: "high", m: "medium", l: "low" };
const PER_STATEMENT = 8; // 12 columns × 8 rows stays under D1's 100 bound parameters

export interface SeedFile {
  meta: { rules_version: string; files: number };
  repos: [string, string][];
  rows: [number, string, string, number, number, ([string, string, number, number, string] | [string, string, number, number, string, number])[]?][];
}

export function seedRow(file: SeedFile, row: SeedFile["rows"][number]) {
  const [repoIdx, path, hex, bytes, , raw = []] = row;
  const [repo, commit] = file.repos[repoIdx]!;
  const findings: ScanFinding[] = raw.map((f) => {
    const rule = SCAN_RULES.find((x) => x.id === f[0]);
    return { rule: f[0], family: rule?.family ?? "exec", severity: SEV[f[1]] ?? "low", title: rule?.title ?? f[0], why: rule?.why ?? "", line: f[2], column: f[3], evidence: f[4], ...(f[5] ? { context: "warning" as const } : {}) };
  });
  const counts = { high: 0, medium: 0, low: 0 } as Record<ScanSeverity, number>;
  for (const f of findings) counts[f.severity]++;
  return {
    fingerprint: `sha256:${hex}`,
    name: `${repo}/${path}`.slice(0, 80),
    sourceUrl: `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`,
    verdict: (counts.high ? "flagged" : counts.medium ? "caution" : "clear") as "flagged" | "caution" | "clear",
    findings,
    counts,
    rulesVersion: file.meta.rules_version,
    bytes,
    public: counts.high + counts.medium === 0 || NAMED_AT_LAUNCH.has(repo),
    scans: 1,
    firstSeen: SEEDED_AT,
    lastSeen: SEEDED_AT,
  };
}

/** Loads the next `limit` rows of the launch scan. Returns how far it got; does nothing once done or in lean mode. */
export async function importSkillSeed(env: Env, limit = 1500) {
  if (await isLean(env)) return { skipped: "lean" };
  const at = Number((await env.KV.get(CURSOR_KEY)) ?? 0);
  const res = await env.ASSETS.fetch(new Request(`https://assets.local${SEED_PATH}`));
  if (!res.ok) return { error: `seed file ${res.status}` };
  const file = (await res.json()) as SeedFile;
  const held = heldFile as unknown as SeedFile;
  const all = [...file.rows.map((r) => [file, r] as const), ...held.rows.map((r) => [held, r] as const)];
  if (at >= all.length) return { done: true, total: all.length };
  const slice = all.slice(at, at + limit).map(([f, r]) => seedRow(f, r));
  const db = getDb(env);
  const statements = [];
  for (let i = 0; i < slice.length; i += PER_STATEMENT) statements.push(db.insert(t.skillScans).values(slice.slice(i, i + PER_STATEMENT)).onConflictDoNothing());
  if (statements.length) await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);
  const next = at + slice.length;
  await env.KV.put(CURSOR_KEY, String(next));
  return { loaded: slice.length, next, total: all.length };
}
