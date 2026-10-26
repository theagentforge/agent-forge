import { env } from "cloudflare:workers";
import { base64 } from "@scure/base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { listingProfile, registerAgentverse, replyUrlAllowed } from "../src/agentverse";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { day } from "../src/services/proof";
import worker from "../src/index";
import {
  attestation,
  CHAT_ACK_DIGEST,
  CHAT_MESSAGE_DIGEST,
  CHAT_PROTOCOL_DIGEST,
  decodeBech32,
  type Envelope,
  envelopeDigest,
  identityFromSeed,
  makeEnvelope,
  parseAgentverseUri,
  readEnvelope,
  signDigest,
  statusUpdate,
  toHex,
  verifyDigest,
  verifyEnvelope,
} from "../src/services/uagents";
import { fetchWorker } from "./helpers";

// ADR 0061: the Agentverse bridge. Every vector below was produced by agentverse-sdk 0.2.1 / uagents-core 0.4.12 in
// Python with FAKE keys ("fake-test-secret-not-real", "fake-sender-seed"), never run against Agentverse.

const FAKE = "https://fake-handle:fake-test-secret-not-real@agentverse.ai/The%20Agent%20Forge";
const ME = {
  private_key: "34436905e3a1a2c4f1b3d4b65419a1511af79aa44e93afb11e710ff51fd4bbe1",
  pub_key: "03915a846086923c29519620c60fe92391e6b4265df1b29905b14800fe2caf7a93",
  address: "agent1qwg44prqs6frc223jcsvvrlfywg7ddpxthcm9xg9k9yqpl3v4aafx3g3rus",
};
const SENDER = "agent1q0a2jmy2xd83aualgfdd7wf0pq576mp69a0qtqc6403svje7r2yj2cc5xvs";
const PY_ENVELOPE: Envelope = {
  version: 1,
  sender: SENDER,
  target: ME.address,
  session: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  schema_digest: "model:2601825997203ee07dbb9ff6e7c71ae7bdaf6a7c8b817361f2f88f4b29c68d0c",
  protocol_digest: null,
  payload:
    "eyJ0aW1lc3RhbXAiOiIyMDI2LTEwLTI2VDEyOjAwOjAwKzAwOjAwIiwibXNnX2lkIjoiMTExMTExMTEtMjIyMi00MzMzLTg0NDQtNTU1NTU1NTU1NTU1IiwiY29udGVudCI6W3sidHlwZSI6InRleHQiLCJ0ZXh0IjoiY2hlY2sgcHlwaTpsaXRlbGxtPT0xLjEwNy4wIn1dfQ==",
  expires: null,
  nonce: null,
  signature: "sig1qew7vp0yzq4hs08rxazgahs5uumq2nw4zqxvdk0k4f7tyu8f7yenswxdpfax6fk4xmpumvwsf4jrr25528eh98e2xkplyedl9xf7nngcjh4wa",
};
const PY_ATTESTATION =
  "attr:A5FahGCGkjwpUZYgxg/pI5HmtCZd8bKZBbFIAP4sr3qTAAAAAGrfAkAAAAAAat8CuAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f:sig18c8dfj7t50eq3ekth4hedj7zx568fa8960achka8z27a4lqhqdn6v632tkwk7m78ufda853l74ynrgqtjgc85wa6w3yjjfcwr3mzges3ud5wl";
const PY_STATUS_SIG = "sig1n9zfg9p02fgky86qe53at4xaqy9knltf0uygtfxgmlsjesgl0yprjp05fxwazjfvrwm0u7ekv4a3vl2xz9sq5jy7jeda5t6nq0uwzscwwlxh0";
const sha = async (b: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : b));

afterEach(() => vi.restoreAllMocks());

