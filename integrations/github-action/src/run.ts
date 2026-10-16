import { displayVerdict, verdictLine, VERDICT_WORD, PUNCH, type DisplayVerdict, type VerdictInput } from "@forge/shared/light";
import { DEFAULT_CONFIGS, dedupe, parseJsonc, serversIn, toolTarget, type Found, type Skipped } from "./discover";

// The forge-check action (ADR 0011 d): checks the MCP servers and tools a repository configures, writes a job
// summary, and fails the job when one is flagged. Read-only: it never sends anything about the repository except
// the tool ids it checks.

export const MAX_TOOLS = 40;
export const DEFAULT_ORIGIN = "https://theagentforge.io";
export const FAIL_ON = ["flagged", "caution", "never"] as const;
export type FailOn = (typeof FAIL_ON)[number];

export interface Inputs {
  tools: string[];
  configs: string[];
  failOn: FailOn;
  failOnError: boolean;
  origin: string;
}

export interface Io {
  readFile: (path: string) => string | null;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  log: (s: string) => void;
  /** Writes a GitHub workflow command (::error:: etc.). */
  command: (s: string) => void;
  summary: (markdown: string) => void;
  output: (name: string, value: string) => void;
}

export interface Checked extends Found {
  verdict: DisplayVerdict | "error";
  line: string;
  pageUrl: string | null;
}

/** Reads `INPUT_*` variables the way GitHub passes action inputs. */
export function readInputs(env: Record<string, string | undefined>): Inputs | string {
  const get = (name: string) => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
  const lines = (v: string) => v.split(/[\n,]/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  const failOn = (get("fail-on") || "flagged") as FailOn;
  if (!FAIL_ON.includes(failOn)) return `fail-on must be one of ${FAIL_ON.join(", ")}`;
  const origin = (get("origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return "origin must be an https:// address";
  const configs = get("config-files");
  return {
    tools: lines(get("tools")),
    configs: configs ? lines(configs) : DEFAULT_CONFIGS,
    failOn,
    failOnError: /^true$/i.test(get("fail-on-error")),
    origin,
  };
}

function blocks(v: Checked["verdict"], failOn: FailOn) {
  if (failOn === "never") return false;
  if (v === "flagged" || v === "confirmed_malicious") return true;
  return failOn === "caution" && v === "caution";
}

async function checkOne(q: Found["query"], inputs: Inputs, io: Io): Promise<VerdictInput & { page_url: string | null }> {
  const url = `${inputs.origin}/api/v1/check?${new URLSearchParams(q)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await io.fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "theagentforge-action/1" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429 && attempt < 2) {
      await io.sleep(Math.min(Number(res.headers.get("Retry-After")) || 30, 60) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`The Forge answered ${res.status}`);
    return (await res.json()) as VerdictInput;
  }
}

const label = (q: Found["query"]) => ("id" in q ? q.id : q.url);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function summaryMarkdown(checked: Checked[], skipped: Skipped[], failOn: FailOn, origin: string): string {
  const out = ["## Forge check", ""];
  if (!checked.length) out.push("No MCP servers or tools found to check. List them with the `tools` input, or point `config-files` at your MCP config.", "");
  else {
    out.push("| | Tool | Verdict | Configured in |", "|---|---|---|---|");
    for (const c of checked) {
      const name = c.pageUrl ? `[${cell(label(c.query))}](${c.pageUrl})` : `\`${cell(label(c.query))}\``;
      const word = c.verdict === "error" ? "check failed" : VERDICT_WORD[c.verdict];
      const mark = c.verdict === "error" ? "⚠️" : PUNCH[c.verdict];
      out.push(`| ${mark} | ${name} | ${cell(word)} | ${cell(c.source)} |`);
    }
    out.push("");
  }
  if (skipped.length) {
    out.push("<details><summary>Not checked (" + skipped.length + ")</summary>", "");
    for (const s of skipped) out.push(`- ${cell(s.source)}: ${s.reason}`);
    out.push("", "</details>", "");
  }
  const rule = failOn === "never" ? "This job never fails on a verdict." : failOn === "caution" ? "This job fails on flagged, confirmed malicious, or under review." : "This job fails on flagged or confirmed malicious.";
  out.push(`${rule} Verdicts come from field reports by human-verified agents: ${origin}/methodology`);
  return out.join("\n") + "\n";
}

export async function run(inputs: Inputs, io: Io): Promise<number> {
  const found: Found[] = [];
  const skipped: Skipped[] = [];
  for (const file of inputs.configs) {
    const text = io.readFile(file);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch {
      skipped.push({ source: file, reason: "not valid JSON" });
      continue;
    }
    const r = serversIn(file, parsed);
    found.push(...r.found);
    skipped.push(...r.skipped);
  }
  for (const t of inputs.tools) {
    const q = toolTarget(t);
    if (q) found.push({ query: q, source: "tools input" });
  }
  let targets = dedupe(found);
  if (targets.length > MAX_TOOLS) {
    for (const t of targets.slice(MAX_TOOLS)) skipped.push({ source: t.source, reason: `over the ${MAX_TOOLS}-tool limit per run` });
    targets = targets.slice(0, MAX_TOOLS);
  }

  const checked: Checked[] = [];
  for (const t of targets) {
    try {
      const c = await checkOne(t.query, inputs, io);
      const line = verdictLine({ ...c, tool: c.tool ?? { id: label(t.query) } });
      checked.push({ ...t, verdict: displayVerdict(c), line, pageUrl: c.page_url });
      io.log(line);
    } catch (e) {
      checked.push({ ...t, verdict: "error", line: `${label(t.query)}: ${(e as Error).message}`, pageUrl: null });
      io.command(`::warning title=Forge check failed::${label(t.query)}: ${(e as Error).message}`);
    }
  }

  const blocked = checked.filter((c) => blocks(c.verdict, inputs.failOn));
  for (const b of blocked) io.command(`::error title=Forge: ${b.verdict === "error" ? "error" : VERDICT_WORD[b.verdict]}::${b.line} (${b.source})`);
  io.summary(summaryMarkdown(checked, skipped, inputs.failOn, inputs.origin));
  io.output("checked", String(checked.length));
  io.output("blocked", blocked.map((b) => label(b.query)).join(","));
  const errors = checked.some((c) => c.verdict === "error");
  if (!checked.length) io.log("No MCP servers or tools found to check.");
  if (blocked.length) return 1;
  return errors && inputs.failOnError ? 1 : 0;
}
