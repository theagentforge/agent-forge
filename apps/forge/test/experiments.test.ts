import { describe, expect, it } from "vitest";
import { fetchWorker } from "./helpers";
import "../src/index";
import { EXPERIMENTS, experimentsData, intervalText, pct } from "../src/web/experiments";
import { experimentsBlock } from "../src/web/home-wire";
import { ALL_MODELS } from "../src/arena/lineup";
import { EMBARGOED_LINEUP } from "../src/arena/lineup-embargoed";
import lab3Counts from "../../../lab/003-trap-cards/counts.json";
import lab4Counts from "../../../lab/004-trap-card-frontier/counts.json";
import lab3Output from "../../../lab/003-trap-cards/analysis-output.md?raw";
import lab4Output from "../../../lab/004-trap-card-frontier/analysis-output.md?raw";

// Boardy review item 3 (W1.2): the experiment results block. Experiment 3 (Lab #3, small open models) and Experiment 4
// (Lab #4, frontier models) are always shown together, and every number is computed from the published counts.json,
// checked here against the output of each Lab's own analyze.mjs (analysis-output.md), never typed in.

/** "Mantel–Haenszel risk ratio C vs A: 0.464 (95% CI 0.414–0.519)" from a Lab's analysis output. */
function mhFromOutput(md: string) {
  const m = md.match(/Mantel–Haenszel risk ratio C vs A: ([\d.]+) \(95% CI ([\d.]+)–([\d.]+)\)/);
  if (!m) throw new Error("risk ratio line not found");
  return { rr: Number(m[1]), lo: Number(m[2]), hi: Number(m[3]) };
}

describe("the experiments' numbers come from the published data", () => {
  it("matches each Lab's analysis script: risk ratio, interval and bout counts", () => {
    const [e3, e4] = EXPERIMENTS;
    for (const [e, out, rows] of [[e3, lab3Output, lab3Counts], [e4, lab4Output, lab4Counts]] as const) {
      const ref = mhFromOutput(out);
      expect(1 - e.stats.fewer).toBeCloseTo(ref.rr, 3);
      expect(1 - e.stats.fewerHi).toBeCloseTo(ref.lo, 3);
      expect(1 - e.stats.fewerLo).toBeCloseTo(ref.hi, 3);
      const sum = (arm: string) => rows.filter((r) => r.arm === arm).reduce((s, r) => s + r.n, 0);
      expect(e.stats.card.n).toBe(sum("card"));
      expect(e.stats.none.n).toBe(sum("none"));
      expect(e.stats.boutsTotal).toBe(rows.reduce((s, r) => s + r.n, 0));
    }
    // Experiment 3 is significant with a placebo arm; Experiment 4's interval crosses zero.
    expect(e3.stats.significant).toBe(true);
    expect(e3.stats.placebo?.n).toBe(e3.stats.card.n);
    expect(e4.stats.significant).toBe(false);
    expect(e4.stats.fewerLo).toBeLessThan(0);
    expect(e4.stats.fewerHi).toBeGreaterThan(0);
    expect(e4.stats.placebo).toBeNull();
  });

  it("the JSON twins carry the same computed numbers", async () => {
    const data = experimentsData();
    expect(data.map((d) => d.id)).toEqual(["experiment-3", "experiment-4"]);
    expect(data[1]).toMatchObject({ statistically_significant: false, bouts: EXPERIMENTS[1].stats.boutsTotal });
    const home = (await (await fetchWorker("/", { headers: { Accept: "application/json" } })).json()) as { trap_card_experiments: unknown };
    expect(home.trap_card_experiments).toEqual(data);
    const card = (await (await fetchWorker("/trap-card.json")).json()) as { lab3: { relative_reduction: number; bouts: number }; lab4: { relative_reduction: number; bouts: number; measurable_reduction: boolean } };
    expect(card.lab3).toMatchObject({ relative_reduction: data[0]!.relative_reduction, bouts: EXPERIMENTS[0].stats.card.n + EXPERIMENTS[0].stats.none.n });
    expect(card.lab4).toMatchObject({ relative_reduction: data[1]!.relative_reduction, bouts: 210, measurable_reduction: false });
  });
});

