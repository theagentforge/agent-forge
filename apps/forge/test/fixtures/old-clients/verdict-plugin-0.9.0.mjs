// Copied unchanged from the released plugin 0.9.0 (f6704c6:integrations/claude-code-plugin/release/forge-full/hooks/
// pre-install.mjs, lines 7-62): the verdict code installed clients run today. Used only by test/old-clients.test.ts.
// Do not update it: it stands for clients we can't update.
// ../../packages/shared/src/scoring.ts
var DAY_MS = 864e5;
var SCORE_WINDOW_MS = 180 * DAY_MS;
var FLAG_WINDOW_MS = 30 * DAY_MS;
var MIN_OWNERS_FOR_SCORE = 5;

// ../../packages/shared/src/verdict.ts
var advisoryIdOf = (c) => c.public_signals_summary?.advisories.find((a) => a.kind === "malicious")?.id ?? c.public_signals_summary?.advisories[0]?.id ?? null;
var PUNCH = {
  clear: "[F\u2713]",
  caution: "[F!]",
  flagged: "[F\u2691]",
  confirmed_malicious: "[F\u2715]",
  insufficient: "[F\u2013]"
};
var VERDICT_WORD = {
  clear: "clear",
  caution: "caution",
  flagged: "flagged",
  confirmed_malicious: "confirmed malicious",
  insufficient: "not enough reports yet"
};
function displayVerdict(c) {
  if (c.security_status === "unknown") return "insufficient";
  if (c.security_status !== "clear") return c.security_status;
  return c.forge_score === null ? "insufficient" : "clear";
}
var plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function verdictLine(c) {
  const v = displayVerdict(c);
  const subject = c.tool ? `${c.tool.id}${c.version ? `@${c.version}` : ""}` : "unknown tool";
  const advisory = advisoryIdOf(c);
  if (advisory && (v === "flagged" || v === "caution") && (!c.known || c.verified_owners === 0))
    return [PUNCH[v], v, `published advisory ${advisory}`, subject, ...c.page_url ? [c.page_url.replace(/^https?:\/\//, "")] : []].join(" \xB7 ");
  if (!c.known) return [PUNCH.insufficient, "not enough reports yet (0 of 5)", subject, "no field reports yet"].join(" \xB7 ");
  const parts = [PUNCH[v]];
  switch (v) {
    case "clear":
      parts.push("clear", `Forge Score ${c.forge_score}`, plural(c.distinct_owners, "independent agent"), subject);
      break;
    case "insufficient":
      parts.push(`not enough reports yet (${Math.min(c.distinct_owners, MIN_OWNERS_FOR_SCORE)} of ${MIN_OWNERS_FOR_SCORE})`, subject);
      break;
    case "caution":
      parts.push("caution", "security report under review", subject);
      break;
    case "flagged":
      parts.push("flagged", `${plural(c.verified_owners, "independent verified agent")} reported a security issue`, subject);
      break;
    case "confirmed_malicious":
      parts.push("confirmed malicious", subject);
      break;
  }
  if (c.page_url) parts.push(c.page_url.replace(/^https?:\/\//, ""));
  return parts.join(" \xB7 ");
}
export { displayVerdict, verdictLine };