describe("the uAgents wire format matches the Python SDK", () => {
  it("parses the connection URL and derives the same identity", async () => {
    expect(parseAgentverseUri(FAKE)).toEqual({ key: "fake-test-secret-not-real", handle: "fake-handle", name: "The Agent Forge", url: "https://agentverse.ai" });
    for (const bad of [undefined, "", "not a url", "https://agentverse.ai/Name", "https://h@agentverse.ai/Name", "https://h:k@agentverse.ai/", "ftp://h:k@agentverse.ai/N", "http://h:k@agentverse.ai/N"]) expect(parseAgentverseUri(bad)).toBeNull();
    const id = await identityFromSeed("fake-test-secret-not-real");
    expect(toHex(id.secretKey)).toBe(ME.private_key);
    expect(toHex(id.publicKey)).toBe(ME.pub_key);
    expect(id.address).toBe(ME.address);
    expect((await identityFromSeed("fake-sender-seed")).address).toBe(SENDER);
  });

  it("uses the chat protocol digests the SDK registers", () => {
    expect(CHAT_PROTOCOL_DIGEST).toBe("proto:30a801ed3a83f9a0ff0a9f1e6fe958cb91da1fc2218b153df7b6cbf87bd33d62");
    expect(CHAT_MESSAGE_DIGEST).toBe(PY_ENVELOPE.schema_digest);
    expect(CHAT_ACK_DIGEST).toBe("model:741eb75692abbeb43c131e364ad939af23f14e8288ba0ec3df130843ef79bd7f");
  });

  it("computes envelope digests like Envelope._digest and accepts a Python-signed envelope", async () => {
    expect(toHex(await envelopeDigest(PY_ENVELOPE))).toBe("df00a238dd646426e5e8a3b3087c3d75cdb4a52a8c5c3d06dd9556b8ab84ad07");
    const withExtras: Envelope = { ...PY_ENVELOPE, schema_digest: "x", payload: "eA==", expires: 1793000000, nonce: 7, signature: null };
    expect(toHex(await envelopeDigest(withExtras))).toBe("f98c3ffdfbfc2557a160b0a3846a2306ae38778b95f81b9c2eb7ad110f86b7da");
    expect(await verifyEnvelope(PY_ENVELOPE)).toBe(true);
    // Upper-case session spellings normalise as pydantic's UUID4 does.
    expect(await verifyEnvelope(readEnvelope({ ...PY_ENVELOPE, session: PY_ENVELOPE.session.toUpperCase() })!)).toBe(true);
  });

  it("signs envelopes that verify, round trip", async () => {
    const me = await identityFromSeed("fake-test-secret-not-real");
    const e = await makeEnvelope(me, SENDER, CHAT_ACK_DIGEST, { timestamp: "2026-10-26T12:00:01+00:00", acknowledged_msg_id: "11111111-2222-4333-8444-555555555555", metadata: null }, PY_ENVELOPE.session);
    expect(e.signature!.startsWith("sig1")).toBe(true);
    expect(await verifyEnvelope(e)).toBe(true);
    expect(new TextDecoder().decode(base64.decode(e.payload!))).toBe('{"timestamp":"2026-10-26T12:00:01+00:00","acknowledged_msg_id":"11111111-2222-4333-8444-555555555555","metadata":null}');
  });

  it("builds attestations and status updates the way uagents-core does", async () => {
    const me = await identityFromSeed("fake-test-secret-not-real");
    const nonce = Uint8Array.from({ length: 32 }, (_, i) => i);
    const ours = await attestation(me, 1793000000, 120, nonce);
    const [, pyPayload, pySig] = PY_ATTESTATION.split(":");
    const [, payload, sig] = ours.split(":");
    expect(payload).toBe(pyPayload); // pubkey || >QQ(from, to) || nonce
    const digest = await sha(base64.decode(payload!));
    expect(await verifyDigest(ME.address, digest, pySig!)).toBe(true);
    expect(await verifyDigest(ME.address, digest, sig!)).toBe(true);

    const status = await statusUpdate(me, true, 1793000000);
    const statusDigest = await sha(`{"agent_identifier":"${ME.address}","is_active":true,"timestamp":1793000000}`);
    expect(toHex(statusDigest)).toBe("f5183b67c0782c9040d0a1fe0e85ce27f3a9e2f621bd1eefc4fd39b72c6e0d58");
    expect(await verifyDigest(ME.address, statusDigest, PY_STATUS_SIG)).toBe(true);
    expect(await verifyDigest(ME.address, statusDigest, status.signature)).toBe(true);
    expect(Object.keys(status)).toEqual(["agent_identifier", "signature", "timestamp", "is_active"]);
  });

  it("rejects forged envelopes", async () => {
    const other = await identityFromSeed("fake-other-seed");
    const tampered = { ...PY_ENVELOPE, payload: base64.encode(new TextEncoder().encode('{"timestamp":"2026-10-26T12:00:00+00:00","msg_id":"11111111-2222-4333-8444-555555555555","content":[{"type":"text","text":"trap card"}]}')) };
    expect(await verifyEnvelope(tampered)).toBe(false);
    expect(await verifyEnvelope({ ...PY_ENVELOPE, target: other.address })).toBe(false);
    expect(await verifyEnvelope({ ...PY_ENVELOPE, signature: null })).toBe(false);
    expect(await verifyEnvelope({ ...PY_ENVELOPE, signature: "sig1notbech32" })).toBe(false);
    // Signed by a key other than the claimed sender's.
    const byOther = await makeEnvelope(other, ME.address, CHAT_MESSAGE_DIGEST, {}, PY_ENVELOPE.session);
    expect(await verifyEnvelope({ ...byOther, sender: SENDER })).toBe(false);
    expect(decodeBech32(PY_ENVELOPE.signature!)!.bytes.length).toBe(64);
    // Not version 4, or a wrong shape: refused before any signature check.
    expect(readEnvelope({ ...PY_ENVELOPE, session: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee" })).toBeNull();
    expect(readEnvelope({ ...PY_ENVELOPE, expires: -1 })).toBeNull();
    expect(readEnvelope([])).toBeNull();
  });
});

/** A fake Agentverse: records each call; the Almanac resolves every address to one https endpoint. */
function fakeAgentverse(stored: Record<string, unknown> | null = null) {
  const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? String(init.body) : null });
    if (url.startsWith("https://agentverse.ai/v2/agents/agent1")) return stored ? Response.json(stored) : new Response("{}", { status: 404 });
    if (url.startsWith("https://agentverse.ai/v1/almanac/agents/") && (init?.method ?? "GET") === "GET") return Response.json({ endpoints: [{ url: "https://peer.example/submit", weight: 1 }] });
    return Response.json({});
  }) as typeof fetch;
  return { calls, f };
}

