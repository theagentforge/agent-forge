import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { LLMS_FULL_PAGES, llmsFullText } from "../src/web/llms-full";
import { fetchWorker } from "./helpers";
import "../src/index";

// Build list 4 Nov, item 10: /llms-full.txt and schema.org JSON-LD on /arena, /benchmark and /connect.

const ldOf = (html: string) => {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null;
};

const usage = async (key: string) =>
  ((await env.DB.prepare("SELECT coalesce(sum(n),0) n FROM usage_daily WHERE key = ?").bind(key).first<{ n: number }>())?.n ?? 0);

describe("/llms-full.txt", () => {
  it("every page it includes renders on its own", async () => {
    for (const path of LLMS_FULL_PAGES) {
      const res = await fetchWorker(path, { headers: { Accept: "text/markdown" } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type"), path).toMatch(/^text\/markdown/);
    }
  });

  it("is llms.txt, then each core page as Markdown with its source, as plain text open to any origin", async () => {
    const res = await fetchWorker("/llms-full.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toMatch(/^public, max-age=\d+/);
    const text = await res.text();
    expect(text.startsWith("# The Agent Forge")).toBe(true);
    expect(text).toContain("# Full pages");
    for (const path of LLMS_FULL_PAGES) expect(text, path).toContain(`Source: ${env.PUBLIC_ORIGIN}${path}\n`);
    // Markdown, not HTML: no tags or scripts leak through.
    expect(text).not.toMatch(/<script|<main|<nav/i);
    // Front matter is dropped (each page becomes a ## section instead).
    expect(text).not.toMatch(/^---\ntitle: "/m);
  });

  it("leaves out a page that fails, never the whole file", async () => {
    const text = await llmsFullText("https://x.test", "# Head", async (req) =>
      new URL(req.url).pathname === "/about"
        ? new Response("---\ntitle: \"About · The Agent Forge\"\nurl: https://x.test/about\n---\n\n# About\n\nHello.\n", { headers: { "Content-Type": "text/markdown; charset=utf-8" } })
        : new Response("down", { status: 500 }),
    );
    expect(text).toContain("## About · The Agent Forge\n\nSource: https://x.test/about\n\n# About\n\nHello.");
    expect(text.match(/^Source: /gm)?.length).toBe(1);
  });

  it("asks for each page as Markdown, tagged as our own traffic, so the pages it reads add no visits", async () => {
    const seen: Request[] = [];
    await llmsFullText("https://x.test", "# Head", async (req) => {
      seen.push(req);
      return new Response("", { status: 404 });
    });
    expect(seen).toHaveLength(LLMS_FULL_PAGES.length);
    for (const r of seen) {
      expect(r.headers.get("Accept")).toBe("text/markdown");
      expect(r.headers.get("X-Forge-Internal")).toBe("llms");
    }
  });

  it("counts an agent's fetch as discovery, and our own as ours", async () => {
    const before = await usage("disc:llms-full");
    await (await fetchWorker("/llms-full.txt", { headers: { "User-Agent": "ClaudeBot/1.0" } })).text();
    expect(await usage("disc:llms-full")).toBe(before + 1);
    const oursBefore = await usage("internal:scout:fetches");
    await (await fetchWorker("/llms-full.txt", { headers: { "X-Forge-Internal": "scout" } })).text();
    expect(await usage("disc:llms-full")).toBe(before + 1);
    expect(await usage("internal:scout:fetches")).toBe(oursBefore + 1);
  });

  it("is named in llms.txt and answers a CORS preflight", async () => {
    expect(await (await fetchWorker("/llms.txt")).text()).toContain("/llms-full.txt");
    const pre = await fetchWorker("/llms-full.txt", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("JSON-LD on the pages indexers cite", () => {
  it("/arena is a Dataset with its JSON file, licence and Croissant metadata", async () => {
    const ld = ldOf(await (await fetchWorker("/arena")).text());
    expect(ld?.["@type"]).toBe("Dataset");
    expect(ld?.url).toBe(`${env.PUBLIC_ORIGIN}/arena`);
    expect(JSON.stringify(ld)).toContain(`${env.PUBLIC_ORIGIN}/arena/dataset.json`);
    expect(JSON.stringify(ld)).toContain(`${env.PUBLIC_ORIGIN}/arena/croissant.json`);
    expect(ld?.license).toBeTruthy();
  });

  it("/benchmark is a versioned, citable Dataset", async () => {
    const ld = ldOf(await (await fetchWorker("/benchmark")).text());
    expect(ld?.["@type"]).toBe("Dataset");
    expect(ld?.version).toMatch(/^\d+\.\d+/);
    expect(String(ld?.citation)).toContain("The Agent Forge");
    expect((ld?.distribution as unknown[]).length).toBe(2);
  });

  it("/connect describes the API and the CLI, free, with no ratings or reviews", async () => {
    const ld = ldOf(await (await fetchWorker("/connect")).text());
    const graph = ld?.["@graph"] as { "@type": string; softwareVersion?: string }[];
    expect(graph.map((g) => g["@type"])).toEqual(["WebAPI", "SoftwareApplication"]);
    expect(graph[1]!.softwareVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|review/i);
  });
});
