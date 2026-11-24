import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { arenaPause } from "../src/services/costs";
import { internalCaller } from "../src/services/internal";
import { humanCounters } from "../src/services/usage";
import { outsideUse } from "../src/services/outside-use";
import { beltHolder, NO_BELT_ALONE, NO_BELT_OVERLAP } from "../src/web/arena";
import { jobsPhrase } from "../src/web/benchmark";
import { RESULTS_SENTENCE } from "../src/web/legal";
import { GUESSED_PATHS } from "../src/web/static-pages";
import { publicTrapsLine } from "../src/web/security";
import { trapSetEntries } from "../src/arena/benchmark";
import { TRAP_CATALOG } from "@forge/arena";
import { fetchWorker } from "./helpers";
import "../src/index";

// The 13 Nov outside walkthrough, with the coordinator's scope updates (joint review with Boardy; Dinike's go-ahead).

const html = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();

// The 13 Nov home rewrite (check first) and its v1.5 successor were reverted for the home page on 16 Nov 2026 (Dinike,
// 15:04 Colombo: "can we just revert to the exact setting we had before the november 13th change?"; BRAND.md v1.6). The
// home page's own tests are home-hero, home-claim, hero-lines and home-live again. What stays from this walkthrough:
describe("home page honesty fixes kept through the 16 Nov revert (ADR 0152)", () => {
  it("no retired count headline in the HTML", async () => {
    const body = await html("/");
    expect(body).not.toMatch(/paid a planted fake invoice in/);
    expect(body).not.toContain('data-hero-source="count"');
  });

  it("the JSON twin never reports the count case either (home-hero covers the sealed-replay rule)", async () => {
    const json = (await (await fetchWorker("/?format=json", { headers: { Accept: "application/json" } })).json()) as { hero: { headline_source: { case: string } } };
    expect(["replay", "question"]).toContain(json.hero.headline_source.case);
  });
});

describe("belts (coordinator 13 Nov): only when the ranges are clear of each other", () => {
  it("the top model's lower bound must exceed the next model's upper bound", () => {
    expect(beltHolder([{ rating: 1800, rd: 50 }, { rating: 1500, rd: 50 }])).toEqual({ rating: 1800, rd: 50 });
    // 1800 − 100 = 1700 is not above 1600 + 120 = 1720: a tie.
    expect(beltHolder([{ rating: 1800, rd: 50 }, { rating: 1600, rd: 60 }])).toBeNull();
    // Touching ranges are a tie too.
    expect(beltHolder([{ rating: 1700, rd: 50 }, { rating: 1500, rd: 50 }])).toBeNull();
    expect(beltHolder([{ rating: 1700, rd: 50 }])).toBeNull();
    expect(beltHolder([])).toBeNull();
    expect(NO_BELT_OVERLAP).toContain("overlapping ranges are a tie");
    expect(NO_BELT_ALONE).toContain("No belt yet");
  });
});

describe("one trap count, saying what it counts", () => {
  it("/security names the catalogue's public traps and how many the Trap Set holds", async () => {
    const line = String(publicTrapsLine());
    expect(line).toContain(`${TRAP_CATALOG.length} public traps in the`);
    expect(line).toContain(trapSetEntries().length === TRAP_CATALOG.length ? `all ${TRAP_CATALOG.length} are in` : `${trapSetEntries().length} of them are in`);
    const sec = await html("/security");
    expect(sec).toContain(`${TRAP_CATALOG.length} public traps in the`);
    // Lead with the latest ranked Hard event's line (when there is one), then the catalogue, then the current-rules read.
    expect(sec.indexOf('id="current-rules"')).toBeGreaterThan(sec.indexOf("public traps in the"));
  });

  it("/benchmark says how its jobs are counted, the same way the Gauntlet's six are", () => {
    expect(jobsPhrase([{ job: { id: "refund" } }, { job: { id: "scam-invoice" } }, { job: { id: "weekend" } }, { job: { id: "spreadsheet" } }, { job: { id: "flaky-supplier" } }, { job: { id: "impossible" } }, { job: { id: "procurement-frontier" } }])).toBe(
      "7 jobs: the six everyday jobs (also at Hard volume) and 1 Frontier desk job",
    );
    expect(jobsPhrase([{ job: { id: "refund" } }])).toBe("1 everyday job");
  });
});

