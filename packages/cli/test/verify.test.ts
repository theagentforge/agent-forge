import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_KEY, KEYS_PATH, replayBlock, sealBody, sealMessage, type ReplaySeal } from "@forge/arena/replay";
import { PRIVATE_TASK_IDS } from "@forge/arena";
import { describe, expect, it } from "vitest";
import { run } from "../src/run";
import { VERIFY_EXIT } from "../src/verify";

// `forge verify` (ADR 0066): the first-clone fixture verifies offline, and every kind of tampering fails.

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FIXTURE = here("../fixtures/dev-split-replays.json");
const bundle = JSON.parse(readFileSync(FIXTURE, "utf8"));
const dir = mkdtempSync(join(tmpdir(), "forge-verify-"));
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const pkcs8 = (seedText: string) => createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update(seedText).digest()]), format: "der", type: "pkcs8" });
const xOf = (k: ReturnType<typeof pkcs8>) => createPublicKey(k).export({ format: "jwk" }).x as string;

function io(routes: Record<string, unknown> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  return {
    out,
    err,
    urls,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      fetch: (async (u: string) => {
        urls.push(u);
        if (!(u in routes)) throw new Error("offline");
        return Response.json(routes[u]);
      }) as unknown as typeof fetch,
      readFile: async (p: string) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
      sha256Hex: sha,
      ed25519Verify: (x: string, m: string, s: string) => verify(null, Buffer.from(m, "utf8"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }), Buffer.from(s, "base64url")),
    },
  };
}
const file = (name: string, v: unknown) => {
  const p = join(dir, name);
  writeFileSync(p, typeof v === "string" ? v : JSON.stringify(v));
  return p;
};
const one = (i = 0) => structuredClone(bundle.replays[i]);
const verifyJson = async (args: string[], t = io()) => {
  const code = await run(["verify", ...args, "--json"], t.io);
  return { code, v: JSON.parse(t.out.join("\n")), t };
};

/** A replay signed like the site signs one, by `origin` with key `priv`. */
async function signed(doc: any, priv: ReturnType<typeof pkcs8>, kid: string, origin: string, result = doc.result, kind: "arena" | "fixture" = "arena") {
  const body = await sealBody(sha, { keyId: kid, origin, kind, runId: doc.id, model: "some-model", rules: "rules 0.6", taskVersion: "Normal 1.0", log: doc.log, result, signedAt: Date.parse("2026-10-28T00:00:00Z") });
  const seal: ReplaySeal = { ...body, signature: `ed25519:${sign(null, Buffer.from(sealMessage(body), "utf8"), priv).toString("base64url")}` };
  return { ...doc, result, replay: await replayBlock(sha, doc.log, seal) };
}

describe("forge verify: the first-clone fixture, offline", () => {
  it("verifies every dev-split replay with no network, and says the test key proves integrity only", async () => {
    const t = io();
    expect(await run(["verify", FIXTURE], t.io)).toBe(VERIFY_EXIT.verified);
    expect(t.urls).toEqual([]);
    expect(t.out.at(-1)).toBe(`${bundle.replays.length} of ${bundle.replays.length} replays verified.`);
    expect(t.out.at(-2)).toMatch(/^note: Signed with the public test key/);
    expect(bundle.replays.every((r: any) => r.seed >= 900_001 && r.seed <= 900_005)).toBe(true);
    const text = readFileSync(FIXTURE, "utf8");
    for (const id of PRIVATE_TASK_IDS) expect(text).not.toContain(id);
  });

  it("--json gives structured data with an exit code", async () => {
    const { code, v } = await verifyJson([FIXTURE]);
    expect(code).toBe(0);
    expect(v).toMatchObject({ format: "forge-verify/1", status: "verified", exit_code: 0, error: null });
    expect(v.replays[0]).toMatchObject({ format: 2, chain: "ok", record: "ok", signature: "ok", key_id: FIXTURE_KEY.kid, key_source: "public_test_key", referee: { checked: true, same_verdict: true, same_rules: true } });
  });
});

