// Markdown for agents (agent readiness, Cloudflare's "Markdown for Agents" convention): a page requested with
// `Accept: text/markdown` (or `text/*` ahead of HTML) comes back as Markdown of its main content, which is far
// fewer tokens than the HTML. Our pages are server-rendered from our own templates, so a small converter for the
// tags we use is enough. Browsers send `text/html` first and keep getting HTML.

type Range = { type: string; q: number; i: number };

function ranges(accept: string): Range[] {
  return accept
    .split(",")
    .map((part, i) => {
      const [type = "", ...params] = part.trim().toLowerCase().split(";");
      const q = Number(params.map((p) => p.trim()).find((p) => p.startsWith("q="))?.slice(2) ?? 1);
      return { type: type.trim(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((r) => r.type);
}

/** The most specific range matching `type` (exact, then `text/*`, then `*\/*`), or null. */
function match(rs: Range[], type: string) {
  const [major] = type.split("/");
  const rank = (r: Range) => (r.type === type ? 3 : r.type === `${major}/*` ? 2 : r.type === "*/*" ? 1 : 0);
  return rs.filter((r) => rank(r) > 0).sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/**
 * True when the client prefers Markdown to HTML: a higher q, or the same q with Markdown named more specifically or
 * earlier. `*\/*` alone (what most tools send) stays HTML, and so does `text/html, text/markdown`.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  const rs = ranges(accept ?? "");
  const md = match(rs, "text/markdown");
  if (!md || md.q <= 0 || md.type === "*/*") return false;
  const html = match(rs, "text/html");
  if (!html || md.q > html.q) return true;
  if (md.q < html.q) return false;
  if (html.type === "text/html" && md.type !== "text/markdown") return false;
  return md.type === "text/markdown" && html.type !== "text/html" ? true : md.i <= html.i;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", rarr: "→", larr: "←", middot: "·", mdash: "—", ndash: "–", hellip: "…" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#") && k !== "#39") return String.fromCodePoint(Number(k.slice(1)));
    return ENTITIES[k] ?? m;
  });
const inline = (s: string) => decode(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Markdown of a page's <main> (or <body>), with a front-matter title and source URL. */
export function htmlToMarkdown(html: string, url: string): string {
  const title = inline(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const description = decode(/<meta name="description" content="([^"]*)"/i.exec(html)?.[1] ?? "");
  let s = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
  // Things with no meaning as text.
  s = s.replace(/<(script|style|svg|noscript|form|button|template|iframe|canvas|video|audio|nav)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(div|section|span|li|p|td|th|tr|ul|ol)\b[^>]*\bhidden\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Code first, so nothing inside it is rewritten.
  const blocks: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, b: string) => {
    blocks.push("```\n" + decode(b.replace(/<[^>]+>/g, "")).trim() + "\n```");
    return `\n\n@@BLOCK${blocks.length - 1}@@\n\n`;
  });
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, c: string) => "`" + inline(c) + "`");
  // Links, made absolute (also inside table cells, so a table's replay and source links survive).
  const ANCHOR = /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const link = (_: string, href: string, text: string) => {
    const t = inline(text);
    if (!t) return "";
    let abs = decode(href);
    try {
      abs = new URL(abs, url).toString();
    } catch {
      /* keep as written */
    }
    return `[${t}](${abs})`;
  };
  // Tables: one row per line, a separator after the first.
  s = s.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, t: string) => {
    const rows = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inline(c[1]!.replace(ANCHOR, link)).replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return `\n\n${[line(rows[0]!), `|${" --- |".repeat(w)}`, ...rows.slice(1).map(line)].join("\n")}\n\n`;
  });
  s = s.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_, a: string) => (a ? `[image: ${decode(a)}]` : ""));
  s = s.replace(ANCHOR, link);
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${inline(t)}\n\n`);
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t: string) => (inline(t) ? `**${inline(t)}**` : ""));
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t: string) => (inline(t) ? `_${inline(t)}_` : ""));
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, q: string) => `\n\n> ${inline(q)}\n\n`);
  s = s.replace(/<\/?(p|div|section|article|aside|header|footer|ul|ol|dl|dt|dd|figure|figcaption|details|summary)\b[^>]*>/gi, "\n\n");
  s = decode(s.replace(/<[^>]+>/g, ""));
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .map((l) => (/^\s*- /.test(l) ? l.trim() : l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/@@BLOCK(\d+)@@/g, (_, i: string) => blocks[Number(i)] ?? "")
    .trim();
  const front = ["---", `title: ${JSON.stringify(title)}`, ...(description ? [`description: ${JSON.stringify(description)}`] : []), `url: ${url}`, "---"].join("\n");
  return `${front}\n\n${s}\n`;
}

/** Our content-use preferences, the same as robots.txt. */
export const CONTENT_SIGNAL = "search=yes, ai-input=yes, ai-train=no";

/** The Markdown version of an HTML response; status, caching and security headers are kept. */
export async function markdownResponse(res: Response, url: string): Promise<Response> {
  const md = htmlToMarkdown(await res.text(), url);
  const headers = new Headers(res.headers);
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("Vary", "Accept");
  headers.set("Content-Signal", CONTENT_SIGNAL);
  headers.set("X-Markdown-Tokens", String(Math.ceil(md.length / 4)));
  for (const h of ["Content-Length", "ETag", "Last-Modified", "Content-Encoding"]) headers.delete(h);
  return new Response(md, { status: res.status, headers });
}
