import { isSeal, KEYS_FORMAT, keyIdOf, REPLAY_V1_FORMAT, replayBlock, sealBody, sealMessage, type KeySet, type ReplayKey, type ReplaySeal, type SealBody } from "@forge/arena";
import type { AttemptResult, LogEvent } from "@forge/arena";

// Replay format v2 signing (ADR 0066). The Ed25519 key is derived from the existing REPORT_SIGNING_KEY secret, so no
// new root credential is needed: seed = HMAC-SHA256(REPORT_SIGNING_KEY, "forge-replay-ed25519/1"). Only the public half
// is ever published (/.well-known/forge-keys.json). Rotating REPORT_SIGNING_KEY therefore rotates this key too: before
// a rotation, the current key's public half goes into RETIRED_REPLAY_KEYS below (docs/arena/replay-format.md §Keys).

const enc = new TextEncoder();
const DERIVE_LABEL = "forge-replay-ed25519/1";
/** PKCS#8 wrapper for a raw 32-byte Ed25519 seed (RFC 8410). */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

/**
 * Keys that used to sign replays, newest first: public halves only, added by hand before REPORT_SIGNING_KEY is rotated.
 * A replay signed by one of these still verifies; nothing new is signed with them.
 */
export const RETIRED_REPLAY_KEYS: ReplayKey[] = [];
/** The day replay format v2 began signing (first `from` date of the first key). */
export const REPLAY_V2_FROM = "2026-10-28";

export const ROTATION_RULES = [
  "Every v2 replay seal names its key by key_id. Verify it with the key of that id in this set.",
  "Exactly one key is current; only the current key signs new replays.",
  "A rotated key stays in this set as retired, with the date it stopped signing, and is never removed, so older replays keep verifying.",
  "A key id is never reused.",
  "If a key is ever known to be compromised, it stays listed with status retired and the date, and the incident is published at /status.",
  "Runs finished before replay format v2 (forge-replay/1) carry an HMAC-SHA256 signature only The Forge can check; they verify by that signature only, shown on each run page.",
];

const b64url = (b: ArrayBuffer | Uint8Array) => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Signer {
  kid: string;
  x: string;
  key: CryptoKey;
}
const cache = new Map<string, Promise<Signer>>();

/** The replay signer derived from a secret (cached per isolate). */
export function replaySigner(secret: string): Promise<Signer> {
  let p = cache.get(secret);
  if (!p) {
    p = (async () => {
      const hk = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const seed = new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode(DERIVE_LABEL)));
      const pkcs8 = new Uint8Array(48);
      pkcs8.set(PKCS8_PREFIX);
      pkcs8.set(seed, 16);
      const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
      const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
      if (!jwk.x) throw new Error("Ed25519 public key unavailable");
      return { kid: await keyIdOf(sha256Hex, jwk.x), x: jwk.x, key: await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]) };
    })();
    cache.set(secret, p);
  }
  return p;
}

/** Signs a seal body: "ed25519:" + base64url signature over the canonical body. */
export async function signSeal(secret: string, body: SealBody): Promise<ReplaySeal> {
  const s = await replaySigner(secret);
  if (body.key_id !== s.kid) throw new Error("seal key id isn't the current key");
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, s.key, enc.encode(sealMessage(body)));
  return { ...body, signature: `ed25519:${b64url(sig)}` };
}

/** Builds and signs the v2 seal for a finished run. */
export async function sealRun(
  env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">,
  r: { kind: "arena" | "gauntlet"; runId: string; model: string | null; rules: string; taskVersion: string; log: readonly LogEvent[]; result: AttemptResult; signedAt: number },
): Promise<ReplaySeal> {
  const s = await replaySigner(env.REPORT_SIGNING_KEY);
  const body = await sealBody(sha256Hex, { ...r, keyId: s.kid, origin: env.PUBLIC_ORIGIN });
  return signSeal(env.REPORT_SIGNING_KEY, body);
}

/** The published key set: the current key and every retired one. */
export async function keySet(env: Pick<Env, "REPORT_SIGNING_KEY" | "PUBLIC_ORIGIN">): Promise<KeySet> {
  const s = await replaySigner(env.REPORT_SIGNING_KEY);
  const current: ReplayKey = { kid: s.kid, kty: "OKP", crv: "Ed25519", x: s.x, use: "sig", status: "current", from: RETIRED_REPLAY_KEYS.length ? null : REPLAY_V2_FROM, retired: null };
  return { format: KEYS_FORMAT, origin: env.PUBLIC_ORIGIN, keys: [current, ...RETIRED_REPLAY_KEYS.filter((k) => k.kid !== s.kid)], rotation: ROTATION_RULES };
}

/**
 * The `replay` block for a published run document: v2 (chain and seal) or v1. A v1 Arena run carries an HMAC signature
 * only the server can check; a v1 Gauntlet job (before v2, or a job whose seal failed) carries no signature at all.
 */
export async function replayDocBlock(log: readonly unknown[] | null, seal: unknown, kind: "arena" | "gauntlet") {
  if (log && isSeal(seal)) return replayBlock(sha256Hex, log, seal);
  if (kind === "gauntlet")
    return {
      format: REPLAY_V1_FORMAT,
      signature_alg: null,
      verifiable_by: "none",
      note: "Not sealed with replay format v2, and Gauntlet jobs carry no other signature, so nothing signs this log. The referee can still be re-run on it.",
    };
  return {
    format: REPLAY_V1_FORMAT,
    signature_alg: "hmac-sha256",
    verifiable_by: "server_only",
    note: "Not sealed with replay format v2: signed with The Forge's private HMAC key, so it verifies by that signature only, on the run page. The referee can still be re-run on its log.",
  };
}