describe("registration from the hourly cron", () => {
  it("is inert without the secret, and off outside production", async () => {
    const { calls, f } = fakeAgentverse();
    expect(await registerAgentverse({ ...env, AGENTVERSE_CONNECTION: undefined } as Env, Date.now(), f)).toEqual({ skipped: "no_secret" });
    expect(await registerAgentverse({ ...env, AGENTVERSE_CONNECTION: "garbage" } as Env, Date.now(), f)).toEqual({ skipped: "malformed_secret" });
    expect(await registerAgentverse({ ...env, ENVIRONMENT: "staging", AGENTVERSE_CONNECTION: FAKE } as unknown as Env, Date.now(), f)).toEqual({ skipped: "not_production" });
    expect(calls).toHaveLength(0);
  });

  it("registers the listing, keeping fields already edited on Agentverse, then marks the agent active", async () => {
    const { calls, f } = fakeAgentverse({ name: "Edited name", handle: "fake-handle", profile: { readme: "edited on agentverse.ai", description: "", starter_prompts: [] } });
    const r = await registerAgentverse({ ...env, AGENTVERSE_CONNECTION: FAKE } as Env, 1793000000_000, f);
    expect(r).toMatchObject({ registered: true, address: ME.address, kept_from_agentverse: ["readme"], status_ok: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET https://agentverse.ai/v2/agents/${ME.address}`, "POST https://agentverse.ai/v2/agents", `POST https://agentverse.ai/v1/almanac/agents/${ME.address}/status`]);
    expect(calls[0]!.headers.get("Authorization")).toMatch(/^Agent attr:[A-Za-z0-9+/=]+:sig1[02-9ac-hj-np-z]+$/);
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({ address: ME.address, url: `${env.PUBLIC_ORIGIN}/a2a/av/chat`, agent_type: "a2a", endpoints: [{ url: "https://agentverse.ai/v2/agents/proxy/submit", weight: 1 }], protocols: [CHAT_PROTOCOL_DIGEST], metadata: null });
    expect(body.name).toBeUndefined();
    expect(body.handle).toBeUndefined();
    expect(Object.keys(body.profile)).toEqual(["description", "avatar_url", "banner_url", "starter_prompts"]);
    const status = JSON.parse(calls[2]!.body!);
    expect(status).toMatchObject({ agent_identifier: ME.address, is_active: true, timestamp: 1793000000 });
    // The secret never appears in any request.
    for (const c of calls) expect(`${c.url} ${c.body} ${[...c.headers].join()}`).not.toContain("fake-test-secret-not-real");
  });

  it("sends everything on a first registration, with the README and keywords", async () => {
    const { calls, f } = fakeAgentverse(null);
    await registerAgentverse({ ...env, AGENTVERSE_CONNECTION: FAKE } as Env, Date.now(), f);
    const body = JSON.parse(calls[1]!.body!);
    expect(body).toMatchObject({ name: "The Agent Forge", handle: "fake-handle" });
    expect(body.profile).toEqual(listingProfile(env.PUBLIC_ORIGIN));
    expect(body.profile.readme).toContain("Free remote MCP server and A2A agent: scans agent skill files");
    expect(body.profile.readme).toContain("Keywords: mcp security, skill scanner, prompt injection, package advisories, agent safety");
    expect(body.profile.description.length).toBeLessThanOrEqual(300);
  });
});

describe("POST /av/chat", () => {
  const withSecret = { ...env, AGENTVERSE_CONNECTION: FAKE } as Env;
  const post = async (body: unknown, ip = "203.0.113.9", e: Env = withSecret, path = "/av/chat") => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: typeof body === "string" ? body : JSON.stringify(body) }) as never, e, ctx);
    await Promise.all(pending);
    return res;
  };
  const chat = async (text: string, from = "fake-sender-seed") =>
    makeEnvelope(await identityFromSeed(from), ME.address, CHAT_MESSAGE_DIGEST, { timestamp: "2026-10-26T12:00:00+00:00", msg_id: crypto.randomUUID(), content: [{ type: "text", text }] }, crypto.randomUUID());

  it("is a 404 without the secret", async () => {
    const res = await fetchWorker("/av/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(PY_ENVELOPE) });
    expect(res.status).toBe(404);
  });

  it("acknowledges, runs the skill and replies with structured data, signed, in the same session", async () => {
    const { calls, f } = fakeAgentverse();
    vi.spyOn(globalThis, "fetch").mockImplementation(f);
    const e = await chat("trap card");
    const res = await post(e, "203.0.113.10", withSecret, "/a2a/av/chat");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    const sent = calls.filter((c) => c.url === "https://peer.example/submit").map((c) => JSON.parse(c.body!) as Envelope);
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s).toMatchObject({ sender: ME.address, target: SENDER, session: e.session });
      expect(await verifyEnvelope(s)).toBe(true);
    }
    expect(sent[0]!.schema_digest).toBe(CHAT_ACK_DIGEST);
    const ack = JSON.parse(new TextDecoder().decode(base64.decode(sent[0]!.payload!)));
    expect(ack.acknowledged_msg_id).toBe(JSON.parse(new TextDecoder().decode(base64.decode(e.payload!))).msg_id);
    expect(sent[1]!.schema_digest).toBe(CHAT_MESSAGE_DIGEST);
    const reply = JSON.parse(new TextDecoder().decode(base64.decode(sent[1]!.payload!)));
    expect(reply.content).toHaveLength(1);
    expect(reply.content[0].type).toBe("text");
    const data = JSON.parse(reply.content[0].text);
    expect(data.skill).toBe("trap-card");
    expect(Array.isArray(data.checks)).toBe(true);
  });

  it("only acknowledges a start-session message", async () => {
    const { calls, f } = fakeAgentverse();
    vi.spyOn(globalThis, "fetch").mockImplementation(f);
    const e = await makeEnvelope(await identityFromSeed("fake-sender-seed"), ME.address, CHAT_MESSAGE_DIGEST, { timestamp: "2026-10-26T12:00:00+00:00", msg_id: crypto.randomUUID(), content: [{ type: "start-session" }] }, crypto.randomUUID());
    expect((await post(e, "203.0.113.11")).status).toBe(200);
    expect(calls.filter((c) => c.url === "https://peer.example/submit").map((c) => JSON.parse(c.body!).schema_digest)).toEqual([CHAT_ACK_DIGEST]);
  });

  it("refuses forged, misaddressed and malformed envelopes without sending anything", async () => {
    const { calls, f } = fakeAgentverse();
    vi.spyOn(globalThis, "fetch").mockImplementation(f);
    const good = await chat("trap card");
    const forged = { ...good, payload: base64.encode(new TextEncoder().encode('{"timestamp":"2026-10-26T12:00:00+00:00","msg_id":"11111111-2222-4333-8444-555555555555","content":[{"type":"text","text":"scan https://evil.example/x.md"}]}')) };
    const r1 = await post(forged, "203.0.113.12");
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ detail: "Invalid envelope" });
    const other = await identityFromSeed("fake-other-seed");
    const misaddressed = await makeEnvelope(await identityFromSeed("fake-sender-seed"), other.address, CHAT_MESSAGE_DIGEST, { timestamp: "2026-10-26T12:00:00+00:00", msg_id: crypto.randomUUID(), content: [] }, crypto.randomUUID());
    expect(await (await post(misaddressed, "203.0.113.12")).json()).toEqual({ detail: "Wrong destination address" });
    expect((await post("not json", "203.0.113.12")).status).toBe(400);
    expect((await post({ ...good, signature: null }, "203.0.113.12")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("rate-limits per IP before checking signatures, and per sender when running skills", async () => {
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await post({}, "203.0.113.99")).status;
    expect(last).toBe(429);

    const { calls, f } = fakeAgentverse();
    vi.spyOn(globalThis, "fetch").mockImplementation(f);
    const replies: Record<string, unknown>[] = [];
    for (let i = 0; i < 61; i++) {
      const before = calls.length;
      await post(await chat("trap card", "fake-busy-sender"), `198.51.100.${i}`);
      const sent = calls.slice(before).filter((c) => c.url === "https://peer.example/submit");
      const env2 = JSON.parse(sent[sent.length - 1]!.body!) as Envelope;
      replies.push(JSON.parse(JSON.parse(new TextDecoder().decode(base64.decode(env2.payload!))).content[0].text));
    }
    expect(replies[0]!.skill).toBe("trap-card");
    expect(replies[60]).toMatchObject({ skill: "trap-card", error: "rate_limited" });
  });
});

