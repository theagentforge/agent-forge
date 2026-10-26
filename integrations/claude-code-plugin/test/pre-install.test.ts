import { describe, expect, it } from "vitest";
import { emptyMemory } from "@forge/shared/light";
import { decide, parseClaimShown, pendingInstalls, withClaimLine, type Checked } from "../src/hooks/pre-install";
import { AGENT_DIRECTED } from "../../../apps/forge/test/wording";

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

  it("sends the pinned version, so a malicious-package advisory for that version blocks it", async () => {
    const urls: string[] = [];
    // Like the server: an advisory for litellm 1.107.0 flags that version; without a version it's only under review.
    const forge = (async (url: string) => {
      urls.push(url);
      const q = new URL(url).searchParams;
      return Response.json(verdict(q.get("id") === "pypi:litellm" && q.get("version") === "1.107.0" ? "flagged" : "caution"));
    }) as unknown as typeof fetch;
    const out = await decide("pip install litellm==1.107.0", "https://theagentforge.io", forge);
    expect(out?.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(urls).toEqual(["https://theagentforge.io/api/v1/check?id=pypi%3Alitellm&version=1.107.0"]);

    const bare = await decide("uv add litellm", "https://theagentforge.io", forge);
    expect(bare?.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(urls[1]).toBe("https://theagentforge.io/api/v1/check?id=pypi%3Alitellm");

    expect((await decide("npm i some-pkg@1.2.3", "https://theagentforge.io", forge))?.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(urls[2]).toBe("https://theagentforge.io/api/v1/check?id=npm%3Asome-pkg&version=1.2.3");
  });

  it("says what changed since this machine's last check, and ends each tool with its receipt link", async () => {
    const memory = emptyMemory();
    const receipt = "https://theagentforge.io/r/abc.0123";
    const first = { ...verdict("clear", null, 2), outcome_breakdown: { worked: 2, partial: 0, failed: 0 }, reports_for_this_version: 2, share: { receipt_url: receipt } };
    const one = await decide("npm i good-pkg@1.0.0", "https://theagentforge.io", fakeFetch({ "npm:good-pkg": first }), { memory, now: Date.parse("2026-10-19T10:00:00Z") });
    expect(one?.systemMessage.split("\n")).toEqual([expect.stringContaining("[F–]"), "  since last check: first check of this version from here", `  receipt: ${receipt}`]);
    expect(Object.keys(memory.checks)).toEqual(["npm:good-pkg@1.0.0"]);

    const later = { ...first, forge_score: 90, distinct_owners: 5, verified_owners: 5, reports_for_this_version: 5, outcome_breakdown: { worked: 4, partial: 0, failed: 1 }, public_signals_summary: { advisories: [{ id: "GHSA-1111-2222-3333", kind: "vulnerability" }] } };
    const two = await decide("npm i good-pkg@1.0.0", "https://theagentforge.io", fakeFetch({ "npm:good-pkg": later }), { memory, now: Date.parse("2026-10-26T10:00:00Z") });
    const since = "since last check (2026-10-19): 3 new field reports (2 worked, 1 failed); new published advisory GHSA-1111-2222-3333; verdict not enough reports yet → clear";
    expect(two?.systemMessage).toContain(`  ${since}`);
    expect(two?.systemMessage.split("\n").at(-1)).toBe(`  receipt: ${receipt}`);
    // The agent gets the change as data, not instructions.
    const ctx = (two?.hookSpecificOutput as { additionalContext: string }).additionalContext;
    expect(ctx).toBe(`npm:good-pkg@1.0.0: ${since}`);
    expect(ctx).not.toMatch(AGENT_DIRECTED);

    const three = await decide("npm i good-pkg@1.0.0", "https://theagentforge.io", fakeFetch({ "npm:good-pkg": later }), { memory, now: Date.parse("2026-10-27T10:00:00Z") });
    expect(three?.systemMessage).toContain("since last check (2026-10-26): no change");
    expect(three?.hookSpecificOutput).toBeUndefined();
  });

  it("words a block as data, with the overrides", async () => {
    const out = await decide("npm install evil-pkg", "https://theagentforge.io", fakeFetch({ "npm:evil-pkg": verdict("flagged", null, 3) }));
    const reason = (out?.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason;
    expect(reason).toContain("Overrides: the person runs the command themselves");
    expect(reason).not.toMatch(AGENT_DIRECTED);
  });

  it("notes each checked tool as a pending install, keyed by a hash of the command", async () => {
    const checked: Checked[] = [];
    await decide("npm i good-pkg@1.0.0", "https://theagentforge.io", fakeFetch({ "npm:good-pkg": { ...verdict("clear", 80, 6), tool: { id: "npm:good-pkg", kind: "mcp_server" }, fingerprint: `sha256:${"a".repeat(64)}` } }), { checked });
    const p = pendingInstalls(checked, "s1", "npm i good-pkg@1.0.0", 5);
    expect(p).toEqual([{ session: "s1", cmd: expect.stringMatching(/^[0-9a-f]{16}$/), at: 5, id: "npm:good-pkg", kind: "mcp_server", pinned: "1.0.0", known: true, check_version: "1.0.0", check_fp: `sha256:${"a".repeat(64)}` }]);
    expect(JSON.stringify(p)).not.toContain("npm i");
  });

  it("fails open when offline and ignores non-install commands", async () => {
    expect(await decide("npm i whatever", "https://theagentforge.io", fakeFetch({}))).toBeNull();
    expect(await decide("ls -la", "https://theagentforge.io", fakeFetch({}))).toBeNull();
  });
});

describe("claim line after a check (ADR 0055)", () => {
  const origin = "https://theagentforge.io";
  const now = Date.parse("2026-11-02T10:00:00Z");
  it("adds one plain line to the person's message, at most once a week, never to the agent's context", () => {
    const out = { systemMessage: "[F✓] · clear", hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "data" } };
    const first = withClaimLine(out, origin, null, now);
    expect(first.shown).toBe(true);
    expect(first.out.systemMessage!.split("\n").at(-1)).toBe("Claim your agent's Forge profile: https://theagentforge.io/gauntlet/claim?from=plugin");
    expect(first.out.hookSpecificOutput.additionalContext).toBe("data");
    expect(first.out.systemMessage).not.toMatch(AGENT_DIRECTED);
    expect(withClaimLine(out, origin, now - 86_400_000, now).shown).toBe(false);
    expect(withClaimLine(out, origin, now - 8 * 86_400_000, now).shown).toBe(true);
    // Nothing to add to when there's no message.
    expect(withClaimLine({}, origin, null, now).shown).toBe(false);
  });
  it("reads its local file safely", () => {
    expect(parseClaimShown(null)).toBeNull();
    expect(parseClaimShown("not json")).toBeNull();
    expect(parseClaimShown(JSON.stringify({ shown_at: 5 }))).toBe(5);
  });
});
