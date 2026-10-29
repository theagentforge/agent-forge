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

    // The same totals are on /stats, each with its rule.
    const stats = await (await fetchWorker(`/stats?u=${Date.now()}`, { headers: { Accept: "text/html" } })).text();
    expect(stats).toMatch(/<td>Field reports filed \(<a href="\/methodology#house-install-tests">most are our House agent&#39;s nightly install tests<\/a>\)<\/td><td class="num">[\d,]+<\/td>/);
    expect(stats).toMatch(/<td>Tools with a page[^<]*<\/td><td class="num">[\d,]+<\/td>/);
    const body = await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();
    // ADR 0067 Amendment 1 (Dinike, 28 Oct): the home band shows these totals again and is refreshed live from
    // /agents/live.json, whose numbers are the same totals (House included), so a refresh can't change what a label means.
    expect(body).toContain("data-work-live");
    expect(body).toContain("data-agent-live");
    expect(body).not.toContain("data-headline-live");
    // Site audit 29 Oct: a stat strip; the per-number qualifiers are footnote markers, their notes under the strip.
    for (const [k, label] of WORK_LABELS) {
      if (w[k] === null) continue;
      const shown = k === "field_reports" ? "field reports filed" : label;
      expect(body).toMatch(new RegExp(`<li data-k="${k}"><b>[\\d,]+</b><span>${shown}(<sup class="fn">.*?</sup>)?</span></li>`));
    }
    expect(body).toContain('<a href="/methodology#house-install-tests">Mostly our House install tests</a>');
    // Dinike, 29 Oct: tools tracked is a headline number, last in the top row, and no longer repeated in the footnote.
    // Review ADR 0115: with PyPI name matches in it, the number carries what it is beside it, linked to its rule.
    expect(body).toMatch(/<li data-k="tools_tracked"><b>[\d,]+<\/b><span>tools tracked<sup class="fn"><a href="#fn-tools"[^<]*>‡<\/a><\/sup><\/span><\/li><\/ul>/);
    expect(body).toContain('<a href="/stats/rules#tools_tracked">Registry listings, not reviewed</a>');
    expect(body).not.toContain("data-k-inline");
    expect(body.match(/tools tracked/g)?.length).toBe(1);
    expect(body).toMatch(/data-ago-k="last_report_at"/);
    expect(body).toContain("Includes the Forge's own test agents");
    expect(body).not.toMatch(/<b>0<\/b>/);
    expect(body).not.toContain("AI models ranked");
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
    // The live refresh (re-reading /agents/live.json) touches the [data-work-live] and [data-agent-live] band, and the
    // count-up runs on the same band.
    const refresh = js.slice(js.indexOf("ADR 0030 agent numbers"), js.indexOf("ADR 0034 amendment 2"));
    expect(refresh).toContain('querySelector("[data-work-live]")');
    expect(refresh).toContain('querySelector("[data-agent-live]")');
    expect(count).toContain('querySelector("[data-work-live]")');
    expect(count).not.toContain("data-headline-live");
  });
});