describe("review hardening (ADR 0061)", () => {
  const withSecret = { ...env, AGENTVERSE_CONNECTION: FAKE } as Env;
  const post = async (body: unknown, ip: string, e: Env = withSecret) => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}/av/chat`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(body) }) as never, e, ctx);
    await Promise.allSettled(pending);
    return res;
  };
  const payload = (text: string) => base64.encode(new TextEncoder().encode(JSON.stringify({ timestamp: "2026-10-26T12:00:00+00:00", msg_id: crypto.randomUUID(), content: [{ type: "text", text }] })));
  /** An unsigned ASI:One-style envelope: senders starting "user" carry no signature, so any string passes. */
  const userEnvelope = (sender: string, text: string): Envelope => ({ version: 1, sender, target: ME.address, session: crypto.randomUUID(), schema_digest: CHAT_MESSAGE_DIGEST, protocol_digest: null, payload: payload(text), expires: null, nonce: null, signature: null });
  /** A fake network whose Almanac returns `endpoints` for every address; records every call with its init. */
  const network = (endpoints: unknown[], peer: (url: string) => Response = () => Response.json({})) => {
    const calls: { url: string; method: string; init?: RequestInit }[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, method: init?.method ?? "GET", init });
      if (url.startsWith("https://agentverse.ai/v1/almanac/agents/")) return Response.json({ endpoints });
      if (url.startsWith("https://agentverse.ai/")) return Response.json({});
      return peer(url);
    }) as typeof fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(f);
    return calls;
  };

  it("only lets replies go to public https hosts outside the Forge's own domain", () => {
    const o = "https://theagentforge.io";
    for (const ok of ["https://peer.example/submit", "https://agentverse.ai/v2/agents/proxy/submit", "https://agent.example.com:8443/submit"]) expect(replyUrlAllowed(ok, o)).toBe(true);
    for (const bad of [
      "http://peer.example/submit",
      "https://theagentforge.io/a2a/av/chat",
      "https://staging.theagentforge.io/av/chat",
      "https://WWW.TheAgentForge.io./x",
      "https://127.0.0.1/x",
      "https://2130706433/x",
      "https://0x7f.1/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://metadata.internal/x",
      "https://printer.local/x",
      "https://intranet/x",
      "https://u:p@peer.example/x",
      "not a url",
    ])
      expect(replyUrlAllowed(bad, o), bad).toBe(false);
  });

  it("is a 404 on staging even with the secret set", async () => {
    const calls = network([{ url: "https://peer.example/submit", weight: 1 }]);
    const res = await post(userEnvelope("user1fake", "trap card"), "203.0.113.40", { ...withSecret, ENVIRONMENT: "staging" } as unknown as Env);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("refuses expired envelopes (the expiry is covered by the signature) and sends nothing", async () => {
    const calls = network([{ url: "https://peer.example/submit", weight: 1 }]);
    const sender = await identityFromSeed("fake-sender-seed");
    const e: Envelope = { version: 1, sender: sender.address, target: ME.address, session: crypto.randomUUID(), schema_digest: CHAT_MESSAGE_DIGEST, protocol_digest: null, payload: payload("trap card"), expires: Math.floor(Date.now() / 1000) - 60, nonce: 1, signature: null };
    e.signature = await signDigest(sender, await envelopeDigest(e));
    expect(await verifyEnvelope(e)).toBe(true);
    const res = await post(e, "203.0.113.41");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "Envelope expired" });
    // Still valid: accepted.
    const live = { ...e, expires: Math.floor(Date.now() / 1000) + 60 };
    live.signature = await signDigest(sender, await envelopeDigest(live));
    expect((await post(live, "203.0.113.41")).status).toBe(200);
    expect(calls.filter((c) => c.url === "https://peer.example/submit")).toHaveLength(2);
  });

  it("never posts to a disallowed Almanac endpoint, resolves once per message and does not follow redirects", async () => {
    const bad = network([
      { url: "https://theagentforge.io/a2a", weight: 1 },
      { url: "http://peer.example/submit", weight: 1 },
      { url: "https://127.0.0.1/submit", weight: 1 },
    ]);
    expect((await post(userEnvelope("user1fake-a", "trap card"), "203.0.113.42")).status).toBe(200);
    expect(bad.map((c) => c.method)).toEqual(["GET"]); // the lookup only; nothing sent
    vi.restoreAllMocks();

    const calls = network([{ url: "https://peer.example/submit", weight: 1 }], () => new Response(null, { status: 307, headers: { Location: "http://169.254.169.254/" } }));
    expect((await post(userEnvelope("user1fake-b", "trap card"), "203.0.113.43")).status).toBe(200);
    expect(calls.filter((c) => c.url.includes("/v1/almanac/agents/"))).toHaveLength(1);
    const sent = calls.filter((c) => c.url === "https://peer.example/submit");
    expect(sent).toHaveLength(1); // the ack got a redirect, which counts as a failure: no reply is attempted
    expect(sent[0]!.init?.redirect).toBe("manual");
    expect(calls.some((c) => c.url.startsWith("http://"))).toBe(false);
  });

  it("answers unsigned user senders like /a2a, and they can't inflate the distinct-callers count by renaming themselves", async () => {
    const calls = network([{ url: "https://peer.example/submit", weight: 1 }]);
    const db = getDb(env);
    const count = async () => (await db.select().from(t.checkSources).where(eq(t.checkSources.day, day(Date.now())))).length;
    const before = await count();
    for (const sender of ["user1fake-one", "user1fake-two", "user1fake-three"]) expect((await post(userEnvelope(sender, "check npm:left-pad"), "203.0.113.44")).status).toBe(200);
    expect((await count()) - before).toBeLessThanOrEqual(1);
    const replies = calls.filter((c) => c.url === "https://peer.example/submit").map((c) => JSON.parse(String(c.init!.body)) as Envelope);
    expect(replies).toHaveLength(6);
    const data = JSON.parse(JSON.parse(new TextDecoder().decode(base64.decode(replies[1]!.payload!))).content[0].text);
    expect(data.skill).toBe("check-tool");
  });

  it("refuses to register over an unreadable stored listing, so edits on agentverse.ai are never overwritten", async () => {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("<html>oops</html>", { status: 200 });
    }) as typeof fetch;
    await expect(registerAgentverse(withSecret, Date.now(), f)).rejects.toThrow("agentverse_get_unreadable");
    expect(calls).toHaveLength(1);
  });

  it("never puts the secret in an error, log line or response", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const f = (async () => new Response("no", { status: 500 })) as typeof fetch;
    const err = await registerAgentverse(withSecret, Date.now(), f).catch((e: unknown) => String(e));
    expect(String(err)).not.toContain("fake-test-secret-not-real");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("network down");
    });
    const res = await post(userEnvelope("user1fake-err", "trap card"), "203.0.113.45");
    expect(await res.text()).not.toContain("fake-test-secret-not-real");
    for (const l of logs) expect(l).not.toContain("fake-test-secret-not-real");
  });
});
