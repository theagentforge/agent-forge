import { MIN_OWNERS_FOR_SCORE, type CheckVerdict } from "./scoring";

// The verdict strings shared by the website, the CLI and the plugin hook (docs/BRAND.md §5.5, §10).

export type DisplayVerdict = CheckVerdict | "insufficient";

export interface VerdictInput {
  known: boolean;
  tool: { id: string } | null;
  version: string | null;
  forge_score: number | null;
  distinct_owners: number;
  verified_owners: number;
  security_status: CheckVerdict;
  page_url: string | null;
}

export const PUNCH: Record<DisplayVerdict, string> = {
  clear: "[F✓]",
  caution: "[F!]",
  flagged: "[F⚑]",
  confirmed_malicious: "[F✕]",
  insufficient: "[F–]",
};

export const VERDICT_WORD: Record<DisplayVerdict, string> = {
  clear: "clear",
  caution: "caution",
  flagged: "flagged",
  confirmed_malicious: "confirmed malicious",
  insufficient: "not enough reports yet",
};

/** "Clear" is only shown once there is a score; before that the honest answer is "not enough reports". */
export function displayVerdict(c: Pick<VerdictInput, "security_status" | "forge_score">): DisplayVerdict {
  if (c.security_status !== "clear") return c.security_status;
  return c.forge_score === null ? "insufficient" : "clear";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function verdictLine(c: VerdictInput): string {
  const v = displayVerdict(c);
  const subject = c.tool ? `${c.tool.id}${c.version ? `@${c.version}` : ""}` : "unknown tool";
  if (!c.known) return [PUNCH.insufficient, "not enough reports yet (0 of 5)", subject, "no field reports yet"].join(" · ");
  const parts: string[] = [PUNCH[v]];
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
  return parts.join(" · ");
}
