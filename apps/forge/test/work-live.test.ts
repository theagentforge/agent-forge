import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { workTotals, WORK_LABELS } from "../src/services/site-pulse";
import { connectAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

// ADR 0034: the home page's "work done" row. Real totals from the database, each with when it last happened, refreshed
// live; nothing interpolated or seeded, and never a zero.

describe("work done on the home page (ADR 0034)", () => {
  it("counts real rows, gives their latest times, and shows each with its label and an ago time", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "safe" } as never);
    const { token } = await connectAgent({ profile: profile({ id: 990034, login: "pulse-owner" }) });
    const before = Date.now();
    expect((await postReport(token, report({ tool: { kind: "mcp_server", id: "npm:pulse-check", version: "1.0.0", fingerprint: fp("c") } }))).status).toBe(201);

    const w = await workTotals(env);
    expect(w.field_reports).toBeGreaterThanOrEqual(1);
    expect(w.tools_tracked).toBeGreaterThanOrEqual(1);
    expect(w.last_report_at).toBeGreaterThanOrEqual(before);
    // Nothing is ever a zero: an empty total is null, and the page leaves it out.
    for (const [k] of WORK_LABELS) expect(w[k] === null || (w[k] as number) > 0).toBe(true);

    const body = await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();
    expect(body).toContain("data-work-live");
    expect(body).toMatch(/<b>[\d,]+<\/b><span>field reports filed<\/span>/);
    expect(body).toMatch(/last field report <time data-ago="\d+" data-ago-k="last_report_at" datetime="[^"]+">\d+ min ago<\/time>/);
    expect(body).not.toContain("in 24 h");
    expect(body).toMatch(/<span data-k-inline="tools_tracked">[\d,]+<\/span> tools tracked/);
    expect(body).toContain("<b>Counts include our test agents, uptime checks and crawlers.</b>");

    expect(body).not.toMatch(/<b>0<\/b>/);
    expect(body).not.toContain("AI models ranked");
    // One band, not two: the agent numbers sit in the same block.
    expect(body.match(/data-agent-live/g)?.length).toBe(1);
    expect(body).toMatch(/data-work-live data-agent-live/);
  });

  it("serves the same totals live, from the edge cache for 30 seconds", async () => {
    const a = (await (await fetchWorker("/agents/live.json")).json()) as { work: Record<string, number | null>; generated_at: string };
    expect(a.work.field_reports).toBeGreaterThanOrEqual(1);
    expect(typeof a.work.last_report_at).toBe("number");
    const b = (await (await fetchWorker("/agents/live.json")).json()) as { generated_at: string };
    expect(b.generated_at).toBe(a.generated_at);
  });

  it("counts up from zero on load only in the browser, with the real number in the HTML and the safeguards in place", () => {
    const js = Object.values(import.meta.glob("../public/site.js", { query: "?raw", import: "default", eager: true }))[0] as string;
    const count = js.slice(js.indexOf("ADR 0034 amendment 2"));
    expect(count).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(count).toContain('sr.className = "sr-only"');
    expect(count).toContain('b.setAttribute("aria-hidden", "true")');
    expect(count).toContain("b.style.minWidth");
    expect(count).toContain("ms = 1200");
  });
});
