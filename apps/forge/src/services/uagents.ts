import { getPublicKey, signAsync, verifyAsync } from "@noble/secp256k1";
import { base64, bech32 } from "@scure/base";

// The Fetch.ai uAgents wire format, re-implemented from uagents-core 0.4.12 (the version agentverse-sdk 0.2.1 pins) so
// the Worker can list itself on Agentverse without Python (ADR 0061). Each function names the Python it mirrors; the
// test vectors in test/agentverse.test.ts were produced by that Python code with fake keys.

const enc = new TextEncoder();
const sha256 = async (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", all));
};
/** struct.pack(">Q", n) */
const u64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** identity._encode_bech32: bech32 (not bech32m) with no length limit (signatures are 113 characters). */
export const encodeBech32 = (prefix: string, bytes: Uint8Array) => bech32.encode(prefix, bech32.toWords(bytes), false);
export function decodeBech32(value: string): { prefix: string; bytes: Uint8Array } | null {
  try {
    const d = bech32.decode(value, false);
    return { prefix: d.prefix, bytes: bech32.fromWords(d.words) };
  } catch {
    return null;
  }
}

/** The connection string Agentverse gives: https://<handle>:<key>@<host>/<Agent%20Name> (AgentUri.from_str). */
export type AgentverseUri = { key: string; handle: string; name: string; url: string };

/**
 * Parses like Python's urlparse: userinfo is everything before the last "@" of the authority, split at the first ":";
 * neither part is percent-decoded, the name is. Returns null on anything malformed, never echoing the input.
 */
export function parseAgentverseUri(raw: string | undefined): AgentverseUri | null {
  if (!raw) return null;
  // https only: the auth header (a 120-second attestation) must never cross the network in clear.
  const m = /^(https):\/\/([^/?#]*)(\/[^?#]*)?/i.exec(raw.trim());
  if (!m) return null;
  const at = m[2]!.lastIndexOf("@");
  if (at < 0) return null;
  const userinfo = m[2]!.slice(0, at);
  const hostport = m[2]!.slice(at + 1).toLowerCase();
  const colon = userinfo.indexOf(":");
  const handle = colon < 0 ? userinfo : userinfo.slice(0, colon);
  const key = colon < 0 ? "" : userinfo.slice(colon + 1);
  const seg = (m[3] ?? "").split("/")[1] ?? "";
  let name: string;
  try {
    name = decodeURIComponent(seg);
  } catch {
    return null;
  }
  if (!handle || !key || !name || !/^[a-z0-9.-]+(:\d{1,5})?$/.test(hostport)) return null;
  return { key, handle, name, url: `${m[1]!.toLowerCase()}://${hostport}` };
}

/** Agentverse endpoints (uagents_core.config.AgentverseConfig). */
export const agentverseApis = (base: string) => ({
  agents: `${base}/v2/agents`,
  almanac: `${base}/v1/almanac`,
  proxy: `${base}/v2/agents/proxy/submit`,
});

export type Identity = { secretKey: Uint8Array; publicKey: Uint8Array; address: string };

/** Identity.from_seed(seed, 0): sha256( sha256("agent" || index) || sha256(seed) ) is the secp256k1 secret key. */
export async function identityFromSeed(seed: string, index = 0): Promise<Identity> {
  const secretKey = await sha256(await sha256(enc.encode("agent"), Uint8Array.of(index)), await sha256(enc.encode(seed)));
  const publicKey = getPublicKey(secretKey, true);
  return { secretKey, publicKey, address: encodeBech32("agent", publicKey) };
}

/** Identity.sign_digest: ECDSA over a 32-byte digest, 64-byte r||s, bech32 "sig". */
export const signDigest = async (id: Identity, digest: Uint8Array) => encodeBech32("sig", await signAsync(digest, id.secretKey, { prehash: false }));

/** Identity.verify_digest. python-ecdsa accepts high-S signatures, so lowS is off to accept every signature it would. */
export async function verifyDigest(address: string, digest: Uint8Array, signature: string): Promise<boolean> {
  const pk = decodeBech32(address);
  const sig = decodeBech32(signature);
  if (!pk || pk.prefix !== "agent" || pk.bytes.length !== 33) return false;
  if (!sig || sig.prefix !== "sig" || sig.bytes.length !== 64) return false;
  try {
    return await verifyAsync(sig.bytes, digest, pk.bytes, { prehash: false, lowS: false });
  } catch {
    return false;
  }
}

/** storage.compute_attestation: "attr:" + b64(pubkey || >QQ(from, to) || nonce) + ":" + sign(sha256(payload)). */
export async function attestation(id: Identity, nowS: number, validityS: number, nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(32))) {
  const payload = new Uint8Array(81);
  payload.set(id.publicKey, 0);
  payload.set(u64(nowS), 33);
  payload.set(u64(nowS + validityS), 41);
  payload.set(nonce, 49);
  const sig = encodeBech32("sig", await signAsync(payload, id.secretKey, { prehash: true }));
  return `attr:${base64.encode(payload)}:${sig}`;
}

export type Envelope = {
  version: number;
  sender: string;
  target: string;
  session: string;
  schema_digest: string;
  protocol_digest: string | null;
  payload: string | null;
  expires: number | null;
  nonce: number | null;
  signature: string | null;
};

/** pydantic's UUID4 field: any accepted spelling, normalised to str(UUID) (lower case, hyphens); version must be 4. */
export function normaliseUuid4(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const h = v.trim().toLowerCase().replace(/^urn:uuid:/, "").replace(/^\{(.*)\}$/, "$1").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(h) || h[12] !== "4") return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const optStr = (v: unknown, max: number) => (v === undefined || v === null ? null : typeof v === "string" && v.length <= max ? v : undefined);
const optU64 = (v: unknown) => (v === undefined || v === null ? null : Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

/** Envelope.model_validate, strictly: unknown shapes are refused rather than coerced. */
export function readEnvelope(body: unknown): Envelope | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const session = normaliseUuid4(b.session);
  const [protocol_digest, payload, signature] = [optStr(b.protocol_digest, 128), optStr(b.payload, 65_536), optStr(b.signature, 200)];
  const [expires, nonce] = [optU64(b.expires), optU64(b.nonce)];
  if (!Number.isSafeInteger(b.version) || typeof b.sender !== "string" || typeof b.target !== "string" || typeof b.schema_digest !== "string") return null;
  if (b.sender.length > 100 || b.target.length > 100 || b.schema_digest.length > 128 || !session) return null;
  if (protocol_digest === undefined || payload === undefined || signature === undefined || expires === undefined || nonce === undefined) return null;
  return { version: b.version as number, sender: b.sender, target: b.target, session, schema_digest: b.schema_digest, protocol_digest, payload, expires, nonce, signature };
}

/** Envelope._digest */
export async function envelopeDigest(e: Envelope): Promise<Uint8Array> {
  const parts = [enc.encode(e.sender), enc.encode(e.target), enc.encode(e.session), enc.encode(e.schema_digest)];
  if (e.payload !== null) parts.push(enc.encode(e.payload));
  if (e.expires !== null) parts.push(u64(e.expires));
  if (e.nonce !== null) parts.push(u64(e.nonce));
  return sha256(...parts);
}

/** agentverse_sdk av.verify_envelope: "user…" senders (ASI:One people) carry no key and pass; agents must sign. */
export async function verifyEnvelope(e: Envelope): Promise<boolean> {
  if (e.sender.startsWith("user")) return true;
  if (!e.signature) return false;
  return verifyDigest(e.sender, await envelopeDigest(e), e.signature);
}

/** Envelope.decode_payload: base64, then UTF-8. Null when either step fails. */
export function decodePayload(e: Envelope): string | null {
  if (e.payload === null) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(base64.decode(e.payload));
  } catch {
    return null;
  }
}

