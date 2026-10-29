import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { disclosure, fn, fnNote, more, statStrip } from "../src/web/components";
import { HEAD_CTA, LINK_GROUPS } from "../src/web/layout";
import { fetchWorker } from "./helpers";
import "../src/index";

// Site audit 29 Oct 2026, batch A (docs/strategy/site-audit-2026-10-29.md §6): the phone Menu sheet, the grouped
// footer, and the shared blocks the page batches use (.disclosure, .fn, .more, .stat-strip).
const page = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();
const str = async (h: unknown) => String(await h);

describe("site shell (audit issues 7 and 8)", () => {
  it("groups every page link under Test, Check, Data and Company, in the footer and the Menu sheet alike", async () => {
    expect(LINK_GROUPS.map((g) => g.title)).toEqual(["Test", "Check", "Data", "Company"]);
    const body = await page("/about");
    const foot = body.slice(body.indexOf('<nav class="foot-nav" id="foot-nav" aria-label="Footer">'), body.indexOf("</footer>"));
    const sheet = body.slice(body.indexOf('<dialog class="menu-sheet"'), body.indexOf("</dialog>"));
    for (const g of LINK_GROUPS) {
      expect(foot).toContain(`<p class="link-group-title" id="foot-${g.id}">${g.title}</p><ul aria-labelledby="foot-${g.id}">`);
      expect(sheet).toContain(`<p class="link-group-title" id="menu-${g.id}">${g.title}</p>`);
      for (const [href, label] of g.links) {
        expect(foot).toContain(`href="${href}"`);
        expect(sheet).toContain(`>${label}</a>`);
      }
    }
    // The footer adds Arena, Gauntlet and Benchmark (missing before) and drops the placeholder agent index. /pricing
    // stays out of site-wide links (ADR 0116: the API's price list, not the acquisition story).
    for (const href of ["/arena", "/gauntlet", "/benchmark"]) expect(foot).toContain(`<a href="${href}">`);
    expect(body).not.toContain('href="/agents"');
    expect(foot + sheet).not.toContain('href="/pricing"');
    // "Your agents" and llms.txt sit in the last line; the sheet ends with the one call to action.
    expect(body).toMatch(/<a (rel="nofollow" )?href="\/dashboard">Your agents<\/a><a class="mono" href="\/llms.txt">llms.txt<\/a>/);
    expect(sheet).toContain(`<a class="btn primary chamfer menu-cta" href="${HEAD_CTA.href}?from=menu">${HEAD_CTA.label}</a>`);
    // The current page is marked in both lists.
    expect(foot).toContain('<a href="/about" aria-current="page">About</a>');
  });

  it("every footer and menu link opens a page", async () => {
    const paths = [...new Set(LINK_GROUPS.flatMap((g) => g.links.map(([href]) => href.split("#")[0]!)))];
    for (const path of [...paths, "/llms.txt"]) {
      const res = await fetchWorker(path, { headers: { Accept: "text/html" }, redirect: "manual" });
      expect(res.status, path).toBe(200);
      await res.arrayBuffer();
    }
  });

  it("the Menu link works without JavaScript (it jumps to the footer groups) and site.js opens it as a modal sheet", async () => {
    const body = await page("/");
    expect(body).toContain('href="#foot-nav" data-menu-open aria-controls="site-menu"');
    expect(body).toContain('id="foot-nav"');
    expect(body).toContain('<button class="btn chamfer menu-close" type="button" data-menu-close>Close</button>');
    const js = await (await env.ASSETS.fetch("https://assets.local/site.js")).text();
    expect(js).toContain("sheet.showModal()");
    expect(js).toMatch(/e\.key !== "Tab"/);
    expect(js).toContain('open.setAttribute("aria-expanded", "false"); open.focus();');
    // Phones show the Wire's three latest posts, still.
    expect(js).toContain('window.matchMedia("(max-width: 640px)").matches');
    const css = (await (await env.ASSETS.fetch("https://assets.local/site.css")).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".wire2-list>li:nth-child(n+4){display:none}");
    expect(css).toMatch(/@media \(prefers-reduced-motion:no-preference\)\{\.menu-sheet\[open\]\{animation:/);
  });
});

describe("shared blocks for the page batches", () => {
  it("disclosure(): one caption line with its counting-rule link", async () => {
    expect(await str(disclosure("All counts include our own test agents and checks.", { href: "/methodology#counting", label: "How we count" }))).toBe(
      '<p class="disclosure">All counts include our own test agents and checks. <a href="/methodology#counting">How we count</a></p>',
    );
  });
  it("fn() and fnNote(): a linked marker and its note", async () => {
    expect(await str(fn("tools"))).toBe('<sup class="fn"><a href="#fn-tools" id="fnref-tools" aria-describedby="fn-tools">†</a></sup>');
    expect(await str(fnNote("tools", "†", "Registry listings, not reviewed."))).toBe(
      '<p class="fn-note" id="fn-tools"><span class="fn-mark" aria-hidden="true">†</span> Registry listings, not reviewed.</p>',
    );
  });
  it("more(): a <details> with a title, an optional hint, escaped text", async () => {
    const h = await str(more("Method", "<b>x</b>", { hint: "35 rules in 12 families", id: "method" }));
    expect(h).toBe('<details class="more" id="method"><summary><span class="more-title">Method</span><span class="more-hint">35 rules in 12 families</span></summary><div class="more-body">&lt;b&gt;x&lt;/b&gt;</div></details>');
    expect(await str(more("A", "b", { open: true }))).toContain('<details class="more" open>');
  });
  it("statStrip(): 5 big numbers, a compact row of 4 (a 5th wraps), one caption, live-refresh hooks", async () => {
    const h = await str(
      statStrip({
        main: [1, 2, 3, 4, 5, 6].map((n) => ({ value: n * 1000, label: `m${n}`, k: `k${n}` })),
        secondary: [{ value: 7, label: "s1" }, { value: null, label: "s2", k: "later" }, { value: "12%", label: "s3", fn: { id: "x" } }, { value: 9, label: "s4" }, { value: 10, label: "s5" }, { value: 11, label: "s6" }],
        caption: disclosure("Includes our own test agents.", { href: "/stats", label: "How we count" }),
        notes: [fnNote("x", "†", "A note.")],
        label: "Live numbers",
        attrs: { "data-work-live": "", "data-x": "1", onclick: "alert(1)" },
      }),
    );
    expect(h).toContain('<div class="stat-strip has-secondary" role="group" aria-label="Live numbers" data-work-live data-x="1">');
    expect(h).not.toContain("onclick");
    expect(h).toContain('<ul class="ss-main" data-count="5">');
    // 5 + 5: extras are dropped. Batch B (29 Oct): a 5th small number (the home page's install checks once past their
    // minimum) wraps to the next line rather than being dropped.
    expect(h.match(/<li/g)).toHaveLength(10);
    expect(h).toContain("s5");
    expect(h).not.toContain("s6");
    expect(h).toContain('<li data-k="k1"><b>1,000</b><span>m1</span></li>');
    expect(h).not.toContain("m6");
    expect(h).toContain('<li data-k="later" hidden><b></b><span>s2</span></li>');
    expect(h).toContain('<b>12%</b><span>s3<sup class="fn"><a href="#fn-x"');
    expect(h).toContain('<p class="disclosure">Includes our own test agents. <a href="/stats">How we count</a></p><div class="fn-notes"><p class="fn-note" id="fn-x">');
  });
});