describe("forge verify: what fails", () => {
  it("tampering with any event fails (exit 1) and names the event", async () => {
    const d = one(1);
    for (const i of [0, 3, d.log.length - 1]) {
      const x = structuredClone(d);
      x.log[i].t += 1;
      const t = io();
      expect(await run(["verify", file(`tamper-${i}.json`, x)], t.io)).toBe(VERIFY_EXIT.failed);
      expect(t.out.join("\n")).toContain(`The log was changed at event ${i}`);
    }
  });

  it("reordering events fails", async () => {
    const x = one(2);
    [x.log[1], x.log[2]] = [x.log[2], x.log[1]];
    expect((await verifyJson([file("reorder.json", x)])).code).toBe(VERIFY_EXIT.failed);
  });

  it("a truncated log fails, even with its chain cut to match", async () => {
    const x = one(3);
    x.log = x.log.slice(0, -1);
    x.replay.chain = x.replay.chain.slice(0, -1);
    const t = io();
    expect(await run(["verify", file("truncated.json", x)], t.io)).toBe(VERIFY_EXIT.failed);
    expect(t.out.join("\n")).toContain("The log ends early");
  });

  it("a key set without the right key fails the signature (exit 1); a key set without the key id can't check (exit 2)", async () => {
    const wrong = file("wrong-keys.json", { format: "forge-keys/1", origin: "x", keys: [{ kid: FIXTURE_KEY.kid, kty: "OKP", crv: "Ed25519", x: xOf(pkcs8("someone else")) }], rotation: [] });
    const { code, v } = await verifyJson([file("ok.json", one(4)), "--keys", wrong]);
    expect(code).toBe(VERIFY_EXIT.failed);
    expect(v.replays[0].signature).toBe("failed");
    const other = file("other-keys.json", { format: "forge-keys/1", origin: "x", keys: [{ kid: "forge-0000000000000000", kty: "OKP", crv: "Ed25519", x: FIXTURE_KEY.x }], rotation: [] });
    expect((await verifyJson([file("ok.json", one(4)), "--keys", other])).code).toBe(VERIFY_EXIT.unable);
  });

  it("a replay signed with a different key under the test key's id fails", async () => {
    const forged = await signed(one(5), pkcs8("not the fixture"), FIXTURE_KEY.kid, "fixture:dev-split", undefined, "fixture");
    expect((await verifyJson([file("forged.json", forged)])).code).toBe(VERIFY_EXIT.failed);
  });

  it("a validly signed replay whose verdict the open referee doesn't reach fails (recomputed-verdict mismatch)", async () => {
    const k = pkcs8("forge test site");
    const d = one(0);
    const lie = await signed(d, k, "forge-test", "fixture:dev-split", { ...d.result, passed: !d.result.passed });
    const keys = file("site-keys.json", { format: "forge-keys/1", origin: "x", keys: [{ kid: "forge-test", kty: "OKP", crv: "Ed25519", x: xOf(k) }], rotation: [] });
    const t = io();
    expect(await run(["verify", file("lie.json", lie), "--keys", keys], t.io)).toBe(VERIFY_EXIT.failed);
    expect(t.out.join("\n")).toContain("reaches a different verdict");
  });

  it("an edited published verdict fails the record check", async () => {
    const x = one(0);
    x.result.passed = !x.result.passed;
    const { code, v } = await verifyJson([file("edited.json", x)]);
    expect(code).toBe(VERIFY_EXIT.failed);
    expect(v.replays[0].record).toBe("failed");
  });
});

