import { checkReplay, KEYS_PATH, refereeCheck, TASKS, type KeySet, type VerifySig } from "@forge/arena";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRACTICE } from "../src/arena/lineup";
import { planEvent, processQueue } from "../src/arena/runner";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { RESCORE_JOB_KEY, RESCORE_REPORT_KEY, rescoreTick } from "../src/arena/rescore-job";
import { keySet, replaySigner, sealRun, sha256Hex } from "../src/services/replay-keys";
import { VERIFY_CLI_VERSION, VERIFY_ON_NPM } from "../src/web/replay-verify";
import cliPackage from "../../../packages/cli/package.json";
import { fetchWorker } from "./helpers";
import { queueApprovedApply } from "./rescore-helpers";
import "../src/index";

// Replay format v2 (ADR 0066): new Arena bouts and Gauntlet jobs are hash-chained and sealed with an Ed25519 key derived
// from REPORT_SIGNING_KEY, whose public half is at /.well-known/forge-keys.json. Older runs stay format v1.

const enc = new TextEncoder();
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** A verifier from a published key set, using WebCrypto only (what any outside checker would do). */
const verifierFor =
  (ks: KeySet): VerifySig =>
  async (kid, message, signature) => {
    const k = ks.keys.find((x) => x.kid === kid);
    if (!k) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x }, { name: "Ed25519" }, false, ["verify"]);
    return crypto.subtle.verify({ name: "Ed25519" }, key, unb64(signature.replace(/^ed25519:/, "")), enc.encode(message));
  };

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const honest = [
  { tool_calls: [call("get_accounts", {})] },
  { tool_calls: [call("finish", { status: "cannot_complete", summary: "Checking doesn't have enough and savings is locked." })] },
];
function scripted(replies: { content?: string | null; tool_calls?: unknown[] }[]) {
  let i = 0;
  vi.spyOn(env.AI, "run").mockImplementation((async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return { choices: [{ message: { content: r.content ?? null, tool_calls: r.tool_calls ?? [] } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
  }) as never);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.KV.delete("arena:lock");
});

describe("the published key set", () => {
  it("serves one current Ed25519 key with its id, the rotation rules, and never any private part", async () => {
    const res = await fetchWorker(KEYS_PATH);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const ks = (await res.json()) as KeySet;
    expect(ks.format).toBe("forge-keys/1");
    expect(ks.origin).toBe(env.PUBLIC_ORIGIN);
    expect(ks.keys).toHaveLength(1);
    expect(ks.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", use: "sig", status: "current", retired: null });
    expect(ks.keys[0]!.kid).toMatch(/^forge-[0-9a-f]{16}$/);
    expect(Object.keys(ks.keys[0]!)).not.toContain("d");
    expect(JSON.stringify(ks)).not.toContain(env.REPORT_SIGNING_KEY);
    expect(ks.rotation.join(" ")).toMatch(/never removed/);
    expect(ks.rotation.join(" ")).toMatch(/forge-replay\/1/);
  });

  it("derives the same key from the same secret every time, and a different key from a different secret", async () => {
    const a = await replaySigner(env.REPORT_SIGNING_KEY);
    expect((await keySet(env)).keys[0]!.kid).toBe(a.kid);
    const b = await replaySigner(`${env.REPORT_SIGNING_KEY}-rotated`);
    expect(b.kid).not.toBe(a.kid);
    expect(b.x).not.toBe(a.x);
  });
});

describe("a new Arena bout is published as replay format v2", () => {
  it("chain, seal, signature and the re-run referee all check; tampering is caught", async () => {
    scripted(honest);
    const eventId = await planEvent(env, { slug: "replay-v2", name: "Replay v2", season: "s0", kind: "practice", models: [PRACTICE[0]!.id], tasks: ["impossible"], seeds: [7], attempts: 1 });
    expect((await processQueue(env, Date.now() + 60_000)).played).toBe(1);
    const [run] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    expect(run!.signature).toMatch(/^hmac-sha256:/); // v1 signature kept alongside
    expect(run!.replaySeal).toMatchObject({ format: "forge-replay/2", kind: "arena", run_id: run!.id, model: PRACTICE[0]!.id, rules: "rules 0.6" });

    const doc = (await (await fetchWorker(`/arena/run/${run!.id}.json`)).json()) as any;
    expect(doc.replay.format).toBe("forge-replay/2");
    expect(doc.replay.chain).toHaveLength(doc.log.length);
    expect(doc.replay.chain[0].prev).toBe("0".repeat(64));
    expect(doc.replay.chain[1].prev).toBe(doc.replay.chain[0].hash);
    const ks = (await (await fetchWorker(KEYS_PATH)).json()) as KeySet;
    const r = await checkReplay(doc, sha256Hex, verifierFor(ks));
    expect(r).toMatchObject({ format: 2, chain: "ok", record: "ok", signature: "ok", key_id: ks.keys[0]!.kid });
    expect(refereeCheck(doc)).toMatchObject({ checked: true, same_verdict: true, faithful: true, rules_of_run: "rules 0.6" });

    const bad = structuredClone(doc);
    bad.log[1].args = { tampered: true };
    expect((await checkReplay(bad, sha256Hex, verifierFor(ks))).chain).toBe("failed");
    const other = { ...ks, keys: [{ ...ks.keys[0]!, x: (await replaySigner("someone-else")).x }] };
    expect((await checkReplay(doc, sha256Hex, verifierFor(other))).signature).toBe("failed");

    const page = await (await fetchWorker(`/arena/run/${run!.id}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Replay format v2");
    expect(page).toContain(`/methodology#replays`);
    // CLI 0.5.1 (with `verify`) is on npm: the page shows the npx line, not the from-source steps.
    expect(page).toContain(`npx @theagentforge/cli@${VERIFY_CLI_VERSION} verify ${env.PUBLIC_ORIGIN}/arena/run/${run!.id}.json`);
    expect(page).not.toContain("node packages/cli/dist/cli.mjs verify");
    expect(page).not.toContain("isn't published yet");
  });

  it("a sealed run The Forge re-scores later still verifies: the sealed original is kept, the new verdict is re-checked", async () => {
    scripted(honest);
    const eventId = await planEvent(env, { slug: "replay-v2-rescore", name: "Replay v2 rescore", season: "s0", kind: "practice", models: [PRACTICE[0]!.id], tasks: ["impossible"], seeds: [9], attempts: 1 });
    await processQueue(env, Date.now() + 60_000);
    const db = getDb(env);
    const [run] = await db.select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    // A verdict from an older referee, sealed as it was stored then.
    const { rules: _stamp, ...unstamped } = run!.result as any;
    const old = { ...unstamped, passed: !(run!.result as any).passed };
    const seal = await sealRun(env, { kind: "arena", runId: run!.id, model: run!.modelId, rules: "rules 0.5", taskVersion: (run!.replaySeal as any).task_version, log: run!.log as any, result: old, signedAt: Date.now() });
    await db.update(t.arenaRuns).set({ passed: old.passed, result: old, replaySeal: seal }).where(eq(t.arenaRuns.id, run!.id));
    await env.KV.delete(RESCORE_REPORT_KEY);
    await queueApprovedApply({ events: [eventId] });
    expect((await rescoreTick(env))!.changed).toHaveLength(1);
    const doc = (await (await fetchWorker(`/arena/run/${run!.id}.json`)).json()) as any;
    expect(doc.result.passed).toBe(!old.passed);
    expect(doc.result.rescored.sealed).toEqual(old);
    const ks = (await (await fetchWorker(KEYS_PATH)).json()) as KeySet;
    expect(await checkReplay(doc, sha256Hex, verifierFor(ks))).toMatchObject({ chain: "ok", record: "ok", signature: "ok" });
    expect(refereeCheck(doc)).toMatchObject({ checked: true, same_verdict: true });
  });

  it("a run from before v2 says format v1, verifiable by its server signature only", async () => {
    scripted(honest);
    const eventId = await planEvent(env, { slug: "replay-v1", name: "Replay v1", season: "s0", kind: "practice", models: [PRACTICE[0]!.id], tasks: ["impossible"], seeds: [8], attempts: 1 });
    await processQueue(env, Date.now() + 60_000);
    const [run] = await getDb(env).select().from(t.arenaRuns).where(eq(t.arenaRuns.eventId, eventId));
    await getDb(env).update(t.arenaRuns).set({ replaySeal: null }).where(eq(t.arenaRuns.id, run!.id));
    const doc = (await (await fetchWorker(`/arena/run/${run!.id}.json`)).json()) as any;
    expect(doc.replay).toMatchObject({ format: "forge-replay/1", signature_alg: "hmac-sha256", verifiable_by: "server_only" });
    expect((await checkReplay(doc, sha256Hex, null)).format).toBe(1);
    const page = await (await fetchWorker(`/arena/run/${run!.id}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain("Replay format v1");
  });
});

describe("a new Gauntlet job is published as replay format v2", () => {
  it("each finished job's JSON verifies, with the job's own run id", async () => {
    const host = new URL(env.PUBLIC_ORIGIN).host;
    const rpc = async (name: string, args: unknown) => {
      const res = await fetchWorker("/mcp/gauntlet", {
        method: "POST",
        headers: { Host: host, "CF-Connecting-IP": "203.0.113.77", "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const text = await res.text();
      return JSON.parse(text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))!.slice(5)).result.structuredContent;
    };
    const start = await rpc("gauntlet_start", {});
    for (let i = 0; i < TASKS.length; i++) await rpc("gauntlet_act", { gauntlet_id: start.gauntlet_id, tool: "finish", args: { status: "cannot_complete", summary: "Stopping." } });
    const ks = (await (await fetchWorker(KEYS_PATH)).json()) as KeySet;
    for (const n of [1, 6]) {
      const res = await fetchWorker(`/gauntlet/r/${start.gauntlet_id}/${n}.json`);
      expect(res.status).toBe(200);
      const doc = (await res.json()) as any;
      expect(doc.id).toBe(`${start.gauntlet_id}/${n}`);
      expect(doc.replay.seal).toMatchObject({ kind: "gauntlet", model: null, run_id: doc.id });
      expect(await checkReplay(doc, sha256Hex, verifierFor(ks))).toMatchObject({ format: 2, chain: "ok", record: "ok", signature: "ok" });
      expect(refereeCheck(doc)).toMatchObject({ checked: true, same_verdict: true });
    }
    expect((await fetchWorker(`/gauntlet/r/${start.gauntlet_id}/7.json`)).status).toBe(404);
    const page = await (await fetchWorker(`/gauntlet/r/${start.gauntlet_id}/1`, { headers: { Accept: "text/html" } })).text();
    expect(page).toContain(`/gauntlet/r/${start.gauntlet_id}/1.json`);
    expect(page).toContain(`npx @theagentforge/cli@${VERIFY_CLI_VERSION} verify`);
    expect(page).not.toContain("node packages/cli/dist/cli.mjs verify");

    // A job with no seal (from before v2) says plainly that nothing signs it: Gauntlet jobs never had an HMAC signature.
    await getDb(env).update(t.arenaGauntletBouts).set({ replaySeal: null }).where(eq(t.arenaGauntletBouts.gauntletId, start.gauntlet_id));
    const v1 = (await (await fetchWorker(`/gauntlet/r/${start.gauntlet_id}/2.json`)).json()) as any;
    expect(v1.replay).toMatchObject({ format: "forge-replay/1", signature_alg: null, verifiable_by: "none" });
    expect(JSON.stringify(v1.replay)).not.toMatch(/hmac/i);
    const v1page = await (await fetchWorker(`/gauntlet/r/${start.gauntlet_id}/2`, { headers: { Accept: "text/html" } })).text();
    expect(v1page).toContain("Replay format v1: not signed");
    expect(v1page).not.toContain("and signed seal");
  });
});

describe("/methodology#replays", () => {
  it("documents the chain, the key URL, the CLI and the v1 rule", async () => {
    const body = await (await fetchWorker("/methodology", { headers: { Accept: "text/html" } })).text();
    expect(body).toContain('id="replays"');
    expect(body).toContain("/.well-known/forge-keys.json");
    expect(body).toContain("forge verify");
    expect(body).toContain(`npx @theagentforge/cli@${VERIFY_CLI_VERSION} verify &lt;replay URL or file&gt;`);
    expect(body).not.toContain("node packages/cli/dist/cli.mjs verify");
    expect(body).not.toContain("&amp;lt;");
    expect(body).toContain("verify by that signature only");
    expect(body).toContain("900001 to 900005");
  });
});

describe("the verify command the pages show", () => {
  it("shows npx only once the CLI version that has verify is the package's version", () => {
    const [maj, min] = (cliPackage as { version: string }).version.split(".").map(Number) as [number, number];
    const [vMaj, vMin] = VERIFY_CLI_VERSION.split(".").map(Number) as [number, number];
    const published = maj > vMaj || (maj === vMaj && min >= vMin);
    if (VERIFY_ON_NPM) expect(published).toBe(true);
  });
});
