import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BENCHMARK_HELD_OUT_PATH } from "../src/arena/benchmark-versions";
import { BENCHMARK_PATH, TRAP_SET } from "../src/arena/benchmark";
import { REFEREE_AUDIT, validityGate } from "../src/arena/error-record";
import { VALIDITY_PATH } from "../src/arena/validity";
import { CHECK_CTA_LABEL, claimBlock, HOME_CLAIM, homeProof, SIGNED_REPLAYS_PATH } from "../src/web/home-proof";
import { DESCRIPTOR } from "../src/web/layout";
import { fetchWorker } from "./helpers";
import "../src/index";

// Homepage-claim (12 Nov 2026): a technical buyer or an agent builder gets it in ten seconds. The hero leads with one
// plain claim (BRAND.md's descriptor), then the proof a skeptic can check, each one link, then one primary call to
// action (the Gauntlet) and one secondary (check a tool before install). The gross totals come after all of it.

const home = async (n: string) => (await fetchWorker(`/?n=${n}`, { headers: { Accept: "text/html" } })).text();
const main = (body: string) => body.slice(body.indexOf("<main"), body.indexOf("</main>"));

describe("home page: claim, proof, call to action, then the counters", () => {
  it("leads with BRAND.md's one-line descriptor, before the headline", async () => {
    expect(HOME_CLAIM).toBe("A planted-trap test for AI agents, and safety data on the skills, MCP servers and packages they install.");
    expect(HOME_CLAIM).toBe(DESCRIPTOR);
    const body = main(await home("claim-1"));
    const claim = body.indexOf(`<p class="hero-claim" data-home-claim>${HOME_CLAIM}</p>`);
    expect(claim).toBeGreaterThan(body.indexOf('class="hero2"'));
    expect(claim).toBeLessThan(body.indexOf("<h1"));
    expect(body.match(/data-home-claim/g)).toHaveLength(1);
  });

  it("follows the claim directly with the proof links: signed replays, held-out seeds and the Trap Set version", async () => {
    const body = main(await home("claim-2"));
    const claimEnd = body.indexOf("</p>", body.indexOf("data-home-claim")) + 4;
    const proof = body.indexOf("data-home-proof");
    // Nothing between the claim and the proof but the proof list's label.
    expect(body.slice(claimEnd, proof).trim()).toBe('<p class="small muted hero-proof-t" id="home-proof-t">Check it yourself:</p><ul class="hero-proof"');
    const block = body.slice(proof, body.indexOf("</ul>", proof));
    expect(block).toContain(`<a href="${SIGNED_REPLAYS_PATH}" data-proof="signed_replays">Signed replays</a>`);
    expect(block).toContain(`<a href="${BENCHMARK_HELD_OUT_PATH}" data-proof="held_out">Held-out seeds</a>`);
    expect(block).toContain(`<a href="${BENCHMARK_PATH}" data-proof="trap_set">Trap Set ${TRAP_SET.version}</a>`);
    // The test environment keeps the validity pack switched off, so its link is left out rather than pointing at a 404.
    expect(env.VALIDITY_PUBLIC).not.toBe("on");
    expect(block).not.toContain(VALIDITY_PATH);
    // Every proof link opens a public page.
    for (const href of [SIGNED_REPLAYS_PATH.split("#")[0]!, BENCHMARK_HELD_OUT_PATH, BENCHMARK_PATH]) {
      expect((await fetchWorker(href, { headers: { Accept: "text/html" } })).status).toBe(200);
    }
    expect(await (await fetchWorker("/methodology", { headers: { Accept: "text/html" } })).text()).toContain('id="replays"');
  });

  it("links the validity pack (referee audits and error record) once it is public, in second place", () => {
    const on = homeProof({ VALIDITY_PUBLIC: "on" });
    const off = homeProof({ VALIDITY_PUBLIC: "off" });
    expect(off.map((i) => i.key)).toEqual(["signed_replays", "held_out", "trap_set"]);
    if (validityGate(REFEREE_AUDIT).ok) {
      expect(on.map((i) => i.key)).toEqual(["signed_replays", "validity", "held_out", "trap_set"]);
      expect(String(claimBlock(on))).toContain(`<a href="${VALIDITY_PATH}" data-proof="validity">Referee audits and error record</a>`);
    } else expect(on).toEqual(off);
    // Links and a version name only: no new number on the page.
    for (const i of on) expect(i.label.replace(TRAP_SET.version, "")).not.toMatch(/\d/);
  });

  it("has one primary call to action (the Gauntlet) and one secondary (check a tool before install), after the proof", async () => {
    const body = main(await home("claim-3"));
    const ctas = body.slice(body.indexOf('class="hero-ctas"'), body.indexOf("</p>", body.indexOf('class="hero-ctas"')));
    expect(ctas).toContain('<a class="btn primary chamfer" href="/gauntlet?from=home-hero">Run the Gauntlet</a>');
    expect(ctas).toContain(` class="btn chamfer" href="/check?from=home-hero">${CHECK_CTA_LABEL}</a>`);
    expect(CHECK_CTA_LABEL).toBe("Check a tool before install");
    expect(ctas.match(/btn primary/g)).toHaveLength(1);
    expect(body.indexOf('class="hero-ctas"')).toBeGreaterThan(body.indexOf("data-home-proof"));
  });

  it("puts the big counters after the claim, the proof and the calls to action, and still shows the gross totals", async () => {
    const body = main(await home("claim-4"));
    const at = ["data-home-claim", "data-home-proof", 'class="hero-ctas"', 'id="home-check"', "data-work-live", 'id="home-final"'].map((m) => body.indexOf(m));
    for (const i of at) expect(i).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body.match(/data-work-live/g)).toHaveLength(1);
  });

  it("claims nothing it can't back at the top: no 'safe', 'malicious', 'trusted by', 'certified' or customer logos", async () => {
    const body = main(await home("claim-5"));
    const top = body.slice(body.indexOf('class="hero2-copy"'), body.indexOf("</p>", body.indexOf('class="hero-ctas"')));
    expect(top.length).toBeGreaterThan(200);
    expect(top).not.toMatch(/\bsafe\b|malicious|trusted by|certified|customers?\b|logo/i);
  });

  it("gives agents the claim and the proof links in the home page's JSON", async () => {
    const j = (await (await fetchWorker("/?format=json&n=claim-6")).json()) as { hero: { claim: string; proof: { key: string; url: string }[]; secondary_ctas: { label: string }[] } };
    expect(j.hero.claim).toBe(HOME_CLAIM);
    expect(j.hero.proof.map((p) => p.key)).toEqual(["signed_replays", "held_out", "trap_set"]);
    expect(j.hero.proof.every((p) => p.url.startsWith(env.PUBLIC_ORIGIN))).toBe(true);
    expect(j.hero.secondary_ctas.map((c) => c.label)).toEqual(["Connect your AI", "Check a tool before install"]);
  });
});
