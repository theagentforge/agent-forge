import { trapCardText } from "@forge/shared";
import { describe, expect, it } from "vitest";
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