describe("addresses people guess", () => {
  it("each redirects (301) to the page that answers it, keeping the query", async () => {
    for (const [from, to] of Object.entries(GUESSED_PATHS)) {
      const res = await fetchWorker(`${from}?from=x`, { redirect: "manual" });
      expect(res.status, from).toBe(301);
      const [path, hash] = to.split("#");
      expect(res.headers.get("location"), from).toBe(`${path}?from=x${hash ? `#${hash}` : ""}`);
    }
  });
});

describe("/arena/fail-of-the-week with no pick yet", () => {
  it("is a page (200, noindex) with a sensible empty state, not a 404; JSON says none_yet", async () => {
    const res = await fetchWorker("/arena/fail-of-the-week", { headers: { Accept: "text/html" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/arena/failures"');
    expect(body).toContain('name="robots" content="noindex');
    const j = await fetchWorker("/arena/fail-of-the-week?format=json", { headers: { Accept: "application/json" } });
    expect(j.status).toBe(200);
    expect(await j.json()).toMatchObject({ status: "none_yet" });
  });
});

describe("Terms: what a result is (Dinike, 13 Nov 09:42 Colombo)", () => {
  it("section 10 carries the sentence word for word, at #results, with the last-updated date", async () => {
    const body = await html("/terms");
    expect(RESULTS_SENTENCE).toBe("A 'clear', 'not flagged' or 'nothing found' result is an observation made on the stated date by the stated method, not a warranty or a statement that a tool is safe.");
    expect(body.replace(/&#39;|&#x27;/g, "'")).toContain(RESULTS_SENTENCE);
    expect(body).toContain('id="results"');
    expect(body).toContain("last updated 13 November 2026");
  });
});

describe("llms.txt describes the product as it is", () => {
  it("check before install, scan, field reports, Arena and trap tests, the public MCP; no social-network pitch", async () => {
    const t = await (await fetchWorker("/llms.txt")).text();
    for (const s of ["Check before install", "Scan.", "Field reports.", "Arena and trap tests.", "/mcp/public", "advisories_checked"]) expect(t, s).toContain(s);
    expect(t).not.toMatch(/AI agents post what worked|social network|Give your AI the checks others missed/i);
  });
});

describe("own traffic is never outside use", () => {
  it("a founder-marked browser is ours: no people counter, and internalCaller names it", () => {
    const req = (cookie?: string) => ({
      method: "POST",
      headers: new Headers({ "sec-fetch-site": "same-origin", referer: `${env.PUBLIC_ORIGIN}/`, "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140 Safari/537.36", ...(cookie ? { cookie } : {}) }),
    });
    expect(internalCaller(new Headers({ cookie: "a=b; forge_own=1" }))).toBe("founder");
    expect(internalCaller(new Headers({ cookie: "forge_own=0" }))).toBeNull();
    expect(humanCounters(req("forge_own=1"), env.PUBLIC_ORIGIN)).toEqual([]);
    expect(humanCounters(req(), env.PUBLIC_ORIGIN)).toContain("visit:human");
  });

  it("the outside-use block is founder-only: computed with zeros shown, and absent from /stats and /stats.json", async () => {
    const o = await outsideUse(env);
    expect(o.rows.map((r) => r.key)).toEqual(["outside_field_reports", "outside_field_reports_30d", "outside_arena_bouts", "outside_install_checks", "verified_owners_active_30d", "outside_mcp_connections_7d"]);
    for (const r of o.rows) expect(typeof r.value).toBe("number");
    // Snapshotted pages (ADR 0154) carry nothing founder-only and set no own-traffic cookie, with or without it.
    for (const path of ["/", "/stats", "/security", "/arena"]) {
      for (const cookie of [undefined, "forge_own=1"]) {
        const res = await fetchWorker(path, { headers: { Accept: "text/html", ...(cookie ? { cookie } : {}) } });
        expect(res.headers.get("set-cookie") ?? "", path).not.toContain("forge_own");
        expect(await res.text(), path).not.toMatch(/Outside use \(excluding|outside_field_reports/);
      }
    }
    const stats = await html("/stats");
    expect(stats).not.toContain("Outside use (excluding");
    const sj = (await (await fetchWorker("/stats.json")).json()) as Record<string, unknown>;
    expect(sj).not.toHaveProperty("outside");
    expect(JSON.stringify(sj)).not.toContain("outside_field_reports");
  });
});

describe("the Arena's paused note is a schedule, not a budget", () => {
  it("never mentions a budget or credit on a public page", async () => {
    await env.KV.put("arena:claude-paused", "1");
    try {
      // Read from the function every Arena page uses (the page itself may be served from an earlier cached render).
      const note = (await arenaPause(env)).notes.join(" ");
      expect(note).toMatch(/^Next Claude bouts: \d{4}-\d{2}-\d{2}\./);
      expect(note).not.toMatch(/budget|credit|limit/i);
    } finally {
      await env.KV.delete("arena:claude-paused");
    }
  });
});
