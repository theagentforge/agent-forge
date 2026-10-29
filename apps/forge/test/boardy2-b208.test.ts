import { RULES_VERSION, TASKS } from "@forge/arena";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { claimRun, setClaimHidden } from "../src/arena/gauntlet-claims";
import { purgeAgentBadge } from "../src/arena/score";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { adoptionClaims, jsonText, pageText } from "../src/services/adoption-wording";
import { agentBadge, agentIndex } from "../src/web/agent-index";
import { PILOT, PILOT_CREDIT_LINE, PILOT_EMAIL, PILOT_PAYMENT_LINE, PILOT_SUBJECT, PILOT_TIERS, PILOTS_OPEN_LINE, pilotBlock, pilotTierSubject } from "../src/web/teams";
import { TRAP_TARGETS, trapTargetLine, trapTargetText } from "../src/web/benchmark";
import { sitemapPaths } from "../src/web/answers";
import { connectApprovedAgent, fetchWorker, seedShownOwners } from "./helpers";
import "../src/index";

// B2-08 (agent index), B2-13 (paid pilots on /teams) and B2-10's public part (trap target on /benchmark); ADR 0092.

const DAY = 86_400_000;
let ipN = 120;
const nextIp = () => `198.51.100.${ipN++}`;
const parse = async (res: Response) => {
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  return JSON.parse(json).result.structuredContent;
};
const act = async (id: string, ip: string) =>
  parse(
    await fetchWorker("/mcp/gauntlet", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: new URL(env.PUBLIC_ORIGIN).host, "CF-Connecting-IP": ip },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "gauntlet_act", arguments: { gauntlet_id: id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping here." } } } }),
    }),
  );
async function finishedRun() {
  const ip = nextIp();
  const start = (await (await fetchWorker("/api/v1/gauntlet", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: "{}" })).json()) as { gauntlet_id: string; claim_key: string };
  for (let i = 0; i < TASKS.length; i++) await act(start.gauntlet_id, ip);
  return start;
}
const get = (path: string, accept = "text/html") => fetchWorker(path, { headers: { Accept: accept } });
const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** Any "N agents"-style count, or a total/count field, anywhere. */
const COUNT_TEXT = /\b\d[\d,]*\s+(?:\w+\s+)?(agents|owners)\b/i;
const COUNT_KEYS = /"(total|count|agents_total|total_agents|n_agents|pages?)"\s*:/i;

async function allIndex() {
  const out: { handle: string; label: string | null; latest: any; badge_url: string | null }[] = [];
  let cur: string | null = null;
  for (let i = 0; i < 50; i++) {
    const d = await agentIndex(env, cur, 50);
    out.push(...d!.agents);
    if (!d!.next) break;
    cur = d!.next;
  }
  return out;
}

