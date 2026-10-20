// The weekly "cited in AI search" check (docs/launch/agent-channels.md §4.5 and §6): ten fixed "is <popular skill or
// MCP server> safe?" questions, asked of a Claude, a GPT and a Perplexity model with web search through OpenRouter.
// For each answer it records whether theagentforge.io is cited (in the citations or the text). The questions are
// fixed so the score moves only when the web does. Spend shares the ops daily cap with the tool-selection test.

export const CITATION_QUESTIONS = [
  "Is the Anthropic pdf skill (anthropics/skills) safe to install in Claude Code?",
  "Is the official GitHub MCP server safe to connect to my coding agent?",
  "Is the Playwright MCP server safe to give my agent?",
  "Is the Context7 MCP server (upstash/context7) safe to install?",
  "Is the MCP filesystem server (@modelcontextprotocol/server-filesystem) safe to use?",
  "Are agent skills from ClawHub safe to install? How can I check one first?",
  "How do I check an agent skill (SKILL.md) for prompt injection before installing it?",
  "Is the Notion MCP server safe to connect to Claude?",
  "Which AI models fall for fake invoices when paying bills as an agent?",
  "Is it safe to let an AI agent process customer refunds? Which models break refund policy?",
];

export const CITATION_MODELS = [
  { key: "claude", model: "anthropic/claude-sonnet-5.5:online" },
  { key: "gpt", model: "openai/gpt-6.1-sol:online" },
  { key: "perplexity", model: "perplexity/sonar" },
] as const;

/** theagentforge.io or www.theagentforge.io, not a lookalike such as notheagentforge.io or theagentforge.io.evil.com. */
const OURS = /(?<![a-z0-9.-])(www\.)?theagentforge\.io(?![a-z0-9-]|\.[a-z])/i;

/** The URLs an OpenRouter reply cites: web-plugin annotations, or Perplexity's citations list. */
export function citedUrls(body: unknown): string[] {
  const b = body as { citations?: unknown; choices?: { message?: { annotations?: { url_citation?: { url?: unknown } }[] } }[] };
  const fromAnnotations = (b?.choices?.[0]?.message?.annotations ?? []).map((a) => a?.url_citation?.url).filter((u): u is string => typeof u === "string");
  const fromList = Array.isArray(b?.citations) ? b.citations.filter((u): u is string => typeof u === "string") : [];
  return [...new Set([...fromAnnotations, ...fromList])];
}

export function wasCited(body: unknown): boolean {
  const text = (body as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
  return citedUrls(body).some((u) => OURS.test(u)) || (typeof text === "string" && OURS.test(text));
}

export interface CitationRow {
  i: number;
  cited: boolean | null;
  urls: number;
}

/** Asks questions [from, to) of one model. `cited` is null when the call failed. */
export async function runCitations(env: { OPENROUTER_API_KEY?: string }, key: string, from: number, to: number, fetcher: typeof fetch = fetch) {
  const m = CITATION_MODELS.find((x) => x.key === key);
  if (!m || !env.OPENROUTER_API_KEY) throw new Error("unknown_model_or_no_key");
  const rows: CitationRow[] = [];
  let cost = 0;
  for (let i = Math.max(0, from); i < Math.min(to, CITATION_QUESTIONS.length); i++) {
    try {
      const res = await fetcher("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "HTTP-Referer": "https://theagentforge.io", "X-Title": "The Agent Forge citation check" },
        body: JSON.stringify({ model: m.model, messages: [{ role: "user", content: CITATION_QUESTIONS[i] }], temperature: 0, max_tokens: 700, provider: { data_collection: "deny" }, usage: { include: true } }),
      });
      const body = (await res.json().catch(() => null)) as { usage?: { cost?: number } } | null;
      cost += Number(body?.usage?.cost ?? 0);
      rows.push(res.ok && body ? { i, cited: wasCited(body), urls: citedUrls(body).length } : { i, cited: null, urls: 0 });
    } catch {
      rows.push({ i, cited: null, urls: 0 });
    }
  }
  return { model: key, rows, cost: Math.round(cost * 10_000) / 10_000 };
}
