import { describe, expect, it } from "vitest";
import { trapCardText } from "@forge/shared/light";
import { sessionContext } from "../src/hooks/session-start";

describe("SessionStart trap card (ADR 0017)", () => {
  it("adds the same generic card as the website, labelled as the user's own checks", () => {
    const ctx = sessionContext();
    expect(ctx).toContain(trapCardText());
    expect(ctx).toMatch(/^The Agent Forge plugin: the user's trap card \(v\d+\.\d+\)/);
    expect(ctx).not.toMatch(/https?:\/\//);
  });
});
