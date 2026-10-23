import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FRAMEWORKS, NOTHING_STORED, TEAMS_EMAIL, TEAMS_OFFER } from "../src/web/teams";
import { fetchWorker } from "./helpers";
import "../src/index";

// ADR 0023 §7 ("Now"): the /teams design-partner page. The intake form stores nothing and never posts to our server.

const page = async (path: string) => {
  const res = await fetchWorker(path);
  return { res, body: await res.text() };
};
const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

describe("/teams", () => {
  it("states the offer, the free design-partner slots, what we need and what we don't do yet, with no prices", async () => {
    const { res, body } = await page("/teams");
    expect(res.status).toBe(200);
    const text = unescape(body);
    expect(text).toContain(TEAMS_OFFER);
    expect(TEAMS_OFFER).toBe("We run your agent through our trap set and send you a report: what it fell for, by failure mode, with replays.");
    expect(text).toContain("Free for the first 3 design partners.");
    expect(body).toContain('href="/connect"');
    expect(body).toContain('href="/arena/rules"');
    expect(text).toContain("We don't run traps against your own tools or MCP servers.");
    expect(text).toContain("signed");
    expect(text).toContain("We aren't affiliated with any AI lab.");
    expect(body).not.toMatch(/[$€£]\s?\d|per month|\/mo\b/i);
  });

  it("has the intake fields and turns them into an email to partners@, never a post to our server", async () => {
    const { res, body } = await page("/teams?f=1");
    expect(body).toContain('type="email" name="email" required');
    expect(body).toContain('name="framework"');
    for (const f of FRAMEWORKS) expect(body).toContain(`<option>${f}</option>`);
    for (const v of ["Yes", "No", "Not sure"]) expect(body).toContain(`name="mcp" value="${v}"`);
    expect(body).toContain('name="what"');
    expect(unescape(body)).toContain(NOTHING_STORED);
    expect(NOTHING_STORED).toBe("This opens your email app; nothing is sent to or stored by us until you press send.");
    // Every form on the page goes to the email app: none posts to our origin (no action, a relative one, or ours).
    const forms = [...body.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]).filter((f) => !f.includes('role="search"'));
    expect(forms).toHaveLength(1);
    for (const f of forms) {
      const action = /action="([^"]*)"/.exec(f)?.[1] ?? "";
      expect(action).toMatch(new RegExp(`^mailto:${TEAMS_EMAIL}\\?subject=`));
      expect(action).not.toContain(env.PUBLIC_ORIGIN);
    }
    expect(body).toContain(`data-mailto="${TEAMS_EMAIL}"`);
    // The no-JavaScript fallback: a prefilled email link with the questions in the body.
    expect(body).toContain(`href="mailto:${TEAMS_EMAIL}?subject=Design%20partner`);
    expect(body).toMatch(/body=Contact%20email%3A%20%0AAgent%20framework/);
    // The page's CSP lets the form open the email app, and still allows no inline script.
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("form-action 'self' https://github.com mailto:");
    expect(csp).toContain("script-src 'self'");
    expect(body).not.toMatch(/<script>(?!\s*$)|<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/);
  });

  it("other pages don't get the mailto form-action", async () => {
    const res = await fetchWorker("/about");
    expect(res.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://github.com;");
  });

  it("site.js builds the prefilled email on submit", async () => {
    const js = (await import("../public/site.js?raw")).default as string;
    expect(js).toContain("[data-teams-form]");
    expect(js).toContain('"mailto:" + f.getAttribute("data-mailto")');
    expect(js).toContain("encodeURIComponent(body)");
    expect(js).not.toMatch(/fetch\([^)]*teams/);
  });

  it("has a one-page print version and print rules", async () => {
    const { res, body } = await page("/teams?print=1");
    expect(res.status).toBe(200);
    expect(body).toContain('class="prose teams print-view"');
    expect(body).toContain('<meta name="robots" content="noindex">');
    expect(body).not.toContain("<form class=\"stack teams-form\"");
    expect(body).toContain(`<strong>${TEAMS_EMAIL}</strong>`);
    expect(unescape(body)).toContain(TEAMS_OFFER);
    expect((await page("/teams")).body).toContain('href="/teams?print=1"');
  });

  it("has a JSON twin with the offer as structured data", async () => {
    const res = await fetchWorker("/teams?format=json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const j = (await res.json()) as Record<string, any>;
    expect(j.offer).toMatchObject({ service: "trap_set_run", deliverable: "report", design_partner_slots: 3, price_for_design_partners: 0, pricing_after_design_partners: null });
    expect(j.offer.report_contents).toEqual(["falls_by_failure_mode", "signed_replays", "rules_version"]);
    expect(j.requirements.agent_connects_over_mcp).toBe(true);
    expect(j.not_offered_yet).toEqual(["traps_against_your_own_tools"]);
    expect(j.contact.email).toBe(TEAMS_EMAIL);
    expect(j.intake.stored_by_forge).toBe(false);
    expect(j.intake.fields.map((f: { name: string }) => f.name)).toEqual(["email", "framework", "mcp", "what"]);
    expect(j.affiliated_with_ai_lab).toBe(false);
  });

  it("is linked from the site footer and from /about", async () => {
    expect((await page("/?teams=1")).body).toContain('<a href="/teams">For teams</a>');
    expect((await page("/about?teams=1")).body).toMatch(/free for the first design partners\. <a href="\/teams">For teams<\/a>/);
  });
});