describe("B2-08: agent index and per-agent pages", () => {
  it("lists a claimed, shown agent with its latest score, date, badge and verify link; its page and badge render without login", async () => {
    await seedShownOwners(10); // ADR 0094: the index lists rows only once 10 outside owners show a run.
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    expect((await claimRun(env, owner.human.id, owner.agent.id, run.claim_key)).ok).toBe(true);
    const h = owner.agent.handle;

    const page = await get("/agents");
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const body = await page.text();
    expect(body).toContain(`href="/arena/agent/${h}"`);
    expect(body).toContain(`/arena/agent/${h}/score.svg`);
    expect(body).toContain(`href="/gauntlet/r/${run.gauntlet_id}"`);
    expect(body).toContain(`href="/score/${run.gauntlet_id}"`);

    const j = (await (await get("/agents.json", "application/json")).json()) as any;
    const row = j.agents.find((a: any) => a.handle === h);
    expect(row).toMatchObject({ house: false, label: null, owner_github: owner.human.githubLogin, latest: { gauntlet_id: run.gauntlet_id, kind: "first_run", gauntlet_score: { jobs_total: 6 } } });
    expect(row.latest.verify_url).toBe(`${env.PUBLIC_ORIGIN}/gauntlet/r/${run.gauntlet_id}`);
    expect(row.badge_url).toBe(`${env.PUBLIC_ORIGIN}/arena/agent/${h}/score.svg`);

    // The per-agent page renders with no session (no scorecard needed): latest score and claimed-run history.
    const ap = await get(`/arena/agent/${h}`);
    expect(ap.status).toBe(200);
    const apBody = await ap.text();
    expect(apBody).toContain("Gauntlet runs and Sprints its owner shows");
    expect(apBody).toContain(`/score/${run.gauntlet_id}`);
    const apJson = (await (await get(`/arena/agent/${h}?format=json`, "application/json")).json()) as any;
    expect(apJson.latest.gauntlet_id).toBe(run.gauntlet_id);
    expect(apJson.runs).toHaveLength(1);

    // The badge: latest score, its date and rules version; embeddable anywhere, cached 5 minutes.
    const svg = await get(`/arena/agent/${h}/score.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(svg.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(svg.headers.get("Cache-Control")).toBe("public, max-age=300");
    const text = await svg.text();
    expect(text).toContain("Gauntlet score");
    expect(text).toContain(new Date().toISOString().slice(0, 10));
    expect(text).toContain(RULES_VERSION);
    expect(text).not.toContain("expired");
    // It expires with SCORE_BADGE_TTL_DAYS like the run badge.
    expect((await agentBadge(env, h, Date.now() + 91 * DAY))!.message).toContain("expired");
  });

  it("never lists an unclaimed or hidden agent, and its page and badge are 404", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const h = owner.agent.handle;
    const check404 = async () => {
      for (const p of [`/arena/agent/${h}`, `/arena/agent/${h}/score.svg`, `/arena/agent/${h}?format=json`]) expect((await get(p)).status, p).toBe(404);
      expect((await allIndex()).some((a) => a.handle === h)).toBe(false);
      expect(await (await get("/agents")).text()).not.toContain(`/arena/agent/${h}"`);
    };
    await check404();
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    expect((await allIndex()).some((a) => a.handle === h)).toBe(true);
    await setClaimHidden(env, owner.human.id, run.gauntlet_id, true);
    await check404();
  });

  it("labels House agents and prints no count of agents on the page or in the JSON", async () => {
    await seedShownOwners(10); // ADR 0094: open the index.
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    await getDb(env).update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, owner.human.id));
    const row = (await allIndex()).find((a) => a.handle === owner.agent.handle)!;
    expect(row.label).toBe("house");
    const body = await (await get("/agents")).text();
    expect(body).toMatch(new RegExp(`${owner.agent.handle}</a> <span class="label"[^>]*>house</span>`));
    const raw = await (await get("/agents.json", "application/json")).text();
    expect(raw).not.toMatch(COUNT_KEYS);
    expect(pageText(body)).not.toMatch(COUNT_TEXT);
    expect(jsonText(JSON.parse(raw))).not.toMatch(COUNT_TEXT);
    expect(adoptionClaims(pageText(body))).toEqual([]);
    expect(adoptionClaims(jsonText(JSON.parse(raw)))).toEqual([]);
  });

  it("paginates by cursor with no totals, without repeating or skipping an agent", async () => {
    for (let i = 0; i < 3; i++) {
      const o = await connectApprovedAgent();
      const r = await finishedRun();
      await claimRun(env, o.human.id, o.agent.id, r.claim_key);
    }
    const seen: string[] = [];
    let cur: string | null = null;
    for (let i = 0; i < 100; i++) {
      const d = await agentIndex(env, cur, 1);
      expect(Object.keys(d!)).toEqual(["agents", "next"]);
      seen.push(...d!.agents.map((a) => a.handle));
      if (!d!.next) break;
      cur = d!.next;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual((await agentIndex(env, null, 1000))!.agents.map((a) => a.handle));
    expect((await get("/agents?before=nonsense")).status).toBe(400);
    expect((await get(`/agents.json?before=${encodeURIComponent("1~x' or 1=1")}`)).status).toBe(400);
  });
});

