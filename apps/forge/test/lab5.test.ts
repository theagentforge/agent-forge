import { TRAP_CARD_MAX_CHARS, trapCardText } from "@forge/shared";
import { describe, expect, it } from "vitest";
import { armText, CARD_V11_TEXT } from "../src/arena/arms";
import { lab5Estimate, lab5Plans, LAB5_SEEDS } from "../src/arena/lab5";
import { HEADLINE } from "../src/arena/lineup";
import { planSchema } from "../src/arena/runner";
import selection from "../../../lab/005-trap-card-v11-frontier/selection.json";
import cardFile from "../../../lab/005-trap-card-v11-frontier/prompts/C-card.txt?raw";
import { fetchWorker } from "./helpers";
import "../src/index";

describe("Forge Lab #5, as pre-registered", () => {
  it("selects every pair at or above 1 in 3 without the card, and queues 4 pairs × 3 arms on seeds 5001–5030", () => {
    expect(selection.selected.map((p) => `${p.model} ${p.task}`)).toEqual(selection.baseline.filter((b) => b.fell / b.of >= 1 / 3).map((b) => `${b.model} ${b.task}`));
    const plans = lab5Plans();
    expect(plans).toHaveLength(12);
    for (const p of plans) {
      expect(planSchema.safeParse(p).success).toBe(true);
      expect(p.seeds).toEqual(LAB5_SEEDS);
      expect(HEADLINE.find((m) => m.id === p.models[0])?.route.kind).toBe("openrouter");
    }
    expect(new Set(plans.map((p) => p.slug)).size).toBe(12);
    expect(lab5Estimate()).toBeLessThan(26);
  });

  it("arm C is the frozen v1.0 card; arm E is v1.1, generic and within the card's length limit", () => {
    expect(cardFile.trim()).toBe(trapCardText().trim());
    expect(armText("card11", "gemini-4-argon")).toBe(CARD_V11_TEXT);
    expect(CARD_V11_TEXT.length).toBeLessThanOrEqual(TRAP_CARD_MAX_CHARS);
    expect(CARD_V11_TEXT).toMatch(/^Checks for my AI assistant \(Forge trap card v1\.1, 2026-10-21\):/);
    // Generic checks only: no job, model, order number or dollar figure named.
    expect(CARD_V11_TEXT).not.toMatch(/gemini|mistral|weekend|supplier|\bA\d{4}\b|\$\d/i);
  });

  it("the pre-registration is published at /lab/5 before any run", async () => {
    const page = await (await fetchWorker("/lab/5", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Forge Lab #5");
    expect((await fetchWorker("/lab/5/arm-e-card-v1.1.txt")).status).toBe(200);
  });
});
