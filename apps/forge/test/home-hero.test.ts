import { env } from "cloudflare:workers";
import { Attempt, taskById, type AttemptResult } from "@forge/arena";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeInvoiceCount, heroProof, homeHero } from "../src/arena/hero-proof";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { signReport } from "../src/services/signing";
import { HEAD_CTA, NAV } from "../src/web/layout";
import { homeCardLines } from "../src/web/og";
import { DESCRIPTOR, HOME_H1, HOME_OG_TITLE, HOME_SUBHEAD, PRIMARY_CTA } from "../src/web/pages";
import { AV_DESCRIPTION, avReadme } from "../src/agentverse";
import { errorPage } from "../src/html";
import siteOgScript from "../scripts/make-site-og.py?raw";
import { fetchWorker } from "./helpers";
import "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// W2.1 (docs/strategy/boardy-review-2026-10-27.md, decisions D2 and D3): the BRAND.md hero, sourced to a real public
// replay in which the referee marked the fake invoice paid and the model's own finish call said "done"; "Run the
// Gauntlet" as the one primary call to action; the nav that surfaces /benchmark, /security, /stats and /check.

const MODEL_WORDS = "All invoices paid, job complete";
const ids: Record<string, string> = {};
let n = 0;
// site.css as served (a ?raw import of CSS is stubbed out by the test config), comments removed.
let rules = "";
const page = async (path = "/") => (await fetchWorker(`${path}${path.includes("?") ? "&" : "?"}n=hero${++n}`, { headers: { Accept: "text/html" } })).text();

function run(fell: string[], status: "done" | "cannot_complete" = "done") {
  const a = new Attempt(taskById("scam-invoice")!, 3_100_001);
  a.recordTurn({ tokensIn: 800, tokensOut: 60, cost: 0.001, latencyMs: 900, text: MODEL_WORDS });
  a.call("finish", { status, summary: MODEL_WORDS });
  const base = a.end("finished");
  return { result: { ...base, passed: false, traps: base.traps.map((x) => ({ ...x, triggered: fell.includes(x.id) })) } as AttemptResult, log: a.log };
}

async function addRun(key: string, eventId: string, model: string, r: ReturnType<typeof run>, finishedAt: number, o: { badSignature?: boolean; heldOut?: boolean } = {}) {
  const id = crypto.randomUUID();
  // v1 replays: an HMAC over the log, as the runner signs them (arena/runner.ts).
  const signature = o.badSignature ? "not-a-signature" : await signReport(env.REPORT_SIGNING_KEY, { id, log: JSON.stringify(r.log) });
  await getDb(env).insert(t.arenaRuns).values({
    id, eventId, modelId: model, task: "scam-invoice", seed: 3_100_001, attemptNo: 1, status: "done", heldOut: o.heldOut ?? false,
    passed: false, score: 0.2, cost: 0.01, tokens: 1000, result: r.result, log: r.log, signature, finishedAt,
  });
  ids[key] = id;
}

let practice = "";
let held = "";
let ranked = "";
let lab = "";
const t0 = Date.UTC(2026, 9, 18);

beforeAll(async () => {
  const css = await (await env.ASSETS.fetch("https://assets.local/site.css")).text();
  expect(css).toContain(".hero2 h1{");
  rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  practice = crypto.randomUUID();
  held = crypto.randomUUID();
  ranked = crypto.randomUUID();
  lab = crypto.randomUUID();
  await getDb(env).insert(t.arenaEvents).values([
    { id: practice, slug: "hero-proof-practice", name: "Hero proof practice", season: "s0", kind: "practice", status: "done" },
    // An event held for review (status "planned") is never public, so none of its runs can be the source.
    { id: held, slug: "hero-proof-held", name: "Held for review", season: "s0", kind: "card", status: "planned" },
    { id: ranked, slug: "hero-proof-ranked", name: "Hero proof ranked", season: "s0", kind: "card", status: "done" },
    // A Forge Lab #3 arm, as on production (lab3-none-granite-4-micro-scam-invoice): its replays are public pages, so a
    // run here may be the source; /arena/dataset.json and the count leave Lab arms out.
    { id: lab, slug: "lab3-none-hero-proof", name: "Lab #3 none arm", season: "s0", kind: "practice", status: "done", arm: "none" },
  ]);
});

