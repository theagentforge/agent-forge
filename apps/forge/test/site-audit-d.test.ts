import { describe, expect, it } from "vitest";
import { AGENT_LINE } from "../src/web/agent-line";
import { dayRange } from "../src/web/dataset-spec";
import { ORIGIN, fetchWorker } from "./helpers";
import "../src/index";

// Site audit 29 Oct 2026, batch D (docs/strategy/site-audit-2026-10-29.md §3.4–§3.15): the trust, buyer and connect
// pages lead with their job, say each caveat once, and keep the rest one click down.

const get = async (path: string, ua?: string) => (await fetchWorker(path, { headers: { Accept: "text/html", ...(ua ? { "User-Agent": ua } : {}) } })).text();
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile Safari";
const main = (body: string) => body.slice(body.indexOf("<main"), body.indexOf("</main>"));

describe("site audit batch D", () => {
  it("/connect: the steps first, one short agent line, and the phone block as one line with checking one click down", async () => {
    const body = main(await get("/connect", PHONE));
    const lead = body.indexOf('class="lead"');
    const agent = body.indexOf("Already have an agent?");
    const phone = body.indexOf('id="phone-step"');
    const step1 = body.indexOf('id="first-step"');
    expect([lead, agent, phone, step1].every((i) => i > 0)).toBe(true);
    expect(lead < agent && agent < phone && phone < step1).toBe(true);
    expect(body).toContain("Check a package. Link your agent. Test it (optional).");
    expect(body.slice(agent, phone)).toContain(AGENT_LINE(ORIGIN));
    // The phone block: one line and the link to send; the scan and check forms are in a closed <details>.
    const block = body.slice(phone, step1);
    expect(block).toContain("On a phone? Send this page to yourself for later.");
    expect(block).toMatch(/<details class="more">[\s\S]*id="phone-scan"[\s\S]*id="phone-check"[\s\S]*<\/details>/);
    expect(block).not.toContain("eyebrow");
    // The copyable agent line is still in "More ways", so a copy there is counted as before.
    expect(body.slice(body.indexOf('id="more-ways"'))).toContain('<code id="send-agent">');
  });

  it("/teams: prices come before the request form, then how it stays honest; terms one click down, words unchanged", async () => {
    const body = await get("/teams");
    const at = ['id="pilots"', 'data-tier="check"', 'id="apply"', "How it stays honest"].map((m) => body.indexOf(m));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).toContain("Nothing is charged until a scope is signed.");
    expect(body).toMatch(/<details class="more"><summary><span class="more-title">Scope, deliverables, timeline and success criteria<\/span>/);
    expect(body).toContain("A pass is not a certificate that your agent is safe");
    // The one-pager prints the terms in full (a closed <details> would print empty).
    const print = await get("/teams?print=1");
    expect(print).not.toContain('<details class="more">');
    expect(print).toContain("<b>Success criteria.</b>");
  });

  it("/stats: one disclosure under the H1, plain headings, and the second table's header fixed", async () => {
    const body = main(await get("/stats"));
    expect(body.match(/class="disclosure"/g)?.length).toBe(1);
    expect(body.indexOf('class="disclosure"')).toBeLessThan(body.indexOf("<table"));
    expect(body).toContain('href="/stats/rules"');
    expect(body).toContain('<th scope="col">Measure</th>');
    expect(body).not.toContain('<th scope="col">Number</th><th scope="col" class="num">Number</th>');
    expect(body).not.toContain("our own test agents included</h2>");
  });

  it("/security: a short lead, and the long tables and methods one click down under visible headings", async () => {
    const body = main(await get("/security"));
    const lead = /<p class="lead">([^<]*)<\/p>/.exec(body)![1]!;
    expect(lead.split(/\s+/).length).toBeLessThanOrEqual(20);
    expect(body).toMatch(/<span class="more-title">What the rules look for<\/span><span class="more-hint">\d+ rules in \d+ families/);
    expect(body).toContain('<h2 id="protection">');
    expect(body).toContain("IDs start with <code>x_FORGE-</code>");
  });

  it("/about: two totals in one line with the honest line and the counting-rule link; first-look links grouped", async () => {
    const body = main(await get("/about"));
    for (const g of ["<b>Read:</b>", "<b>Verify:</b>", "<b>Results:</b>"]) expect(body).toContain(g);
    if (body.includes("<h2>Live numbers</h2>")) {
      const block = body.slice(body.indexOf("<h2>Live numbers</h2>"), body.indexOf('<h2 id="investors">'));
      expect(block).toMatch(/Includes The Forge(&#39;|')s own test agents\./);
      expect(block).toContain('href="/stats/rules"');
      expect(block).toContain('href="/stats"');
    }
  });

  it("/dataset: a 'what you get' box first, and nothing says the published sample is 'not published yet'", async () => {
    const body = main(await get("/dataset"));
    expect(body.indexOf('aria-label="What you get"')).toBeLessThan(body.indexOf('id="what"'));
    expect(body).not.toMatch(/not published yet/i);
    expect(body).toMatch(/<span id="kinds">Traps per kind<\/span>/);
    expect(dayRange("2026-10-16", "2026-10-28")).toBe("16–28 Oct 2026");
    expect(dayRange("2026-10-28", "2026-11-02")).toBe("28 Oct to 2 Nov 2026");
    expect(dayRange("2026-10-28", "2026-10-28")).toBe("28 Oct 2026");
  });

  it("/methodology: an 'On this page' list whose every link has its heading", async () => {
    const body = main(await get("/methodology"));
    const nav = body.slice(body.indexOf('aria-label="On this page"'), body.indexOf("</nav>"));
    const ids = [...nav.matchAll(/href="#([a-z-]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(10);
    for (const id of ids) expect(body, id).toContain(`<h2 id="${id}">`);
    expect(body).toContain('id="house-install-tests"');
  });

  it("/pricing: 'coming soon' sits inside the price, and the call and limit answers are a short FAQ", async () => {
    const body = main(await get("/pricing"));
    expect(body).not.toContain("(coming soon)");
    expect(body).toMatch(/<td data-label="Price"><span>US\$[^<]+ <span class="muted">· coming soon<\/span><\/span><\/td>/);
    for (const q of ["What counts as a call?", "What happens at the limit?", "How do payments work?"]) expect(body).toContain(`<span class="more-title">${q}</span>`);
  });

  it("/agents while closed: one line and one action", async () => {
    const body = main(await get("/agents"));
    expect(body).toContain("data-agent-index-closed");
    expect(body.match(/class="btn/g)?.length).toBe(1);
    expect(body).not.toContain("eyebrow");
  });
});

describe("home launch-scan line uses the report's own denominator (claim-verifier finding, 29 Oct)", () => {
  it("says 30 of 9,014 ordinary skills (0.33%), not 30 of 9,930", async () => {
    const { fetchWorker } = await import("./helpers");
    const html = (await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text()).replaceAll("&#39;", "'");
    expect(html).toContain("30 of 9,014 ordinary public skills flagged (0.33%)");
    expect(html).not.toContain("30 of 9,930");
  });
});
