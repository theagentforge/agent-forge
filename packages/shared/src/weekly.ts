import {
  checkChanges,
  checkMemo,
  receiptOf,
  sinceLine,
  splitCheckKey,
  watchChanges,
  watchLine,
  watchMemo,
  weeklyDue,
  weeklyLine,
  type CheckAnswerLike,
  type MemoryFile,
  type WatchItemLike,
} from "./since";

// The weekly pass shared by the Claude Code plugin (SessionStart, once a week) and the CLI (`forge watch`): installed
// skills' fingerprints go to POST /api/v1/watch (the REST twin of forge_watch: "needs a fresh scan", reported
// versions per fingerprint), and the tools this machine checked most recently are checked again. The answer is a list
// of data lines saying what changed since the last pass. Only fingerprints and tool ids are sent; skill names and the
// memory stay local.

export const WEEKLY_MAX_SKILLS = 50;
export const WEEKLY_MAX_RECHECKS = 8;

export interface LocalSkill {
  /** A local name for the summary (the folder or file name). Never sent. */
  label: string;
  text: string;
}

export interface WeeklyDeps {
  origin: string;
  fetch: typeof fetch;
  now: number;
  /** Updated in place when the pass runs. */
  memory: MemoryFile;
  skills: LocalSkill[];
  sha256Hex: (s: string) => string | Promise<string>;
  userAgent: string;
  timeoutMs?: number;
  /** Run even if the last pass was less than a week ago (the CLI's on-demand `forge watch`). */
  force?: boolean;
}

export interface WeeklyResult {
  lines: string[];
  /** How many watched skills are flagged now (the CLI exits 3 on any). */
  flagged: number;
  /** Re-checked tools whose answer is flagged or confirmed malicious now. */
  flaggedTools: number;
}

const short = (fp: string) => `${fp.slice(0, 19)}…`;

/** The pass, or null when it isn't due or the Forge couldn't be reached (callers try again next time). */
export async function weeklyCheck(d: WeeklyDeps): Promise<WeeklyResult | null> {
  if (!d.force && !weeklyDue(d.memory, d.now)) return null;
  const at = new Date(d.now).toISOString();
  const signal = AbortSignal.timeout(d.timeoutMs ?? 3500);
  const headers = { Accept: "application/json", "User-Agent": d.userAgent };

  const byFp = new Map<string, string>();
  for (const s of d.skills.slice(0, WEEKLY_MAX_SKILLS)) {
    const fp = `sha256:${await d.sha256Hex(s.text.replace(/\r\n?/g, "\n"))}`;
    if (!byFp.has(fp)) byFp.set(fp, s.label);
  }
  const watch = byFp.size
    ? await d
        .fetch(`${d.origin}/api/v1/watch`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ fingerprints: [...byFp.keys()] }), signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ rules_version: string; items: WatchItemLike[] }>) : null))
        .catch(() => null)
    : null;

  const recent = Object.entries(d.memory.checks)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, WEEKLY_MAX_RECHECKS);
  const rechecks = await Promise.all(
    recent.map(async ([key, prev]) => {
      const { id, version } = splitCheckKey(key);
      try {
        const res = await d.fetch(`${d.origin}/api/v1/check?${new URLSearchParams(version ? { id, version } : { id })}`, { headers, signal });
        if (!res.ok) return null;
        const check = (await res.json()) as CheckAnswerLike;
        if (typeof check?.security_status !== "string") return null;
        const next = checkMemo(check, at);
        d.memory.checks[key] = next;
        return { label: `${id}${version ? `@${version}` : ""}`, c: checkChanges(prev, next), receipt: receiptOf(check, d.origin), verdict: next.verdict };
      } catch {
        return null;
      }
    }),
  );
  const answered = rechecks.filter((r) => r !== null);
  if (!watch && !answered.length) return null;

  const lines: string[] = [];
  let flagged = 0;
  if (watch && Array.isArray(watch.items) && typeof watch.rules_version === "string") {
    const rows = watch.items.map((i) => {
      const next = watchMemo(i, at);
      const c = watchChanges(d.memory.watch[i.fingerprint], next);
      d.memory.watch[i.fingerprint] = next;
      return { i, next, c };
    });
    flagged = rows.filter((r) => r.next.verdict === "flagged").length;
    lines.push(weeklyLine(rows, watch.rules_version, d.memory.rules));
    for (const r of rows.filter((x) => x.c.changed || x.next.rescan || x.next.verdict === "flagged" || x.next.verdict === "caution").slice(0, 10))
      lines.push(`  ${watchLine(`${byFp.get(r.i.fingerprint) ?? "skill"} (${short(r.i.fingerprint)})`, r.next, r.c, watch.rules_version)}`);
    d.memory.rules = watch.rules_version;
  }
  if (answered.length) {
    const changed = answered.filter((r) => r.c?.changed);
    lines.push(`Forge weekly re-check: ${answered.length} recently checked tool${answered.length === 1 ? "" : "s"}, ${changed.length} changed`);
    for (const r of changed) lines.push(`  ${r.label}: ${sinceLine(r.c)}`, ...(r.receipt ? [`  receipt: ${r.receipt}`] : []));
  }
  d.memory.weekly_at = at;
  return { lines, flagged, flaggedTools: answered.filter((r) => r.verdict === "flagged" || r.verdict === "confirmed_malicious").length };
}