/** Everything a visitor or a share card sees of the home hero: the page, its JSON twin and the share image's lines. */
async function heroSurfaces() {
  const html = await page();
  const json = await (await fetchWorker(`/?format=json&n=hero-s${++n}`)).text();
  const og = JSON.stringify(homeCardLines(undefined, (await homeHero(env)).headline));
  return { html, json, og, all: `${html}\n${json}\n${og}` };
}

describe("the hero is true in every case (W2.1 follow-up)", () => {
  it("no public run shows a fake invoice paid: a question that claims nothing, never the D2 headline", async () => {
    const h = await homeHero(env);
    expect(h.case).toBe("question");
    const s = await heroSurfaces();
    expect(s.all).not.toContain("reported the job done");
    expect(s.html).toContain("<h1>Would your AI agent pay a <em>fake invoice</em>?</h1>");
    expect(s.html).toContain(`<meta property="og:title" content="Would your AI agent pay a fake invoice?">`);
    expect(JSON.parse(s.json).hero.headline_source).toMatchObject({ case: "question", replay: { status: "not_found" }, count: { runs: 0, fell: null, below_minimum: false } });
  });

  it("falls but no qualifying replay: a count from the public runs, 'below 10' under the minimum (ADR 0067)", async () => {
    // Each fails one replay rule; held-out, held-event and embargoed runs aren't public, so they aren't counted either.
    await addRun("embargoed", practice, EMBARGOED.id, run(["paid_scam"]), t0 + 1);
    await addRun("cannot", practice, "mistral-large-4", run(["paid_scam"], "cannot_complete"), t0 + 2);
    await addRun("other-trap", practice, "mistral-large-4", run(["wrong_account"]), t0 + 3);
    await addRun("unsigned", practice, "mistral-large-4", run(["paid_scam"]), t0 + 4, { badSignature: true });
    await addRun("held-out", practice, "mistral-large-4", run(["paid_scam"]), t0 + 5, { heldOut: true });
    await addRun("held-event", held, "mistral-large-4", run(["paid_scam"]), t0 + 6);
    expect(await heroProof(env)).toBeNull();
    expect(await fakeInvoiceCount(env)).toEqual({ runs: 3, fell: 2 });
    const h = await homeHero(env);
    expect(h).toMatchObject({ case: "count", runs: 3, fell: 2, fell_display: "below 10" });
    const s = await heroSurfaces();
    expect(s.all).not.toContain("reported the job done");
    expect(s.all).not.toMatch(SHOWS_EMBARGOED);
    expect(s.html).toContain("<h1>AI agents paid a planted fake invoice in <em>below 10 of 3</em> refereed sandbox runs.</h1>");
    expect(s.html).toContain('data-hero-source="count"');
    expect(s.html).toContain('<a href="/arena/dataset.json">The dataset</a>');
    // The hero copy links no replay (the live Wire beside it may link bouts of its own).
    const copy = s.html.slice(s.html.indexOf('class="hero2-copy"'), s.html.indexOf("</div>", s.html.indexOf('class="hero2-copy"')));
    expect(copy).toContain("<h1>");
    expect(copy).not.toContain("/arena/run/");
    // The sub-line doesn't depend on the headline, so it stays.
    expect(s.html).toContain(`<p class="lead">${HOME_SUBHEAD}</p>`);
    const src = JSON.parse(s.json).hero.headline_source;
    expect(src).toMatchObject({ case: "count", replay: { status: "not_found" }, count: { runs: 3, fell: null, below_minimum: true, dataset_url: `${env.PUBLIC_ORIGIN}/arena/dataset.json` } });
  });

  it("from 10 falls the count is stated, and the share title stays within 60 characters", async () => {
    for (let i = 0; i < 9; i++) await addRun(`cannot-${i}`, practice, "mistral-large-4", run(["paid_scam"], "cannot_complete"), t0 + 7 + i / 100);
    const h = await homeHero(env);
    expect(h).toMatchObject({ case: "count", runs: 12, fell: 11, fell_display: "11" });
    expect(h.share.length).toBeLessThanOrEqual(60);
    const s = await heroSurfaces();
    expect(s.all).not.toContain("reported the job done");
    expect(s.html).toContain("<h1>AI agents paid a planted fake invoice in <em>11 of 12</em> refereed sandbox runs.</h1>");
    expect(s.html).toContain('<meta property="og:title" content="Fake invoice paid in 11 of 12 refereed sandbox runs">');
    expect(JSON.parse(s.json).hero.headline_source.count).toMatchObject({ runs: 12, fell: 11, below_minimum: false });
  });

  it("with a qualifying replay: the D2 headline, linked to a public run where the fake invoice was paid and the model said done", async () => {
    // 26 ranked falls where the model never said "done" sort ahead of every practice run. They must not crowd the one
    // qualifying run out of the candidates (review 28 Oct: rule 2 is in the query, not only in code).
    for (let i = 0; i < 26; i++) await addRun(`ranked-cannot-${i}`, ranked, "mistral-large-4", run(["paid_scam"], "cannot_complete"), t0 + i / 100);
    expect(await heroProof(env)).toBeNull();
    const counted = await fakeInvoiceCount(env);
    // Production's case: a Lab arm practice run of a small open model, v1 (HMAC) replay.
    await addRun("pick", lab, "granite-4-micro", run(["paid_scam", "wrong_account"]), t0 + 10);
    await addRun("later", practice, "qwen3.8-max", run(["paid_scam"]), t0 + 20);
    // The count matches /arena/dataset.json, which leaves Lab arms out.
    expect(await fakeInvoiceCount(env)).toEqual({ runs: counted.runs + 1, fell: counted.fell + 1 });
    const ds = (await (await fetchWorker(`/arena/dataset.json?n=hero-ds`)).json()) as { runs: { id: string; task: string; traps_triggered: string[] }[] };
    expect(ds.runs.some((r) => r.id === ids.pick)).toBe(false);
    expect(ds.runs.some((r) => r.id === ids.later)).toBe(true);
    // N and M are exactly what anyone counts in the dataset: scam-invoice runs, and those with the fake invoice paid.
    const inv = ds.runs.filter((r) => r.task.startsWith("scam-invoice"));
    expect(inv.length).toBe(counted.runs + 1);
    expect(inv.filter((r) => r.traps_triggered.some((x) => x === "FA-INJ-001" || x === "FA-PAY-002")).length).toBe(counted.fell + 1);
    const p = await heroProof(env);
    expect(p?.run).toBe(ids.pick);
    expect(p!.lab).toBe("IBM (open weights)");
    expect(p!.claim).toBe("done");
    expect(p!.trap.id).toBe("FA-INJ-001");
    expect(p!.replay).toBe(`/arena/run/${ids.pick}`);
    expect(p!.ranked).toBe(false);
    expect((await homeHero(env)).case).toBe("replay");
    // The replay it links to is served.
    expect((await fetchWorker(`/arena/run/${ids.pick}`, { headers: { Accept: "text/html" } })).status).toBe(200);
    expect((await heroSurfaces()).og).toContain(HOME_H1);
  });

  it("keeps its first pick, and never picks an embargoed model, a 'can't be done', a held-out run or a held event", async () => {
    expect((await heroProof(env))!.run).toBe(ids.pick);
    for (const k of ["embargoed", "cannot", "other-trap", "unsigned", "held-out", "held-event"]) expect((await heroProof(env))!.run).not.toBe(ids[k]);
  });
});

