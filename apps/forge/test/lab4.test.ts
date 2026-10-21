import { trapCardText } from "@forge/shared";
import { describe, expect, it } from "vitest";
import { fetchWorker } from "./helpers";
import "../src/index";
import { armText } from "../src/arena/arms";
import { HEADLINE } from "../src/arena/lineup";
import { lab4Estimate, lab4Plans, LAB4_SEEDS } from "../src/arena/lab4";
import { planSchema } from "../src/arena/runner";
import cardFile from "../../../lab/004-trap-card-frontier/prompts/C-card.txt?raw";

describe("Forge Lab #4, as pre-registered", () => {
  it("queues 7 pairs × 2 arms on seeds 4001–4015, every plan valid, every model routed through OpenRouter", () => {
    const plans = lab4Plans();
    expect(plans).toHaveLength(14);
    for (const p of plans) {
      expect(planSchema.safeParse(p).success).toBe(true);
      expect(p.seeds).toEqual(LAB4_SEEDS);
      expect(HEADLINE.find((m) => m.id === p.models[0])?.route.kind).toBe("openrouter");
    }
    expect(new Set(plans.map((p) => p.slug)).size).toBe(14);
    expect(lab4Estimate()).toBeLessThan(32);
  });

  it("arm C is the same frozen card text as Lab #3", () => {
    expect(armText("card", "gemini-4-argon")).toBe(trapCardText());
    expect(cardFile.trim()).toBe(trapCardText().trim());
  });
});

describe("Lab #4 results are published (21 Oct 2026)", () => {
  it("/lab/4/results shows the write-up and all 210 bouts; the site says only what the pre-registration allows", async () => {
    const page = await (await fetchWorker("/lab/4/results", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Forge Lab #4 results");
    expect(page).toContain("Deviations from the plan");
    const counts = JSON.parse(await (await fetchWorker("/lab/4/results/counts.json")).text()) as { arm: string; n: number }[];
    expect(counts.reduce((s, r) => s + r.n, 0)).toBe(210);
    for (const arm of ["none", "card"]) expect(counts.filter((r) => r.arm === arm).every((r) => r.n === 15)).toBe(true);
    expect((await fetchWorker("/lab/4", { headers: { Accept: "text/html" } })).status).toBe(200);
    // H1 didn't hold: the pre-registered copy, and no claim that the card helps frontier models.
    const card = await (await fetchWorker("/trap-card", { headers: { Accept: "text/html" } })).text();
    expect(card).toContain("In our tests on frontier models, the card didn't measurably reduce traps");
    expect(card).not.toContain("Frontier models weren't part of this test");
    const json = (await (await fetchWorker("/trap-card.json")).json()) as { lab4: { measurable_reduction: boolean; bouts: number } };
    expect(json.lab4).toMatchObject({ measurable_reduction: false, bouts: 210 });
  });
});
