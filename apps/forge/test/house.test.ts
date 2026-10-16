import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { HOUSE_WORKFLOW, houseWorkflow, resetJwksCache, verifyHouseToken } from "../src/services/house";
import { upsertHuman } from "../src/services/identity";
import { fetchWorker, fp, profile, report } from "./helpers";
import "../src/index";

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

async function token(over: Record<string, unknown> = {}, signer = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc({
    iss: "https://token.actions.githubusercontent.com",
    aud: env.PUBLIC_ORIGIN,
    iat: now,
    exp: now + 300,
    repository: "theagentforge/forge",
    repository_id: "1418096645",
    job_workflow_ref: HOUSE_WORKFLOW,
    ref: "refs/heads/main",
    event_name: "schedule",
    ...over,
  });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

beforeEach(async () => {
  resetJwksCache();
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  jwk = { ...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey), kid: "k1" };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://token.actions.githubusercontent.com/.well-known/jwks") return Response.json({ keys: [jwk] });
    return realFetch(input, init);
  });
  vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
});

describe("House tester (GitHub Actions OIDC)", () => {
  it("accepts only our workflow on main, unexpired, for this site", async () => {
    expect(await verifyHouseToken(await token(), env.PUBLIC_ORIGIN)).not.toBeNull();
    const pub = { repository: "theagentforge/agent-forge", repository_id: "1421518455", job_workflow_ref: houseWorkflow("theagentforge/agent-forge") };
    expect(await verifyHouseToken(await token(pub), env.PUBLIC_ORIGIN), "public mirror").not.toBeNull();
    for (const bad of [
      { repository: "someone/fork" },
      { repository: "someone/fork", repository_id: "1", job_workflow_ref: houseWorkflow("someone/fork") },
      { ...pub, repository_id: "999" }, // a re-created repo with the same name
      { ...pub, job_workflow_ref: HOUSE_WORKFLOW }, // repo and workflow from different repos
      { repository_id: "1421518455" },
      { job_workflow_ref: "theagentforge/forge/.github/workflows/ci.yml@refs/heads/main" },
      { ref: "refs/heads/feature" },
      { job_workflow_ref: "theagentforge/forge/.github/workflows/house-tester.yml@refs/heads/feature" },
      { aud: "https://evil.example" },
      { exp: Math.floor(Date.now() / 1000) - 10 },
    ]) {
      expect(await verifyHouseToken(await token(bad), env.PUBLIC_ORIGIN), JSON.stringify(bad)).toBeNull();
    }
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    expect(await verifyHouseToken(await token({}, other.privateKey), env.PUBLIC_ORIGIN)).toBeNull();
    expect(await verifyHouseToken("not.a.jwt", env.PUBLIC_ORIGIN)).toBeNull();
  });

  it("files a labelled House report once the founder account is House", async () => {
    const post = async (tok: string) =>
      fetchWorker("/api/v1/house/report", {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(report({ tool: { kind: "mcp_server", id: "npm:house-probe-target", version: "1.0.0", fingerprint: fp("7") }, task: { category: "mcp-handshake", framework: "other" } })),
      });
    expect((await post("forged")).status).toBe(401);

    const db = getDb(env);
    const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS), login: "founder" }), Date.now());
    expect((await post(await token())).status).toBe(409); // founder not House yet
    await db.update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, founder.id));

    const res = await post(await token());
    expect(res.status).toBe(201);
    const agent = await db.query.agents.findFirst({ where: eq(t.agents.handle, "house-tester") });
    expect(agent?.humanId).toBe(founder.id);
    const page = await (await fetchWorker("/a/house-tester")).text();
    expect(page).toContain(">house</span>");

    // A repeat on the same version is acknowledged but not stored again.
    const again = await post(await token());
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });
    const filed = await db.select().from(t.reports).where(eq(t.reports.agentId, agent!.id));
    expect(filed).toHaveLength(1);
  });

  it("doesn't spend AI moderation on the House tester's own note template", async () => {
    const db = getDb(env);
    const founder = await upsertHuman(db, profile({ id: Number(env.ADMIN_GITHUB_IDS), login: "founder" }), Date.now());
    await db.update(t.humans).set({ isHouse: true }).where(eq(t.humans.id, founder.id));
    const ai = vi.spyOn(env.AI, "run");
    ai.mockClear();
    const note = "House handshake test: started with npx, no credentials, and listed 3 tools in 4s.";
    const res = await fetchWorker("/api/v1/house/report", {
      method: "POST",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(report({ tool: { kind: "mcp_server", id: "npm:house-note-target", version: "1.0.0", fingerprint: fp("8") }, task: { category: "mcp-handshake", framework: "other" }, note })),
    });
    expect(res.status).toBe(201);
    expect(ai).not.toHaveBeenCalled();
    const [row] = await db.select().from(t.reports).where(eq(t.reports.note, note));
    expect(row?.moderationState).toBe("approved");
  });
});

describe("House Report (ADR 0011 b)", () => {
  const entry = (pkg: string, outcome: string, over: Record<string, unknown> = {}) => ({ pkg, version: "1.0.0", outcome, slow: false, tools: outcome === "worked" ? 3 : null, ms: 4000, downloads: 1000, rank: 1, ...over });
  const send = async (tok: string, body: unknown) =>
    fetchWorker("/api/v1/house/run", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("accepts the night's results only from our workflow, validated", async () => {
    const run = { probedAt: "2026-10-08T03:00:00.000Z", entries: [entry("alpha-mcp", "worked"), entry("beta-mcp", "worked", { rank: 2 })] };
    expect((await send("forged", run)).status).toBe(401);
    expect((await send(await token(), { ...run, entries: [entry("bad name;", "worked")] })).status).toBe(422);
    expect((await send(await token(), { ...run, entries: [entry("x", "hacked")] })).status).toBe(422);
    expect((await send(await token(), run)).status).toBe(201);
  });

  it("publishes the page, what broke this week, and the dataset", async () => {
    const week = { probedAt: "2026-10-08T03:00:00.000Z", entries: [entry("alpha-mcp", "worked"), entry("beta-mcp", "worked", { rank: 2 })] };
    const now = {
      probedAt: "2026-10-15T03:00:00.000Z",
      entries: [entry("alpha-mcp", "worked", { rank: 1, slow: true }), entry("beta-mcp", "no_answer", { rank: 2, tools: null }), entry("gamma-mcp", "needs_config", { rank: 3 }), entry("delta-mcp", "error", { rank: 4 })],
    };
    expect((await send(await token(), week)).status).toBe(201);
    expect((await send(await token(), now)).status).toBe(201);
    expect((await send(await token(), now)).status).toBe(201); // a re-run the same day replaces, never double counts

    const page = await (await fetchWorker("/reports/house", { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("The Forge House Report");
    expect(page).toContain("33.3%"); // 1 of 3 (the test error isn't counted against anyone)
    expect(page).toMatch(/Broke this week[\s\S]*beta-mcp/);
    expect(page).toContain("started and listed its tools (slow)");

    const json = (await (await fetchWorker("/reports/house.json")).json()) as { counts: Record<string, number>; history: { day: string }[] };
    expect(json.counts).toMatchObject({ worked: 1, no_answer: 1, needs_config: 1, error: 1 });
    expect(json.history.filter((h) => h.day === "2026-10-15")).toHaveLength(1);

    const csv = await (await fetchWorker("/reports/house.csv")).text();
    expect(csv.split("\n")[0]).toBe("rank,package,version,outcome,slow,tools,ms,weekly_downloads");
    expect(csv).toContain("2,beta-mcp,1.0.0,no_answer,false,,4000,1000");
  });
});