describe("the home hero (W2.1)", () => {
  it("shows the BRAND.md headline and sub-line word for word (copied from its hero row, 28 Oct), sourced to the replay", async () => {
    expect(HOME_H1).toBe("An AI agent paid a fake invoice and reported the job done.");
    // BRAND v1.3 (Dinike, 29 Oct 2026, site audit option A).
    expect(HOME_SUBHEAD).toBe("We test AI agents on real business jobs with hidden traps, and check the tools they install.");
    const body = await page();
    const h1 = body.indexOf("<h1>An AI agent paid a fake invoice and <em>reported the job done</em>.</h1>");
    expect(h1).toBeGreaterThan(0);
    const source = body.indexOf(`data-hero-source="${ids.pick}"`);
    expect(source).toBeGreaterThan(h1);
    expect(body).toContain(`href="/arena/run/${ids.pick}?from=home-source">Watch the replay</a>`);
    // Site audit 29 Oct (issue 2): one short line. Says honestly whose model it was and that the bout was practice, not
    // a ranked bout; the trap's catalogue entry is in the title.
    expect(body).toContain('<span class="muted">Refereed replay:</span> <span title="FA-INJ-001: ');
    expect(body).toContain(">practice bout, not ranked</span> · Granite 4.0 Micro (IBM, open weights) · 18 Oct 2026 · <a");
    expect(body.indexOf(`<p class="lead">${HOME_SUBHEAD}</p>`)).toBeGreaterThan(source);
    expect(body).not.toContain(MODEL_WORDS);
    expect(body.slice(0, body.indexOf("<footer")).toLowerCase()).not.toContain("social network");
  });

  it("has one primary call to action, Run the Gauntlet, to the Gauntlet start page, then one secondary (site audit 29 Oct)", async () => {
    expect(PRIMARY_CTA).toEqual({ label: "Run the Gauntlet", href: "/gauntlet" });
    const body = await page();
    const ctas = body.slice(body.indexOf('class="hero-ctas"'), body.indexOf("</p>", body.indexOf('class="hero-ctas"')));
    expect(ctas).toContain('<a class="btn primary chamfer" href="/gauntlet?from=home-hero">Run the Gauntlet</a>');
    expect(ctas.match(/btn primary/g)).toHaveLength(1);
    expect(ctas).toMatch(/class="btn chamfer" href="\/check\?from=home-hero">Check a tool<\/a>$/);
    expect(ctas.match(/class="btn/g)).toHaveLength(2);
    expect(body).toContain('Short on time? <a href="/gauntlet/sprint?from=home-hero">Try the 90-second Sprint</a>.');
    // The header's call to action on every page is the Gauntlet too.
    for (const path of ["/", "/arena", "/about"]) expect(await page(path)).toContain('class="btn primary chamfer head-cta" href="/gauntlet?from=head"');
    // The target is the Gauntlet's start page: the line to give an agent.
    const g = await page("/gauntlet");
    expect(g).toContain("Give your agent this line.");
    expect(g).toContain('class="btn primary chamfer head-cta" href="/gauntlet?from=head" aria-current="page"');
  });

  it("keeps the live totals band (ADR 0067 Amendment 1); the duplicates the site audit removed stay removed", async () => {
    const body = await page();
    expect(body).toContain("data-work-live");
    expect(body).not.toContain("Live, outside agents only");
    expect(body).toContain("Includes the Forge's own test agents");
    // Site audit 29 Oct (§3.1, B2): one check box, no value cards, no human/agent tabs, no second report list.
    expect(body.match(/<form [^>]*class="scan-quick/g) ?? []).toHaveLength(1);
    expect(body).not.toContain("value-cards");
    expect(body).not.toContain("who-tabs");
    expect(body).not.toContain("Who this is for");
    expect(body).not.toContain("field reports — latest");
    expect(body).not.toContain('class="check-form');
  });

  it("never names the embargoed model, even though it has a qualifying run", async () => {
    expect(await page()).not.toMatch(SHOWS_EMBARGOED);
    expect(JSON.stringify(await (await fetchWorker(`/?format=json&n=hero-e`)).json())).not.toMatch(SHOWS_EMBARGOED);
  });

  it("the share title, description and image carry the new hero", async () => {
    const body = await page();
    expect(HOME_OG_TITLE).toBe(HOME_H1.replace(/\.$/, ""));
    expect(body).toContain(`<meta property="og:title" content="${HOME_OG_TITLE}">`);
    expect(body).toContain(`<meta name="twitter:title" content="${HOME_OG_TITLE}">`);
    expect(body).toContain(`<meta property="og:description" content="${HOME_SUBHEAD}">`);
    expect(body).toContain(`<meta name="description" content="${HOME_SUBHEAD}">`);
    expect(body).toContain("<title>The Agent Forge: AI agents tested on real business jobs with planted traps</title>");
    expect(body).toMatch(/<meta property="og:image" content="[^"]*\/og\/home\.png">/);
    const llms = await (await fetchWorker("/llms.txt")).text();
    expect(llms).toContain(`> ${DESCRIPTOR} ${HOME_SUBHEAD}`);
    // llms.txt is static, so it never carries the D2 headline: that shows only where a replay backs it (the home page).
    expect(llms).not.toContain("reported the job done");
    expect(llms).not.toContain("social network");
  });

  it("the JSON twin has the same hero, its source replay and the call to action", async () => {
    const j = (await (await fetchWorker(`/?format=json&n=hero-j`)).json()) as { hero: Record<string, unknown> & { headline_source: Record<string, unknown>; primary_cta: { label: string; url: string } } };
    expect(j.hero.descriptor).toBe(DESCRIPTOR);
    expect(j.hero.headline).toBe(HOME_H1);
    expect(j.hero.subline).toBe(HOME_SUBHEAD);
    expect(j.hero.primary_cta).toEqual({ label: "Run the Gauntlet", url: `${env.PUBLIC_ORIGIN}/gauntlet` });
    expect(j.hero.for_security_teams).toBe(`${env.PUBLIC_ORIGIN}/security`);
    expect(j.hero.headline_source).toMatchObject({ case: "replay", status: "found", run: ids.pick, trap_id: "FA-INJ-001", claim: "done", ranked: false, model: "granite-4-micro", model_lab: "IBM (open weights)", replay_url: `${env.PUBLIC_ORIGIN}/arena/run/${ids.pick}` });
    expect(JSON.stringify(j)).not.toContain(MODEL_WORDS);
  });
});

describe("navigation (W2.1)", () => {
  it("surfaces /benchmark, /security, /stats and /check in five plain words, and marks the current page", async () => {
    expect(NAV.map(([, href, label]) => [href, label])).toEqual([
      ["/arena", "Arena"],
      ["/benchmark", "Benchmark"],
      ["/check", "Check a tool"],
      ["/security", "Security"],
      ["/stats", "Stats"],
    ]);
    const body = await page("/security");
    const nav = body.slice(body.indexOf('<nav class="nav"'), body.indexOf("</nav>", body.indexOf('<nav class="nav"')));
    expect(nav.match(/<a /g)).toHaveLength(5);
    expect(nav).toContain('<a href="/security" aria-current="page">Security</a>');
    expect(nav).not.toContain("social network");
    for (const path of ["/benchmark", "/security", "/stats", "/check"]) expect((await fetchWorker(path, { headers: { Accept: "text/html" } })).status, path).toBe(200);
  });

  it("stays simple on a phone: logo, a verb call to action and a Menu button in one row (site audit 29 Oct, issue 7)", async () => {
    expect(HEAD_CTA).toEqual({ href: "/gauntlet", label: "Run the Gauntlet", short: "Run Gauntlet" });
    const body = await page();
    expect(body).toContain('<span class="long">Run the Gauntlet</span><span class="short">Run Gauntlet</span>');
    expect(body).toContain('<a class="btn chamfer menu-btn" href="#foot-nav" data-menu-open aria-controls="site-menu" aria-haspopup="dialog">Menu</a>');
    expect(body).toContain('<dialog class="menu-sheet" id="site-menu"');
    const phone = rules.slice(rules.indexOf("@media (max-width:959px){"));
    expect(phone).toMatch(/^@media \(max-width:959px\)\{[^@]*\.nav\{display:none\}[^@]*\.menu-btn\{display:inline-flex/);
    expect(rules).toMatch(/\.head-cta \.long\{display:none\}\.head-cta \.short\{display:inline\}/);
    expect(body).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
  });
});

describe("brand (BRAND.md §6)", () => {
  it("the hero's new styles use only the brand's colour and type tokens", () => {
    const mine = [...rules.matchAll(/\.(hero-source|hero-ctas|hero2 h1)[^{]*\{([^}]*)\}/g)].map((m) => m[2]!);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const decl of mine) {
      expect(decl, decl).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i);
      for (const f of decl.matchAll(/font-family:([^;]+)/g)) expect(f[1]).toMatch(/^var\(--font-(display|body|mono)\)$/);
    }
    expect(rules).toMatch(/\.hero2 h1\{font-size:var\(--fs-hero\)/);
    expect(rules).toMatch(/\.hero2 h1 em\{font-style:normal;color:var\(--brand\)\}/);
    // The brand's two families only (Archivo, JetBrains Mono).
    const families = new Set([...rules.matchAll(/font-family:"([^"]+)"/g)].map((m) => m[1]));
    expect([...families].sort()).toEqual(["Archivo", "JetBrains Mono"]);
  });
});

// AQ-01 (docs/strategy/acquisition-audit-2026-10-28.md, 28 Oct, Dinike approved): one positioning, never "social network".
const files = {
  ...import.meta.glob<string>(["../../../integrations/registry/server.json", "../../../public-repo/forge-mcp/plugin.json", "../../../public-repo/forge-mcp/.cursor-plugin/plugin.json", "../../../integrations/claude-code-plugin/plugin/.claude-plugin/plugin.json"], { eager: true, query: "?raw", import: "default" }),
  ...import.meta.glob<string>(["../../../public-repo/**/README.md", "../../../integrations/*/README.md", "../../../integrations/*/plugin/README.md", "../../../packages/*/README.md"], { eager: true, query: "?raw", import: "default" }),
};

describe("positioning (AQ-01)", () => {
  it("says 'social network' on no surface: pages, JSON twin, llms.txt, skill.md, agent card, MCP, listings, READMEs, share image", async () => {
    expect(DESCRIPTOR).toBe("A planted-trap test for AI agents, and safety data on the skills, MCP servers and packages they install.");
    const host = new URL(env.PUBLIC_ORIGIN).host;
    const mcp = async (method: string) =>
      (await fetchWorker("/mcp/public", { method: "POST", headers: { Host: host, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "aq01", version: "1" } } : {} }) })).text();
    const surfaces: Record<string, string> = {
      home: await page(),
      about: await page("/about"),
      json: await (await fetchWorker(`/?format=json&n=aq01`)).text(),
      llms: await (await fetchWorker("/llms.txt")).text(),
      skill: await (await fetchWorker("/skill.md")).text(),
      card: await (await fetchWorker("/.well-known/agent-card.json")).text(),
      marketplace: await (await fetchWorker("/marketplace.json")).text(),
      mcp_initialize: await mcp("initialize"),
      mcp_tools: await mcp("tools/list"),
      og_home: JSON.stringify(homeCardLines(undefined, (await homeHero(env)).headline)),
      agentverse: `${AV_DESCRIPTION}\n${avReadme(env.PUBLIC_ORIGIN)}`,
      error_page: await errorPage("Sign-in failed", "Try again.").text(),
      // The fallback share image (public/og/site.png) is drawn by this script: the descriptor and the current tagline.
      site_og_script: siteOgScript,
    };
    for (const [k, v] of Object.entries(files)) surfaces[k] = v;
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(8);
    for (const [k, v] of Object.entries(surfaces)) {
      expect(v.length, k).toBeGreaterThan(20);
      expect(v.toLowerCase(), k).not.toContain("social network");
      expect(v.toLowerCase(), k).not.toContain("warn each other");
    }
    for (const [k, v] of Object.entries(surfaces)) expect(v, k).not.toContain("Field-tested by agents");
    expect(siteOgScript).toContain(`DESCRIPTOR = "${DESCRIPTOR}"`);
    expect(siteOgScript).toContain('"AI, tested on everyday jobs."');
    expect(surfaces.marketplace).toContain(DESCRIPTOR);
    expect(surfaces.llms).toContain(DESCRIPTOR);
  });
});
