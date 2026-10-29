import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AGENT_INDEX_CLOSED_NOTE, AGENT_INDEX_OPENS_AT, agentIndexOpen } from "../src/services/agent-index-gate";
import { fetchWorker, seedShownOwners } from "./helpers";
import "../src/index";

// ADR 0094: /agents and /agents.json list nothing until 10 outside owners have a claimed, shown, finished run.

const get = (path: string, accept = "text/html") => fetchWorker(path, { headers: { Accept: accept } });
const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const ADMIN_ID = Number(env.ADMIN_GITHUB_IDS.split(",")[0]);

async function expectClosed(handles: string[]) {
  expect(await agentIndexOpen(env)).toBe(false);
  const page = await get("/agents");
  expect(page.status).toBe(200);
  const body = await page.text();
  expect(unescape(body)).toContain(AGENT_INDEX_CLOSED_NOTE);
  expect(body).toContain('href="/gauntlet"');
  expect(body).toContain('href="/benchmark/submit"');
  expect(body).toContain('<meta name="robots" content="noindex">');
  // No rows, house or otherwise, and no link to any agent or run.
  expect(body).not.toMatch(/<table|\/arena\/agent\/|\/score\/|\/gauntlet\/r\/|>house</);
  for (const h of handles) expect(body).not.toContain(h);
  // Same note on any cursor page: the closed index can't be walked.
  expect(await (await get("/agents?before=1~a")).text()).not.toMatch(/<table|\/arena\/agent\//);
  const raw = await (await get("/agents.json", "application/json")).text();
  // ADR 0099: no threshold in the answer, only "opening soon".
  expect(JSON.parse(raw)).toEqual({ status: "opening_soon" });
  for (const h of handles) expect(raw).not.toContain(h);
  expect(await (await get("/sitemap.xml", "application/xml")).text()).not.toContain(`<loc>${env.PUBLIC_ORIGIN}/agents</loc>`);
}

describe("ADR 0094: the agent index opens at 10 outside owners", () => {
  it("holds below 10 (house, founder, hidden and revoked never count) and opens at exactly 10", async () => {
    expect(AGENT_INDEX_OPENS_AT).toBe(10);
    const seen: string[] = [];
    await expectClosed(seen);
    seen.push(...(await seedShownOwners(AGENT_INDEX_OPENS_AT - 1)));
    // None of these is an outside owner with a shown run, however many there are.
    seen.push(...(await seedShownOwners(5, { house: true })));
    seen.push(...(await seedShownOwners(1, { githubId: ADMIN_ID })));
    seen.push(...(await seedShownOwners(2, { hidden: true })));
    seen.push(...(await seedShownOwners(2, { revoked: true })));
    await expectClosed(seen);
    expect(await agentIndexOpen(env, AGENT_INDEX_OPENS_AT - 1)).toBe(true);

    const [tenth] = await seedShownOwners(1);
    expect(await agentIndexOpen(env)).toBe(true);
    const body = await (await get("/agents")).text();
    expect(body).not.toContain("data-agent-index-closed");
    expect(body).toContain(`href="/arena/agent/${tenth}"`);
    expect(body).toMatch(/>house<\/span>/);
    const j = (await (await get("/agents.json", "application/json")).json()) as any;
    expect(j.schema).toBe("forge-agent-index/1");
    expect(j.status).toBeUndefined();
    expect(j.agents.some((a: any) => a.handle === tenth)).toBe(true);
  });
});
