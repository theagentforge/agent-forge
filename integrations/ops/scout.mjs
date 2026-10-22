// Forge Scout checks for the Ops Digest (ADR 0031 "Alarms" and "Weekly"). Pure functions over GitHub issues, so the
// digest (digest.mjs) stays the one place Dinike reads. A green routine run isn't proof: these read what it wrote.
//
// Label conventions (docs/ops/scout-prompt.md): `brief`, `proposal`, `agent-reach`, `risk:*`; a person adds
// `approved` when they pick one, `shipped` when it's released, and `verdict:helped|hurt|inconclusive` after its window.

const DAY = 86_400_000;
const has = (i, name) => (i.labels ?? []).some((l) => (typeof l === "string" ? l : l.name) === name);
const at = (s) => new Date(s).getTime();
const ref = (i) => `#${i.number}`;
/** The `Topic: <slug>` line a proposal carries, lower-cased; null when there isn't one. */
export const topicOf = (body) => /^Topic:\s*([a-z0-9][a-z0-9-]{1,60})\s*$/im.exec(body ?? "")?.[1]?.toLowerCase() ?? null;

/** True when the Evidence (or Why) section has at least one link. */
export function hasEvidence(body) {
  const m = /^##\s*(Evidence|Why)\s*$([\s\S]*?)(^##\s|^---\s*$|$(?![\s\S]))/im.exec(body ?? "");
  return !!m && /https?:\/\/\S+/.test(m[2].replace(/<!--[\s\S]*?-->/g, ""));
}

/** Alarm lines for today; empty when all is well. `proposals` holds `proposal` and `agent-reach` issues (last 30+ days). */
export function scoutAlarms({ briefs = [], proposals = [], now = Date.now() }) {
  const out = [];
  const real = (xs) => xs.filter((i) => !i.pull_request);
  const b = real(briefs);
  const p = real(proposals);
  // Before the routine's first brief there's nothing to miss.
  if (b.length && !b.some((i) => now - at(i.created_at) <= 26 * 3_600_000))
    out.push(`No Improvement Brief in the last 26 hours (last one ${ref(b.sort((x, y) => at(y.created_at) - at(x.created_at))[0])}). Check the Forge Scout routine at claude.ai/code/routines.`);
  const today = p.filter((i) => now - at(i.created_at) <= DAY);
  if (today.length > 3) out.push(`${today.length} proposals in a day (limit 3): ${today.map(ref).join(", ")}.`);
  const reach = today.filter((i) => has(i, "agent-reach"));
  if (reach.length > 2) out.push(`${reach.length} Agent Reach issues in a day (limit 2): ${reach.map(ref).join(", ")}.`);
  const bare = today.filter((i) => !hasEvidence(i.body));
  if (bare.length) out.push(`Proposal without evidence links: ${bare.map(ref).join(", ")}.`);
  for (const i of today) {
    const topic = topicOf(i.body);
    if (!topic) {
      out.push(`Proposal ${ref(i)} has no Topic line, so repeats can't be caught.`);
      continue;
    }
    const before = p.find((o) => o.number !== i.number && topicOf(o.body) === topic && at(o.created_at) < at(i.created_at) && at(i.created_at) - at(o.created_at) <= 30 * DAY);
    if (before) out.push(`Topic "${topic}" re-proposed within 30 days: ${ref(i)} repeats ${ref(before)}.`);
  }
  return out;
}

/** The Monday numbers: proposals made, approved, shipped and closed in the last 7 days, and verdicts in the last 30. */
export function scoutWeekly({ proposals = [], now = Date.now() }) {
  const p = proposals.filter((i) => !i.pull_request);
  if (!p.length) return null;
  const week = (s) => s && now - at(s) <= 7 * DAY;
  const made = p.filter((i) => week(i.created_at)).length;
  const approved = p.filter((i) => has(i, "approved") && week(i.updated_at)).length;
  const shipped = p.filter((i) => has(i, "shipped") && week(i.closed_at)).length;
  const dropped = p.filter((i) => i.state === "closed" && !has(i, "shipped") && week(i.closed_at)).length;
  const month = p.filter((i) => now - at(i.created_at) <= 30 * DAY);
  const shippedMonth = month.filter((i) => has(i, "shipped")).length;
  const v = (k) => p.filter((i) => has(i, `verdict:${k}`) && i.closed_at && now - at(i.closed_at) <= 30 * DAY).length;
  return `Forge Scout this week: **${made}** proposals made, ${approved} approved, ${shipped} shipped, ${dropped} closed without building. Shipped **${shippedMonth} of ${month.length}** proposed in the last 30 days. Verdicts on shipped proposals (last 30 days): helped ${v("helped")}, hurt ${v("hurt")}, inconclusive ${v("inconclusive")}.`;
}

/** The digest section, or null when Scout hasn't written anything yet and nothing is wrong. */
export function scoutSection({ briefs = [], proposals = [], now = Date.now() }) {
  const alarms = scoutAlarms({ briefs, proposals, now });
  const weekly = new Date(now).getUTCDay() === 1 ? scoutWeekly({ proposals, now }) : null;
  if (!alarms.length && !weekly) return null;
  return [weekly, ...alarms.map((a) => `⚠️ Scout: ${a}`)].filter(Boolean).join("\n\n");
}
