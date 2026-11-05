// Build list 4 Nov, item 10: /llms-full.txt, the llmstxt.org companion file. It holds llms.txt, then the Markdown of the
// pages an agent needs to understand us in one read: what we are, how results are made, the latest Hard event, the
// benchmark, the security overview and how to connect. Each page is rendered in-process (no network) through the same
// Markdown converter as `Accept: text/markdown`, tagged as ours so it adds no visit. The file is edge-cached for 6 hours.
import { CONTENT_SIGNAL } from "./markdown";
import { INTERNAL_HEADER } from "../services/internal";
import { aiAgentCounters, bump, discoveryCounters } from "../services/usage";

export const LLMS_FULL_PATH = "/llms-full.txt";
const CACHE_SECONDS = 6 * 3600;

/** The pages in the file, in reading order. */
export const LLMS_FULL_PAGES = [
  "/about",
  "/methodology",
  "/arena?tier=hard",
  "/benchmark",
  "/arena/rules",
  "/results-policy",
  "/security",
  "/scan/rules",
  "/gauntlet",
  "/connect",
] as const;

type InProcess = (req: Request) => Promise<Response>;

/** Drops a page's front matter and returns its title and body. */
function splitFront(md: string): { title: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n*/.exec(md);
  if (!m) return { title: "", body: md.trim() };
  const title = /^title: (".*")$/m.exec(m[1]!)?.[1];
  let t = "";
  try {
    t = title ? (JSON.parse(title) as string) : "";
  } catch {
    t = "";
  }
  return { title: t, body: md.slice(m[0].length).trim() };
}

/** The file's text: llms.txt, then one section per page that rendered (a page that fails is left out, never an error). */
export async function llmsFullText(origin: string, llmsTxt: string, fetchPage: InProcess): Promise<string> {
  const pages = await Promise.all(
    LLMS_FULL_PAGES.map(async (path) => {
      try {
        const res = await fetchPage(new Request(`${origin}${path}`, { headers: { Accept: "text/markdown", [INTERNAL_HEADER]: "llms" } }));
        if (res.status !== 200 || !(res.headers.get("Content-Type") ?? "").startsWith("text/markdown")) return null;
        const { title, body } = splitFront(await res.text());
        return `## ${title || path}\n\nSource: ${origin}${path}\n\n${body}`;
      } catch {
        return null;
      }
    }),
  );
  return [llmsTxt.trim(), "# Full pages", ...pages.filter((p): p is string => p !== null)].join("\n\n---\n\n") + "\n";
}

/** GET /llms-full.txt. */
export async function serveLlmsFull(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, req: Request, fetchPage: InProcess): Promise<Response> {
  const origin = env.PUBLIC_ORIGIN;
  // Counted like the other discovery files (the site middleware doesn't run for this route): AI agents, then the file.
  const counters = [...aiAgentCounters(req), ...discoveryCounters(req)];
  if (counters.length) ctx.waitUntil(bump(env, counters).catch(() => {}));
  const key = new Request(`${origin}${LLMS_FULL_PATH}`, { method: "GET" });
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const llms = await env.ASSETS.fetch(new Request(`${origin}/llms.txt`, { headers: { Accept: "text/plain" } }));
  const text = await llmsFullText(origin, llms.ok ? await llms.text() : "# The Agent Forge", fetchPage);
  const res = new Response(req.method === "HEAD" ? null : text, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "Content-Signal": CONTENT_SIGNAL,
    },
  });
  if (req.method !== "HEAD") ctx.waitUntil(caches.default.put(key, res.clone()));
  return res;
}
