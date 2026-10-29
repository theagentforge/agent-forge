import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Attempt,
  canonical,
  checkReplay,
  DEV_SPLIT,
  eventHash,
  FIXTURE_KEY,
  FIXTURE_ORIGIN,
  GENESIS,
  refereeCheck,
  replayBlock,
  RULES_VERSION,
  sealBody,
  sealMessage,
  SIGNATURE_PATTERN,
  TASKS,
  taskVersion,
  type AttemptResult,
  type LogEvent,
  type ReplaySeal,
  type VerifySig,
} from "../src";
import { honest } from "./grader-hacks";

// Replay format v2 (ADR 0066) and the first-clone fixture: signed replays of the public dev split (seeds 900001-900005)
// that `forge verify` checks with no network. The fixture file is this test's own output, so it can't drift from the
// referee: regenerate with `npx vitest run test/replay.test.ts -u` from packages/arena.

const FIXTURE = "../../cli/fixtures/dev-split-replays.json";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const seed = createHash("sha256").update(FIXTURE_KEY.seed_text).digest();
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const pubOf = (x: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
const verifier =
  (keys: Record<string, string>): VerifySig =>
  (kid, message, signature) => {
    const x = keys[kid];
    if (!x) return null;
    return verify(null, Buffer.from(message, "utf8"), pubOf(x), Buffer.from(signature.replace(/^ed25519:/, ""), "base64url"));
  };
const fixtureVerify = verifier({ [FIXTURE_KEY.kid]: FIXTURE_KEY.x });

/** A signed replay document, as the site publishes one. */
async function doc(runId: string, log: LogEvent[], result: AttemptResult, key: { kid: string; priv: typeof priv } = { kid: FIXTURE_KEY.kid, priv }) {
  const stamped = { ...result, rules: RULES_VERSION };
  const body = await sealBody(sha, { keyId: key.kid, origin: FIXTURE_ORIGIN, kind: "fixture", runId, model: null, rules: RULES_VERSION, taskVersion: taskVersion(result.task), log, result: stamped, signedAt: Date.parse("2026-10-28T00:00:00Z") });
  const seal: ReplaySeal = { ...body, signature: `ed25519:${sign(null, Buffer.from(sealMessage(body), "utf8"), key.priv).toString("base64url")}` };
  return { id: runId, kind: "fixture", task: result.task, seed: result.seed, result: stamped, log, replay: await replayBlock(sha, log, seal) };
}

/** The dev split's fixture plays: the honest reference on every seed, and one "claims done, did nothing" per job. */
async function fixtureReplays() {
  const out = [];
  for (const task of TASKS) {
    for (const s of DEV_SPLIT.seeds) {
      const h = honest(task, s);
      out.push(await doc(`dev-${task.id}-${s}-reference`, h.attempt.log, h.result));
    }
    const s = DEV_SPLIT.seeds[0];
    let t = 0;
    const a = new Attempt(task, s, { now: () => (t += 10) });
    a.call("finish", { status: "done", summary: "All done." });
    out.push(await doc(`dev-${task.id}-${s}-claims-done`, a.log, a.result!));
  }
  return out;
}

describe("replay format v2", () => {
  it("the fixture key is the one derived from its published seed text", () => {
    expect(createPublicKey(priv).export({ format: "jwk" }).x).toBe(FIXTURE_KEY.x);
  });

  it("canonical JSON sorts keys at every depth, drops undefined and has no whitespace", () => {
    expect(canonical({ b: 1, a: { d: [1, { z: 0, y: undefined, x: "é" }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":"é","z":0}]},"b":1}');
    expect(canonical(1.5e-7)).toBe("1.5e-7");
  });

  it("each event hashes over {event, i, prev}; the first prev is 64 zeros", async () => {
    const h = honest(TASKS[0]!, 900_001);
    const d = await doc("x", h.attempt.log, h.result);
    expect(d.replay.chain[0]!.prev).toBe(GENESIS);
    expect(d.replay.chain[0]!.hash).toBe(sha(`{"event":${canonical(h.attempt.log[0])},"i":0,"prev":"${GENESIS}"}`));
    expect(d.replay.chain[2]!.hash).toBe(await eventHash(sha, 2, d.replay.chain[1]!.hash, h.attempt.log[2]));
    expect(d.replay.seal.chain_head).toBe(d.replay.chain.at(-1)!.hash);
  });

  it("first-clone fixture: the dev split's signed replays (regenerate with -u)", async () => {
    const replays = await fixtureReplays();
    const bundle = {
      format: "forge-replay-bundle/1",
      about:
        "Signed replays of the public dev split (seeds 900001-900005): the honest reference play on every seed, and one play per job that claims done without doing the work. Signed with the public test key (FIXTURE_KEY in packages/arena/src/replay.ts), so they prove the format and the referee, not that The Forge produced them.",
      key: { kid: FIXTURE_KEY.kid, kty: FIXTURE_KEY.kty, crv: FIXTURE_KEY.crv, x: FIXTURE_KEY.x },
      replays,
    };
    const text = `{\n"format": ${JSON.stringify(bundle.format)},\n"about": ${JSON.stringify(bundle.about)},\n"key": ${JSON.stringify(bundle.key)},\n"replays": [\n${replays.map((r) => JSON.stringify(r)).join(",\n")}\n]\n}\n`;
    await expect(text).toMatchFileSnapshot(FIXTURE);
    for (const r of replays) {
      expect(await checkReplay(r, sha, fixtureVerify)).toMatchObject({ format: 2, chain: "ok", record: "ok", signature: "ok" });
      expect(refereeCheck(r)).toMatchObject({ checked: true, same_verdict: true, faithful: true });
    }
    // Never a private family, a held-out seed or anything but the dev split's seeds.
    expect(new Set(replays.map((r) => r.task))).toEqual(new Set(TASKS.map((t) => t.id)));
    expect(replays.every((r) => (DEV_SPLIT.seeds as readonly number[]).includes(r.seed))).toBe(true);
    expect(replays.some((r) => !r.result.passed)).toBe(true);
  });
});

describe("what verification catches", () => {
  const base = async () => {
    const h = honest(TASKS[0]!, 900_002);
    return doc("tamper", h.attempt.log, h.result);
  };

  it("an untouched replay passes every check", async () => {
    expect(await checkReplay(await base(), sha, fixtureVerify)).toMatchObject({ chain: "ok", record: "ok", signature: "ok", chain_break_at: null });
  });

  it("tampering with any single event breaks the chain at that event", async () => {
    const d0 = await base();
    for (let i = 0; i < d0.log.length; i++) {
      const d = structuredClone(d0) as any;
      d.log[i].t = (d.log[i].t ?? 0) + 1;
      const r = await checkReplay(d, sha, fixtureVerify);
      expect(r.chain).toBe("failed");
      expect(r.chain_break_at).toBe(i);
    }
  });

  it("tampering even after re-hashing the chain is caught by the signed head", async () => {
    const d = structuredClone(await base()) as any;
    d.log[1].args = { forged: true };
    d.replay = await replayBlock(sha, d.log, d.replay.seal);
    expect((await checkReplay(d, sha, fixtureVerify)).chain).toBe("failed");
  });

  it("reordering two events fails", async () => {
    const d = structuredClone(await base()) as any;
    [d.log[1], d.log[2]] = [d.log[2], d.log[1]];
    expect((await checkReplay(d, sha, fixtureVerify)).chain).toBe("failed");
  });

  it("a truncated log fails, even with a matching truncated chain", async () => {
    const d = structuredClone(await base()) as any;
    d.log = d.log.slice(0, -2);
    d.replay.chain = d.replay.chain.slice(0, -2);
    const r = await checkReplay(d, sha, fixtureVerify);
    expect(r.chain).toBe("failed");
    expect(r.chain_break_at).toBe(d.log.length);
  });

  it("a wrong key fails, and an unknown key id is reported as unknown", async () => {
    const other = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update("not the fixture").digest()]), format: "der", type: "pkcs8" });
    const h = honest(TASKS[0]!, 900_002);
    const forged = await doc("tamper", h.attempt.log, h.result, { kid: FIXTURE_KEY.kid, priv: other });
    expect((await checkReplay(forged, sha, fixtureVerify)).signature).toBe("failed");
    expect((await checkReplay(await base(), sha, verifier({ "forge-0000": FIXTURE_KEY.x }))).signature).toBe("unknown_key");
  });

  it("an edited seal (a flipped verdict) fails the signature", async () => {
    const d = structuredClone(await base()) as any;
    d.replay.seal.verdict.passed = !d.replay.seal.verdict.passed;
    expect((await checkReplay(d, sha, fixtureVerify)).signature).toBe("failed");
  });

  it("a published verdict the referee doesn't reach is a mismatch, and the record check fails too", async () => {
    const d = structuredClone(await base()) as any;
    d.result.passed = !d.result.passed;
    expect((await checkReplay(d, sha, fixtureVerify)).record).toBe("failed");
    const ref = refereeCheck(d);
    expect(ref).toMatchObject({ checked: true, same_verdict: false });
    expect(ref.differences[0]).toMatch(/^pass\/fail/);
  });

  it("a validly signed replay whose verdict the referee can't reproduce is a mismatch", async () => {
    const h = honest(TASKS[0]!, 900_003);
    const wrong = { ...h.result, passed: !h.result.passed };
    const d = await doc("forged-verdict", h.attempt.log, wrong);
    expect(await checkReplay(d, sha, fixtureVerify)).toMatchObject({ chain: "ok", record: "ok", signature: "ok" });
    expect(refereeCheck(d).same_verdict).toBe(false);
  });

  it("a private job's referee isn't re-run (it isn't published)", () => {
    const r = refereeCheck({ log: [{ t: 0, type: "start", task: "support-desk", seed: 1 }], result: { passed: true, reason: "finished" } });
    expect(r).toMatchObject({ checked: false });
    expect(r.why).toMatch(/isn't a public job/);
  });
});

describe("fail closed: formats, seals and spellings this code doesn't know", () => {
  const base = async () => {
    const h = honest(TASKS[1]!, 900_004);
    return doc("closed", h.attempt.log, h.result);
  };

  it("an unknown replay format or seal format is never read as v1 or v2", async () => {
    for (const edit of [(d: any) => (d.replay.format = "forge-replay/3"), (d: any) => (d.replay.seal.format = "forge-replay/3"), (d: any) => (d.replay.seal.alg = "HS256"), (d: any) => (d.replay = { format: "forge-replay/9" })]) {
      const d = structuredClone(await base()) as any;
      edit(d);
      const r = await checkReplay(d, sha, fixtureVerify);
      expect(r.unknown_format).not.toBeNull();
      expect(r.format).toBeNull();
      expect(r.signature).toBe("not_checked");
    }
  });

  it("a v2 document whose seal was stripped or broken fails, rather than passing as v1", async () => {
    const stripped = structuredClone(await base()) as any;
    delete stripped.replay.seal;
    expect(await checkReplay(stripped, sha, fixtureVerify)).toMatchObject({ format: 2, record: "failed", signature: "failed" });
    const broken = structuredClone(await base()) as any;
    delete broken.replay.seal.verdict;
    const r = await checkReplay(broken, sha, fixtureVerify);
    expect(r).toMatchObject({ format: 2, record: "failed", signature: "failed" });
    expect(r.record_problems[0]).toMatch(/verdict/);
  });

  it("one signature has one spelling: padding, junk or a non-canonical last character fails", async () => {
    const d0 = await base();
    const sig = d0.replay.seal.signature;
    expect(sig).toMatch(SIGNATURE_PATTERN);
    const last = sig.at(-1)!;
    const twin = "AQgw".includes(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : "A";
    for (const s of [`${sig}==`, `${sig.slice(0, 20)}!${sig.slice(21)}`, `${sig.slice(0, -1)}${twin}`, sig.replace("ed25519:", "")]) {
      const d = structuredClone(d0) as any;
      d.replay.seal.signature = s;
      expect((await checkReplay(d, sha, fixtureVerify)).record).toBe("failed");
    }
  });

  it("the seal binds the model and the run id: a document naming another model or run fails", async () => {
    const d = structuredClone(await base()) as any;
    d.model = "some-other-model";
    expect((await checkReplay(d, sha, fixtureVerify)).record_problems).toContain("the model differs from the seal");
    const e = structuredClone(await base()) as any;
    delete e.id;
    expect((await checkReplay(e, sha, fixtureVerify)).record_problems).toContain("the run id differs from the seal");
  });

  it("a run re-scored after sealing still verifies against its sealed original, and is compared under the re-score's rules", async () => {
    const d0 = await base();
    const d = structuredClone(d0) as any;
    d.result = { ...d0.result, rules: "rules 0.1", rescored: { rules: RULES_VERSION, at: "2026-11-01T00:00:00.000Z", before: {}, flips: [], sealed: d0.result } };
    const r = await checkReplay(d, sha, fixtureVerify);
    expect(r).toMatchObject({ chain: "ok", record: "ok", signature: "ok", rescored_rules: RULES_VERSION });
    expect(refereeCheck(d)).toMatchObject({ checked: true, same_verdict: true, rules_of_run: RULES_VERSION });
    // Without the sealed original, the re-scored result can't pass for the sealed one.
    delete d.result.rescored.sealed;
    d.result.passed = !d.result.passed;
    expect((await checkReplay(d, sha, fixtureVerify)).record).toBe("failed");
  });
});
