import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAnswerOutput, scanAnswerOutput } from "../src/mcp-output";
import { osvTransport } from "../src/services/advisories";
import { OWNER_CLAIM_FROM, OWNER_CLAIM_WHAT, ownerClaim } from "../src/services/compact";
import { normalizeFrom, OWNER_FROM } from "../src/services/owners";
import { visitCounters } from "../src/services/usage";
import { connectAgent, fetchWorker, fp } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// ADR 0126 (build list item 11): anonymous check and scan answers carry the owner step as data, `owner_claim`, a link
// to the /connect link step with a first-touch tag, so sign-ins started from answers are attributed in the owner
// funnel. Signed-in answers (/mcp with a token) carry none.

const origin = env.PUBLIC_ORIGIN;
const host = new URL(origin).host;
let n = 0;
const ip = () => `198.51.100.${(n++ % 200) + 30}`;
const SKILL = "---\nname: release-notes\ndescription: Drafts release notes from merged pull requests.\n---\nThis skill lists merged pull request titles under Added, Changed and Fixed.";
const CHECK = { url: `${origin}/connect?from=check-answer#link-step`, what: OWNER_CLAIM_WHAT, enables: ["forge_report", "agent_page", "per_agent_check_limit"] };
const SCAN = { ...CHECK, url: `${origin}/connect?from=scan-answer#link-step` };

async function rpc(path: string, name: string, args: unknown, headers: Record<string, string> = {}) {
  const res = await fetchWorker(path, {
    method: "POST",
    headers: { Host: host, "CF-Connecting-IP": ip(), "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5);
  const r = JSON.parse(json) as { result: { isError?: boolean; structuredContent: any; content: { text: string }[] } };
  expect(r.result.isError, `${name} on ${path}`).toBeFalsy();
  return r.result;
}
async function a2a(data: Record<string, unknown>) {
  const res = await fetchWorker("/a2a", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "data", data }] } } }) });
  return ((await res.json()) as any).result.parts[0].data;
}

const saved = osvTransport.fetch;
beforeEach(() => {
  osvTransport.fetch = (async () => Response.json({})) as typeof fetch;
});
afterEach(() => {
  osvTransport.fetch = saved;
});

describe("owner_claim in anonymous answers (ADR 0126)", () => {
  it("is a link to the /connect link step with a known first-touch tag, as data only", () => {
    expect(ownerClaim(origin, "check")).toEqual(CHECK);
    expect(ownerClaim(origin, "scan")).toEqual(SCAN);
    for (const tag of Object.values(OWNER_CLAIM_FROM)) {
      expect(OWNER_FROM as readonly string[]).toContain(tag);
      expect(normalizeFrom(tag)).toBe(tag);
    }
    // Data, never instructions: no imperative or steering wording, and no "ask your user…" prose.
    for (const kind of ["check", "scan"] as const) {
      const text = JSON.stringify(ownerClaim(origin, kind));
      expect(AGENT_DIRECTED.exec(text)?.[0] ?? null).toBeNull();
      expect(text).not.toMatch(/\b(ask|tell|have|get) (your|the) (user|human|owner)\b|\bplease\b|\bshould\b/i);
      // Compact: one small object.
      expect(new TextEncoder().encode(text).length).toBeLessThan(220);
    }
    // The MCP output schemas name it, so clients can rely on it.
    expect(checkAnswerOutput.shape.owner_claim).toBeDefined();
    expect(scanAnswerOutput.shape.owner_claim).toBeDefined();
  });

  it("REST /api/v1/check and /api/v1/scan carry it", async () => {
    const check = (await (await fetchWorker(`/api/v1/check?fingerprint=${fp("1")}`, { headers: { "CF-Connecting-IP": ip() } })).json()) as any;
    expect(Object.keys(check)[0]).toBe("summary");
    expect(check.owner_claim).toEqual(CHECK);
    const scan = (await (await fetchWorker("/api/v1/scan", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip() }, body: JSON.stringify({ text: SKILL }) })).json()) as any;
    expect(scan.verdict).toBe("clear");
    expect(scan.owner_claim).toEqual(SCAN);
  });

  it("/mcp/public forge_check (compact and full) and forge_scan carry it; the summary stays first", async () => {
    const compact = await rpc("/mcp/public", "forge_check", { fingerprint: fp("2") });
    expect(Object.keys(compact.structuredContent)[0]).toBe("summary");
    expect(compact.structuredContent.owner_claim).toEqual(CHECK);
    expect(JSON.parse(compact.content[0]!.text).owner_claim).toEqual(CHECK);
    const full = await rpc("/mcp/public", "forge_check", { fingerprint: fp("2"), detail: "full" });
    expect(full.structuredContent.owner_claim).toEqual(CHECK);
    const scan = await rpc("/mcp/public", "forge_scan", { text: SKILL });
    expect(scan.structuredContent.owner_claim).toEqual(SCAN);
  });

  it("A2A check-tool and scan-skill carry it", async () => {
    const c = await a2a({ skill: "check-tool", fingerprint: fp("3") });
    expect(c.skill).toBe("check-tool");
    expect(c.result.owner_claim).toEqual(CHECK);
    const s = await a2a({ skill: "scan-skill", text: SKILL });
    expect(s.skill).toBe("scan-skill");
    expect(s.result.owner_claim).toEqual(SCAN);
  });

  it("signed-in /mcp answers carry none: that agent already has an owner", async () => {
    const { token } = await connectAgent();
    const r = await rpc("/mcp", "forge_check", { fingerprint: fp("4") }, { Authorization: `Bearer ${token}` });
    expect(r.structuredContent.summary).toBeDefined();
    expect(r.structuredContent).not.toHaveProperty("owner_claim");
    const full = await rpc("/mcp", "forge_check", { fingerprint: fp("4"), detail: "full" }, { Authorization: `Bearer ${token}` });
    expect(full.structuredContent).not.toHaveProperty("owner_claim");
  });

  it("opening the link counts as a tagged arrival, and /connect carries the tag into the GitHub sign-in", async () => {
    const browser = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", "sec-fetch-dest": "document" };
    for (const [kind, tag] of [["check", "check-answer"], ["scan", "scan-answer"]] as const) {
      const url = ownerClaim(origin, kind).url;
      expect(visitCounters({ method: "GET", url, headers: new Headers(browser) }, origin)).toEqual(expect.arrayContaining(["visit:arrivals", `visit:tag:${tag}`]));
      const page = await (await fetchWorker(new URL(url).pathname + new URL(url).search)).text();
      expect(page).toContain('id="link-step"');
      expect(page).toContain(`/auth/login?from=${tag}&amp;next=`);
    }
  });
});