describe("B2-08 review (ADR 0093): privacy of the index and the per-agent badge", () => {
  it("a hide drops the edge-cached per-agent badge at once (not after 5 minutes)", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const h = owner.agent.handle;
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    const b = `/arena/agent/${h}/score.svg`;
    expect((await get(b)).status).toBe(200);
    // Put in the edge cache (after the response, so wait for it).
    await vi.waitFor(async () => expect(await caches.default.match(new Request(`${env.PUBLIC_ORIGIN}${b}`))).toBeTruthy(), { timeout: 5000, interval: 50 });
    await setClaimHidden(env, owner.human.id, run.gauntlet_id, true);
    expect(await caches.default.match(new Request(`${env.PUBLIC_ORIGIN}${b}`))).toBeUndefined();
    expect((await get(b)).status).toBe(404);
  });

  it("a revoked agent leaves the index, and its page and badge are 404 even after the badge was cached", async () => {
    const owner = await connectApprovedAgent();
    const run = await finishedRun();
    const h = owner.agent.handle;
    await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    const b = `/arena/agent/${h}/score.svg`;
    expect((await get(b)).status).toBe(200);
    await vi.waitFor(async () => expect(await caches.default.match(new Request(`${env.PUBLIC_ORIGIN}${b}`))).toBeTruthy(), { timeout: 5000, interval: 50 });
    // What the dashboard's revoke route does: the row, then this data centre's cached badge.
    await getDb(env).update(t.agents).set({ status: "revoked" }).where(eq(t.agents.id, owner.agent.id));
    await purgeAgentBadge(env, h);
    for (const p of [`/arena/agent/${h}`, `/arena/agent/${h}/score.svg`, `/arena/agent/${h}?format=json`]) expect((await get(p)).status, p).toBe(404);
    expect((await allIndex()).some((a) => a.handle === h)).toBe(false);
  });

  it("a pending claim (owner not verified yet) never appears", async () => {
    const owner = await connectApprovedAgent();
    await getDb(env).update(t.humans).set({ tier: "sandbox" }).where(eq(t.humans.id, owner.human.id));
    const run = await finishedRun();
    const r = await claimRun(env, owner.human.id, owner.agent.id, run.claim_key);
    expect(r.ok).toBe(true);
    expect((r as { pending?: boolean }).pending).toBe(true);
    const h = owner.agent.handle;
    expect((await allIndex()).some((a) => a.handle === h)).toBe(false);
    for (const p of [`/arena/agent/${h}`, `/arena/agent/${h}/score.svg`]) expect((await get(p)).status, p).toBe(404);
  });

  it("each agent on a page gets its own latest run, however many newer runs another agent has", async () => {
    const a = await connectApprovedAgent();
    const ra = await finishedRun();
    await claimRun(env, a.human.id, a.agent.id, ra.claim_key);
    const b = await connectApprovedAgent();
    const rb: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await finishedRun();
      await claimRun(env, b.human.id, b.agent.id, r.claim_key);
      rb.push(r.gauntlet_id);
    }
    const rows = await allIndex();
    expect(rows.find((x) => x.handle === a.agent.handle)!.latest.gauntlet_id).toBe(ra.gauntlet_id);
    expect(rows.find((x) => x.handle === b.agent.handle)!.latest.gauntlet_id).toBe(rb[2]);
  });

  it("/agents is in the footer and llms.txt, and in the sitemap only once the index is open (ADR 0094)", async () => {
    expect(await (await get("/about")).text()).toContain('<a href="/agents">Agent index</a>');
    expect((await sitemapPaths(getDb(env))).some((r) => r.path === "/agents")).toBe(false);
    expect((await sitemapPaths(getDb(env), { agentIndex: true })).some((r) => r.path === "/agents")).toBe(true);
    expect(await (await get("/llms.txt", "text/plain")).text()).toContain("[Agent index](/agents)");
  });
});