/** utils.messages.generate_message_envelope: compact JSON payload, version 1, signed by the sender. */
export async function makeEnvelope(sender: Identity, target: string, schemaDigest: string, body: unknown, session: string): Promise<Envelope> {
  const e: Envelope = {
    version: 1,
    sender: sender.address,
    target,
    session,
    schema_digest: schemaDigest,
    protocol_digest: null,
    payload: base64.encode(enc.encode(JSON.stringify(body))),
    expires: null,
    nonce: null,
    signature: null,
  };
  e.signature = await signDigest(sender, await envelopeDigest(e));
  return e;
}

/**
 * registration.AgentStatusUpdate, signed (VerifiableModel.sign): the digest is sha256 of the model's JSON without the
 * signature, keys sorted, no spaces.
 */
export async function statusUpdate(id: Identity, active: boolean, nowS: number) {
  const unsigned = { agent_identifier: id.address, is_active: active, timestamp: nowS };
  const digest = await sha256(enc.encode(JSON.stringify(unsigned)));
  return { agent_identifier: id.address, signature: await signDigest(id, digest), timestamp: nowS, is_active: active };
}

// Agent Chat Protocol 0.3.0 (uagents_core.contrib.protocols.chat). These digests are fixed by the models' schemas;
// the test recomputes nothing but checks them against the Python output.
export const CHAT_PROTOCOL_DIGEST = "proto:30a801ed3a83f9a0ff0a9f1e6fe958cb91da1fc2218b153df7b6cbf87bd33d62";
export const CHAT_MESSAGE_DIGEST = "model:2601825997203ee07dbb9ff6e7c71ae7bdaf6a7c8b817361f2f88f4b29c68d0c";
export const CHAT_ACK_DIGEST = "model:741eb75692abbeb43c131e364ad939af23f14e8288ba0ec3df130843ef79bd7f";

export type ChatContent = { type: string; text?: unknown; [k: string]: unknown };
export type ChatMessage = { kind: "message"; msg_id: string; content: ChatContent[] };
export type ChatAck = { kind: "ack"; acknowledged_msg_id: string };

const isoTime = (v: unknown) => typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v));

/** utils.messages.parse_envelope with {ChatMessage, ChatAcknowledgement}: the payload's shape decides, as in Python. */
export function readChat(json: string): ChatMessage | ChatAck | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!isoTime(o.timestamp)) return null;
  const ackId = normaliseUuid4(o.acknowledged_msg_id);
  if (ackId) return { kind: "ack", acknowledged_msg_id: ackId };
  const msgId = normaliseUuid4(o.msg_id);
  if (!msgId || !Array.isArray(o.content) || o.content.length > 32) return null;
  const content: ChatContent[] = [];
  for (const c of o.content) {
    if (!c || typeof c !== "object" || typeof (c as ChatContent).type !== "string") return null;
    if ((c as ChatContent).type === "text" && typeof (c as ChatContent).text !== "string") return null;
    content.push(c as ChatContent);
  }
  return { kind: "message", msg_id: msgId, content };
}

/** ChatMessage.text(): every text content, joined. */
export const chatText = (m: ChatMessage) => m.content.map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : "")).join("");

/** datetime.isoformat() for a UTC time, as pydantic v1 writes it. */
export const utcIso = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");

export const ackBody = (msgId: string, nowMs: number) => ({ timestamp: utcIso(nowMs), acknowledged_msg_id: msgId, metadata: null });
export const messageBody = (text: string, nowMs: number) => ({ timestamp: utcIso(nowMs), msg_id: crypto.randomUUID(), content: [{ type: "text", text }] });

export { hex as toHex };