describe("forge verify: replays from the site", () => {
  const k = pkcs8("site key for tests");
  const origin = "https://theagentforge.io";
  const keys = { format: "forge-keys/1", origin, keys: [{ kid: "forge-aaaaaaaaaaaaaaaa", kty: "OKP", crv: "Ed25519", x: xOf(k), use: "sig", status: "current", from: "2026-10-28", retired: null }], rotation: [] };

  it("fetches the replay and the signer's published keys, and verifies", async () => {
    const doc = await signed(one(0), k, "forge-aaaaaaaaaaaaaaaa", origin);
    const url = `${origin}/arena/run/${doc.id}.json`;
    const t = io({ [url]: doc, [`${origin}${KEYS_PATH}`]: keys });
    expect(await run(["verify", url], t.io)).toBe(VERIFY_EXIT.verified);
    expect(t.urls).toEqual([url, `${origin}${KEYS_PATH}`]);
    expect(t.out[0]).toContain("published by https://theagentforge.io");
  });

  it("a replay signed by a site that isn't The Forge can't be checked without --keys (exit 2)", async () => {
    const doc = await signed(one(0), k, "forge-aaaaaaaaaaaaaaaa", "https://evil.example");
    const t = io();
    expect(await run(["verify", file("evil.json", doc)], t.io)).toBe(VERIFY_EXIT.unable);
    expect(t.out.join("\n")).toContain("isn't The Forge");
    expect(t.urls).toEqual([]);
  });

  it("a format v1 run is partly checked (exit 3): only the referee re-run, stated plainly", async () => {
    const d = one(0);
    const v1 = { id: d.id, result: d.result, log: d.log, signature: "hmac-sha256:00", replay: { format: "forge-replay/1" } };
    const t = io();
    expect(await run(["verify", file("v1.json", v1)], t.io)).toBe(VERIFY_EXIT.partial);
    expect(t.out.join("\n")).toContain("only the site can check it");
    expect(t.out.join("\n")).toContain("Gauntlet jobs before v2 were never signed");
  });

  it("an unknown replay format is not checked (exit 2), never downgraded to v1", async () => {
    const x = one(0);
    x.replay.format = "forge-replay/3";
    const t = io();
    expect(await run(["verify", file("v3.json", x)], t.io)).toBe(VERIFY_EXIT.unable);
    expect(t.out.join("\n")).toContain("Unknown replay format forge-replay/3");
    const y = one(0);
    delete y.replay.seal;
    expect((await verifyJson([file("stripped.json", y)])).code).toBe(VERIFY_EXIT.failed);
  });

  it("the public test key is trusted only for fixture seals, never for one claiming to be an Arena run", async () => {
    const fake = await signed(one(0), pkcs8(FIXTURE_KEY.seed_text), FIXTURE_KEY.kid, "fixture:dev-split");
    expect(fake.replay.seal.kind).toBe("arena");
    const { code, v } = await verifyJson([file("fake-arena.json", fake)]);
    expect(code).toBe(VERIFY_EXIT.unable);
    expect(v.replays[0].key_source).toBeNull();
  });

  it("a run re-scored after sealing verifies against its sealed original, with a note saying so", async () => {
    const doc = await signed(one(0), k, "forge-aaaaaaaaaaaaaaaa", origin);
    doc.result = { ...doc.result, rescored: { rules: doc.result.rules, at: "2026-11-01T00:00:00.000Z", before: {}, flips: [], sealed: doc.result } };
    const url = `${origin}/arena/run/${doc.id}.json`;
    const t = io({ [url]: doc, [`${origin}${KEYS_PATH}`]: keys });
    expect(await run(["verify", url], t.io)).toBe(VERIFY_EXIT.verified);
    expect(t.out.join("\n")).toContain("re-scored this run");
  });

  it("plain-English errors for unreadable input (exit 2)", async () => {
    let t = io();
    expect(await run(["verify", join(dir, "nope.json")], t.io)).toBe(VERIFY_EXIT.unable);
    expect(t.err[0]).toMatch(/^NOT CHECKED: Can't read .*nope\.json/);
    t = io();
    expect(await run(["verify", file("bad.json", "not json")], t.io)).toBe(VERIFY_EXIT.unable);
    expect(t.err[0]).toContain("isn't JSON");
    t = io();
    expect(await run(["verify", "https://theagentforge.io/arena/run/x.json"], t.io)).toBe(VERIFY_EXIT.unable);
    expect(t.err[0]).toContain("Couldn't reach");
    t = io();
    expect(await run(["verify", file("empty.json", { hello: 1 })], t.io)).toBe(VERIFY_EXIT.unable);
    expect(t.out.join("\n")).toContain("This isn't a replay");
    t = io();
    expect(await run(["verify"], t.io)).toBe(2);
  });
});

describe("the published bundle", () => {
  it("carries the open referee but no private family, and verifies the fixture as a real command", async () => {
    const { bundle: build } = await import("../build.mjs");
    const out = join(dir, "cli.mjs");
    await build(out);
    const text = readFileSync(out, "utf8");
    for (const id of PRIVATE_TASK_IDS) expect(text).not.toContain(id);
    expect(text).toContain("forge-replay/2");
    let code = 0;
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [out, "verify", FIXTURE], { encoding: "utf8" });
    } catch (e: any) {
      code = e.status;
    }
    expect(code).toBe(0);
    expect(stdout).toContain("replays verified.");
  }, 60_000);
});
