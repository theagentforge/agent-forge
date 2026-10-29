import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { briefBlocks, briefData } from "../src/reports/buyer-brief";
import { getDb } from "../src/services/db";
import { upsertHuman } from "../src/services/identity";
import { newSession, SESSION_COOKIE } from "../src/web/session";
import { fetchWorker, ORIGIN, profile } from "./helpers";
import cliSource from "../../../packages/cli/src/run.ts?raw";
import "../src/index";

// ADR 0116 (Dinike's operating procedure, 29 Oct): /pricing is the API's price list, not part of the acquisition story.
// The pages and files a buyer reads (/dataset and its JSON, the buyer brief, the data room, /about#investors) never link
// it; /pricing itself stays, linked from the API's own documentation (/teams, /connect, the CLI's help and llms.txt).

let adminCookie = "";
const PRICING = /\/pricing\b/;

beforeAll(async () => {
  const founder = await upsertHuman(getDb(env), profile({ id: Number(env.ADMIN_GITHUB_IDS) }), Date.now());
  adminCookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, founder.id)}`;
});

describe("/pricing stays out of the acquisition story", () => {
  it("/dataset, /dataset.json, the buyer brief, the data room and /about#investors don't link it", async () => {
    const dataset = await (await fetchWorker("/dataset", { headers: { Accept: "text/html" } })).text();
    expect(dataset).not.toMatch(PRICING);
    expect(await (await fetchWorker("/dataset.json")).text()).not.toMatch(PRICING);
    const blocks = briefBlocks(await briefData(env), ORIGIN);
    expect(JSON.stringify(blocks)).not.toMatch(PRICING);
    const room = await (await fetchWorker("/admin/data-room", { headers: { Cookie: adminCookie, Accept: "text/html" } })).text();
    expect(room).toContain("Data room");
    expect(room).not.toMatch(/href="[^"]*\/pricing"/);
    expect(await (await fetchWorker("/admin/data-room/pack.json", { headers: { Cookie: adminCookie } })).text()).not.toMatch(new RegExp(`${ORIGIN.replace(/\./g, "\\.")}/pricing\\b`));
    const about = await (await fetchWorker("/about", { headers: { Accept: "text/html" } })).text();
    const investors = about.slice(about.indexOf('id="investors"'));
    expect(investors.length).toBeGreaterThan(20);
    expect(investors.slice(0, investors.indexOf("<h2", 10) > 0 ? investors.indexOf("<h2", 10) : undefined)).not.toMatch(PRICING);
  });

  it("/pricing itself stays, linked from the API's documentation", async () => {
    expect((await fetchWorker("/pricing", { headers: { Accept: "text/html" } })).status).toBe(200);
    expect(await (await fetchWorker("/teams")).text()).toContain('href="/pricing"');
    expect(await (await fetchWorker("/connect")).text()).toContain('href="/pricing"');
    expect(await (await fetchWorker("/llms.txt")).text()).toContain("(/pricing)");
    expect(cliSource.slice(cliSource.indexOf("const HELP ="))).toContain("https://theagentforge.io/pricing");
  });
});