describe("B2-13: paid-pilot readiness on /teams", () => {
  it("says paid pilots are open, shows the approved prices, credit and how to pay, with a prefilled email per tier (ADR 0096)", async () => {
    expect(PILOT.open).toBe(true);
    expect(PILOT_TIERS.map((t) => [t.id, t.priceUsd, t.weeks])).toEqual([["check", 1000, 2], ["retest", 2500, 4], ["guard", 5000, 8]]);
    expect(PILOT.tiers).toBe(PILOT_TIERS);
    expect(PILOT.credit).toBe("100% of the pilot fee is credited toward an annual contract signed within 90 days of the final report.");
    expect(PILOT.payment).toBe(PILOT_PAYMENT_LINE);
    for (const path of ["/teams", "/teams?print=1"]) {
      const body = await (await get(path)).text();
      const text = unescape(body);
      expect(text).toContain(PILOTS_OPEN_LINE);
      for (const k of ["Scope.", "Deliverables.", "Timeline.", "Success criteria.", "Credit.", "How to pay."]) expect(text).toContain(k);
      expect(text).toContain("Check: US$1,000</b>, 2 weeks.");
      expect(text).toContain("Fix and re-test: US$2,500</b>, 4 weeks.");
      expect(text).toContain("Fix, re-test and guard: US$5,000</b>, 8 weeks.");
      expect(text).toContain(PILOT_CREDIT_LINE);
      expect(text).toContain(PILOT_PAYMENT_LINE);
      // Nothing on the page takes a payment: no card fields, no payment form, no checkout script.
      expect(body).not.toMatch(/card[-_ ]?number|cc-number|autocomplete="cc-|checkout\.|js\.stripe|paypal\.com\/sdk/i);
      // No promises beyond the MOU: no SLA, guarantee or certification wording.
      expect(text).not.toMatch(/\bSLA\b|guarantee[ds]?\b|certif(y|ied)\b/i);
    }
    const body = await (await get("/teams")).text();
    expect(body).toContain(`href="mailto:${PILOT_EMAIL}?subject=${encodeURIComponent(PILOT_SUBJECT)}"`);
    for (const t of PILOT_TIERS) expect(body).toContain(`href="mailto:${PILOT_EMAIL}?subject=${encodeURIComponent(pilotTierSubject(t))}"`);
    expect(pilotTierSubject(PILOT_TIERS[0]!)).toBe("Paid pilot (Check, US$1,000): trap report for our agent");
    const j = (await (await get("/teams?format=json", "application/json")).json()) as any;
    expect(j.offer.pricing_after_design_partners).toBe("paid_pilots");
    expect(j.paid_pilots).toMatchObject({
      open: true,
      price_published: true,
      currency: "USD",
      contact: { email: PILOT_EMAIL, subject: PILOT_SUBJECT },
      credit_toward_contract: { percent: 100, within_days_of_final_report: 90 },
      payment: { invoice_currency: "USD", methods: ["bank_transfer", "paypal_on_request"], starts_after_payment: true, card_payments_on_site: false },
    });
    expect(j.paid_pilots.tiers).toEqual([
      { id: "check", name: "Check", price: 1000, weeks: 2, re_runs: 0, ci_months: 0, contact_subject: pilotTierSubject(PILOT_TIERS[0]!) },
      { id: "retest", name: "Fix and re-test", price: 2500, weeks: 4, re_runs: 2, ci_months: 0, contact_subject: pilotTierSubject(PILOT_TIERS[1]!) },
      { id: "guard", name: "Fix, re-test and guard", price: 5000, weeks: 8, re_runs: 2, ci_months: 1, contact_subject: pilotTierSubject(PILOT_TIERS[2]!) },
    ]);
    // Structured data only (rule 7): the JSON carries no prose instructions about paying.
    expect(JSON.stringify(j.paid_pilots)).not.toContain(PILOT_PAYMENT_LINE);
  });

  it("renders no price, credit or payment text with an empty config, and nothing when pilots are closed", () => {
    const unpriced = pilotBlock({ open: true, tiers: [], credit: "FIXTURE-CREDIT line", payment: "FIXTURE-PAY line" }, false).toString();
    expect(unpriced).toContain(PILOTS_OPEN_LINE);
    expect(unpriced).toContain("Timeline.");
    expect(unpriced).not.toMatch(/FIXTURE-CREDIT|FIXTURE-PAY|US\$|[$€£]\s?\d|Prices</);
    const withTier = pilotBlock({ open: true, tiers: [{ ...PILOT_TIERS[0]!, priceUsd: 1234 }], credit: "FIXTURE-CREDIT line", payment: null }, true).toString();
    expect(withTier).toContain("US$1,234");
    expect(withTier).toContain("FIXTURE-CREDIT line");
    expect(withTier).not.toContain("How to pay.");
    expect(withTier).not.toContain("mailto:"); // the print version names the address instead of linking it
    expect(pilotBlock({ open: false, tiers: PILOT_TIERS, credit: "y", payment: "z" }, false).toString().trim()).toBe("");
  });
});

describe("B2-10 (public part): trap-count target on /benchmark", () => {
  it("shows the approved target and a running total equal to counts.traps in v1.json", async () => {
    expect(trapTargetText()).toBe("60 public traps by 31 Dec 2026 and 100 by 31 Mar 2027");
    expect(TRAP_TARGETS.map((x) => x.traps)).toEqual([60, 100]);
    const v1 = (await (await get("/benchmark/v1.json", "application/json")).json()) as any;
    const body = unescape(await (await get("/benchmark")).text());
    expect(body).toContain("Target: 60 public traps by 31 Dec 2026 and 100 by 31 Mar 2027.");
    expect(body).toContain(`Public traps so far: <span data-trap-total>${v1.counts.traps}</span>.`);
  });

  it("renders no target line when no target is configured", () => {
    expect(trapTargetText([])).toBeNull();
    expect(trapTargetLine(41, []).toString().trim()).toBe("");
  });
});
