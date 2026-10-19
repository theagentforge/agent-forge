import type { ScanFinding } from "@forge/shared";

// Scan findings in plain words, for share lines, page descriptions and the home page (no imports from pages.ts).

const VERB = /^(Reads|Uses|Collects|Sends|Posts|Uploads|Changes|Installs|Fetches|Re-fetches|Deletes|Turns|Asks)\b/;
const lowerFirst = (t: string) => (/^(PowerShell|[A-Z]{2,})\b/.test(t) ? t : t.charAt(0).toLowerCase() + t.slice(1));

/** "reads an agent's own key file and has a download piped straight into a shell": what the skill does, in words. */
export function patternPhrase(findings: ScanFinding[], max = 2) {
  const titles = [...new Set(findings.filter((f) => f.severity !== "low").map((f) => f.title))].slice(0, max);
  return titles.map((t) => (VERB.test(t) ? lowerFirst(t) : `has ${lowerFirst(t)}`)).join(" and ");
}

