import { describe, expect, it } from "vitest";
import { decide } from "../src/hooks/pre-install";

const verdict = (status: string, score: number | null = null, owners = 0) => ({
  known: true,
  tool: null,
  version: "1.0.0",
  forge_score: score,
  distinct_owners: owners,
  verified_owners: owners,
  security_status: status,
  page_url: "https://theagentforge.io/t/x",
});

const fakeFetch = (byId: Record<string, unknown>) =>
  (async (url: string) => {
    const id = decodeURIComponent(new URL(url).searchParams.get("id")!);
    if (!(id in byId)) throw new Error("offline");
    return Response.json(byId[id]);
  }) as unknown as typeof fetch;

describe("pre-install hook", () => {
  it("blocks a flagged package and says why", async () => {
    const out = await decide("npm install evil-pkg", "https://theagentforge.io", fakeFetch({ "npm:evil-pkg": verdict("flagged", null, 3) }));
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect((out?.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason).toContain("[F⚑]");
  });

  it("allows clear tools and prints the verdict for the human", async () => {
    const out = await decide("npm i good-pkg", "https://theagentforge.io", fakeFetch({ "npm:good-pkg": verdict("clear", 87, 41) }));
    expect(out?.hookSpecificOutput).toBeUndefined();
    expect(out?.systemMessage).toContain("[F✓] · clear · Forge Score 87");
  });

  it("warns the agent on caution but doesn't block", async () => {
    const out = await decide("npx shady-mcp", "https://theagentforge.io", fakeFetch({ "npm:shady-mcp": verdict("caution") }));
    expect(out?.hookSpecificOutput).toMatchObject({ additionalContext: expect.stringContaining("[F!]") });
    expect(out?.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });

  it("fails open when offline and ignores non-install commands", async () => {
    expect(await decide("npm i whatever", "https://theagentforge.io", fakeFetch({}))).toBeNull();
    expect(await decide("ls -la", "https://theagentforge.io", fakeFetch({}))).toBeNull();
  });
});