describe("the experiments block shows both experiments together", () => {
  const [e3, e4] = EXPERIMENTS;
  const check = (body: string, from: string) => {
    const a = body.indexOf('id="experiment-3"'), b = body.indexOf('id="experiment-4"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    // Same grid: nothing but Experiment 3's own card between the two.
    expect(body.slice(body.lastIndexOf('<div class="exp-grid">', a), b)).not.toContain("</section>");
    expect(body).toContain("Experiment 3: does the free trap card help small open models?");
    expect(body).toContain("Experiment 4: does it help frontier models?");
    expect(body).toContain(`<a class="exp-lab" href="/lab/3/results?from=${from}">(Lab #3)</a>`);
    expect(body).toContain(`<a class="exp-lab" href="/lab/4/results?from=${from}">(Lab #4)</a>`);
    // Numbers as computed, with n and the interval.
    expect(body).toContain(`fell for ${pct(e3.stats.fewer)}% fewer traps on new versions of the jobs</b> (95% interval ${intervalText(e3.stats)};`);
    expect(body).toContain(`n = ${e3.stats.card.n} bouts per arm`);
    expect(body).toContain(`Placebo arm:</b>`);
    expect(body).toContain("In our tests on frontier models, the card didn't measurably reduce traps.");
    expect(body).toContain(`n = ${e4.stats.card.n} bouts per arm`);
    const exp4 = body.slice(b, body.indexOf("</article>", b));
    if (from === "home-lab") {
      // The home page's best-estimate line is Dinike's choice (25 Oct); the interval is always next to it.
      expect(exp4).toContain(`Our card's best estimate is ${pct(e4.stats.fewer)}% fewer, but ${e4.stats.boutsTotal} bouts weren't enough to prove it (95% interval ${intervalText(e4.stats)}, so the card may have had no effect; not statistically significant`);
    } else {
      // Lab #4's pre-registration: when H1 fails, the only copy allowed is "didn't measurably reduce traps". No
      // reduction percentage or estimate; the raw counts may be shown.
      expect(exp4).not.toMatch(/\d+\s?%/);
      expect(exp4).not.toContain("best estimate");
      expect(exp4).toContain(`They fell for a planted trap in ${e4.stats.card.trapped} of ${e4.stats.card.n} bouts with the card and ${e4.stats.none.trapped} of ${e4.stats.none.n} without, a difference that could be chance`);
    }
    // No model names in the block: neither the Labs' models nor any in the lineup, including those under embargo (the
    // embargoed list is empty in the public mirror, so no name is written here).
    const block = body.slice(body.lastIndexOf('<div class="exp-grid">', a), body.indexOf("</article>", b));
    const names = [...[...lab3Counts, ...lab4Counts].map((r) => r.model), ...[...ALL_MODELS, ...EMBARGOED_LINEUP].flatMap((m) => [m.id, m.name])];
    for (const m of new Set(names)) expect(block).not.toContain(m);
  };

  it("on the home page, high up, before the Arena", async () => {
    const body = await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text();
    check(body, "home-lab");
    expect(body.indexOf('id="experiments"')).toBeLessThan(body.indexOf('id="arena-title"') > 0 ? body.indexOf('id="arena-title"') : Infinity);
  });

  it("on /trap-card, above the paste guides", async () => {
    const body = await (await fetchWorker("/trap-card", { headers: { Accept: "text/html" } })).text();
    check(body, "trap-card");
    expect(body.indexOf('id="experiments"')).toBeLessThan(body.indexOf('id="where"'));
  });

  it("the Lab pages carry the plain names; the /lab/N URLs stay", async () => {
    for (const [path, name, who] of [["/lab/3/results", "Experiment 3", "small open models"], ["/lab/4/results", "Experiment 4", "frontier models"], ["/lab/4", "Experiment 4", "frontier models"]] as const) {
      const res = await fetchWorker(path, { headers: { Accept: "text/html" } });
      expect(res.status).toBe(200);
      const page = await res.text();
      expect(page).toContain(`<p class="eyebrow experiment-name">${name}`);
      // The scope is in the title itself, so a search result or a shared link can't read Lab #3 as covering all models.
      expect(page).toMatch(new RegExp(`<title>${name} \\(${who}\\): `));
    }
  });

  it("renders the two-up grid on its own, for any page that includes it", () => {
    expect(String(experimentsBlock("x"))).toContain("exp-grid");
  });
});
