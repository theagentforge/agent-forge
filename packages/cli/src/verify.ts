import {
  checkReplay,
  FIXTURE_KEY,
  FIXTURE_ORIGIN,
  KEYS_FORMAT,
  KEYS_PATH,
  refereeCheck,
  type ChainReport,
  type RefereeReport,
} from "@forge/arena/replay";

// `forge verify <replay-url-or-file>` (ADR 0066): checks a published replay on this machine. Format v2: the hash chain,
// the signed seal against the published key, the referee version, and that the open referee reaches the same verdict
// from the logged actions (public jobs). Format v1 (before 28 Oct 2026): no public signature exists, so only the
// referee re-run is done here and the result says so. Works offline for local files signed with the public test key
// (the first-clone fixture, fixtures/dev-split-replays.json in this package).

export const VERIFY_EXIT = { verified: 0, failed: 1, unable: 2, partial: 3 } as const;
export const VERIFY_FORMAT = "forge-verify/1";
/** Sites whose published keys are trusted without --keys. */
export const FORGE_ORIGINS = ["https://theagentforge.io", "https://staging.theagentforge.io"];
const MAX_BYTES = 50_000_000;

export type ReplayStatus = "verified" | "failed" | "unable" | "partial";
export type KeySource = "forge_published" | "public_test_key" | "supplied" | null;

export interface VerifyIo {
  fetch: typeof fetch;
  readFile?: (path: string) => Promise<string | null>;
  sha256Hex: (s: string) => string;
  /** Ed25519 check with a base64url public key `x`, over the message's UTF-8 bytes; signature is base64url. */
  ed25519Verify: (x: string, message: string, signature: string) => boolean;
  userAgent: string;
}

export interface ReplayVerdict {
  id: string | null;
  status: ReplayStatus;
  format: 1 | 2 | null;
  steps: number;
  chain: ChainReport["chain"];
  chain_break_at: number | null;
  record: ChainReport["record"];
  record_problems: string[];
  signature: ChainReport["signature"];
  key_id: string | null;
  key_source: KeySource;
  signed_by: string | null;
  referee: RefereeReport & { same_rules: boolean | null };
  /** Plain-English findings, worst first. */
  problems: string[];
  notes: string[];
}

export interface VerifyResult {
  format: typeof VERIFY_FORMAT;
  target: string;
  status: ReplayStatus;
  exit_code: number;
  replays: ReplayVerdict[];
  error: string | null;
}

type Keys = Map<string, string>;

const isUrl = (s: string) => /^https?:\/\//i.test(s);
const okUrl = (s: string) => /^https:\/\//i.test(s) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(s);

async function load(target: string, io: VerifyIo): Promise<{ text: string } | { error: string }> {
  if (isUrl(target)) {
    if (!okUrl(target)) return { error: `Only https:// addresses can be fetched (got ${target}).` };
    let res: Response;
    try {
      res = await io.fetch(target, { headers: { Accept: "application/json", "User-Agent": io.userAgent } });
    } catch {
      return { error: `Couldn't reach ${target}. Check the address and your connection, or download the file and verify it locally.` };
    }
    if (res.status === 404) return { error: `${target} wasn't found (404). Gauntlet tool calls are deleted 30 days after a run, so an older job's replay can't be checked.` };
    if (!res.ok) return { error: `${target} answered ${res.status}, not a replay.` };
    const text = await res.text();
    if (text.length > MAX_BYTES) return { error: `${target} is larger than 50 MB, which is too big for a replay.` };
    return { text };
  }
  if (!io.readFile) return { error: "This build can't read files." };
  const text = await io.readFile(target);
  if (text === null) return { error: `Can't read ${target}: no such file, or no permission to read it.` };
  return { text };
}

/** A key set from a file or URL: forge-keys/1, a single JWK, or a replay bundle's key. */
async function loadKeys(target: string, io: VerifyIo): Promise<Keys | { error: string }> {
  const got = await load(target, io);
  if ("error" in got) return { error: `The key set: ${got.error}` };
  let j: any;
  try {
    j = JSON.parse(got.text);
  } catch {
    return { error: `The key set at ${target} isn't JSON.` };
  }
  const list = j?.format === KEYS_FORMAT ? j.keys : j?.kid ? [j] : j?.key?.kid ? [j.key] : null;
  if (!Array.isArray(list)) return { error: `${target} isn't a key set (expected format ${KEYS_FORMAT}).` };
  const out: Keys = new Map();
  for (const k of list) if (k?.kty === "OKP" && k?.crv === "Ed25519" && typeof k.kid === "string" && typeof k.x === "string") out.set(k.kid, k.x);
  return out.size ? out : { error: `${target} has no Ed25519 keys.` };
}

const sentence = (r: ChainReport) => {
  const out: string[] = [];
  if (r.chain === "failed")
    out.push(
      r.chain_break_at === null
        ? "The hash chain doesn't match the log."
        : r.chain_break_at >= r.steps
          ? `The log ends early or the chain doesn't cover it: the seal says ${r.seal?.steps ?? "?"} events, the log has ${r.steps}.`
          : `The log was changed at event ${r.chain_break_at} (0-based): the hash chain breaks there.`,
    );
  if (r.record === "failed") out.push(...r.record_problems.map((p) => `${p[0]!.toUpperCase()}${p.slice(1)}.`));
  if (r.signature === "failed") out.push("The signature doesn't match the seal: the seal was edited, or it wasn't signed with this key.");
  return out;
};

async function verifyOne(doc: unknown, o: { keys: Keys | null; origins: string[]; fetchedKeys: Map<string, Keys | { error: string }> }, io: VerifyIo): Promise<ReplayVerdict> {
  const seal = (doc as any)?.replay?.seal;
  let keySource: KeySource = null;
  let signedBy: string | null = typeof seal?.origin === "string" ? seal.origin : null;
  let keys: Keys | null = null;
  const notes: string[] = [];
  const unableWhy: string[] = [];
  if (o.keys) {
    keys = o.keys;
    keySource = "supplied";
  } else if (seal?.key_id === FIXTURE_KEY.kid && seal?.origin === FIXTURE_ORIGIN && seal?.kind === "fixture") {
    keys = new Map([[FIXTURE_KEY.kid, FIXTURE_KEY.x]]);
    keySource = "public_test_key";
    notes.push("Signed with the public test key: this proves the file is intact and the referee agrees, not that The Forge produced it.");
  } else if (signedBy && o.origins.includes(signedBy)) {
    let got = o.fetchedKeys.get(signedBy);
    if (!got) {
      got = await loadKeys(`${signedBy}${KEYS_PATH}`, io);
      o.fetchedKeys.set(signedBy, got);
    }
    if ("error" in got) unableWhy.push(`Couldn't get The Forge's published keys. ${got.error}`);
    else {
      keys = got;
      keySource = "forge_published";
    }
  } else if (seal) {
    unableWhy.push(`It says it was signed by ${signedBy ?? "an unnamed site"}, which isn't The Forge. To check it anyway, pass that site's key set with --keys.`);
  }
  const verify = keys ? (kid: string, m: string, s: string) => (keys!.has(kid) ? io.ed25519Verify(keys!.get(kid)!, m, s.replace(/^ed25519:/, "")) : null) : null;
  let r: ChainReport;
  try {
    r = await checkReplay(doc, io.sha256Hex, verify);
  } catch {
    r = { format: null, run_id: null, steps: 0, chain: "not_checked", chain_break_at: null, record: "not_checked", record_problems: [], signature: "not_checked", key_id: null, seal: null, unknown_format: null, rescored_rules: null };
  }
  const ref = refereeCheck(doc);
  const sameRules = ref.rules_of_run && ref.rules_here ? ref.rules_of_run === ref.rules_here : null;
  const problems = sentence(r);
  if (r.signature === "unknown_key") unableWhy.push(`The key ${r.key_id} isn't in the key set${keySource === "forge_published" ? ` published at ${signedBy}${KEYS_PATH}` : ""}.`);
  if (ref.checked && ref.same_verdict === false) {
    const line = `The open referee (${ref.rules_here}) reaches a different verdict from the logged actions: ${ref.differences.slice(0, 3).join("; ")}.`;
    if (sameRules === false) notes.push(`${line} The run was scored under ${ref.rules_of_run}, and the rules changed since, so this is expected, not tampering.`);
    else problems.push(line);
  }
  if (ref.checked && ref.faithful === false && ref.same_verdict !== false) notes.push("The replay isn't faithful under today's job code (the job's world or tools changed since), so the re-run isn't a like-for-like check.");
  if (!ref.checked && ref.why) notes.push(`The referee wasn't re-run: ${ref.why}.`);
  if (r.format === 1)
    notes.push(
      "Format v1 (finished before replay format v2): it has no public signature, so the referee re-run is the only check made here. An Arena run's v1 signature uses The Forge's private HMAC key, so only the site can check it (the run page shows Verified replay); Gauntlet jobs before v2 were never signed.",
    );
  if (r.rescored_rules && r.record === "ok") notes.push(`The Forge re-scored this run under ${r.rescored_rules} after sealing it: the seal covers the original verdict (result.rescored.sealed), and the published verdict is the re-scored one, which the referee re-run checks.`);

  let status: ReplayStatus;
  if (r.unknown_format) {
    status = "unable";
    unableWhy.push(`Unknown replay format ${r.unknown_format}: this version of forge verify can't check it, so it checks nothing rather than guess. Update the CLI.`);
  } else if (r.format === null) {
    status = "unable";
    unableWhy.push("This isn't a replay: it has no log and no replay seal.");
  } else if (problems.length) status = "failed";
  else if (unableWhy.length) status = "unable";
  else if (r.format === 1 || !ref.checked || sameRules === false || ref.faithful === false) status = "partial";
  else status = "verified";
  return {
    id: r.run_id ?? (typeof (doc as any)?.id === "string" ? (doc as any).id : null),
    status,
    format: r.format,
    steps: r.steps,
    chain: r.chain,
    chain_break_at: r.chain_break_at,
    record: r.record,
    record_problems: r.record_problems,
    signature: r.signature,
    key_id: r.key_id,
    key_source: keySource,
    signed_by: signedBy,
    referee: { ...ref, same_rules: sameRules },
    problems: [...problems, ...unableWhy],
    notes,
  };
}

const RANK: ReplayStatus[] = ["verified", "partial", "unable", "failed"];
const worst = (xs: ReplayStatus[]) => xs.reduce<ReplayStatus>((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a), "verified");

export async function verifyTarget(target: string, o: { keys?: string; origin?: string }, io: VerifyIo): Promise<VerifyResult> {
  const fail = (error: string): VerifyResult => ({ format: VERIFY_FORMAT, target, status: "unable", exit_code: VERIFY_EXIT.unable, replays: [], error });
  let keys: Keys | null = null;
  if (o.keys) {
    const k = await loadKeys(o.keys, io);
    if ("error" in k) return fail(k.error);
    keys = k;
  }
  const got = await load(target, io);
  if ("error" in got) return fail(got.error);
  let j: any;
  try {
    j = JSON.parse(got.text);
  } catch {
    return fail(`${target} isn't JSON, so it can't be a replay. Replays are the .json files linked from each run page.`);
  }
  const docs: unknown[] = j?.format === "forge-replay-bundle/1" && Array.isArray(j.replays) ? j.replays : [j];
  if (!docs.length) return fail(`${target} holds no replays.`);
  const origins = [...FORGE_ORIGINS, ...(o.origin ? [o.origin] : [])];
  const fetchedKeys = new Map<string, Keys | { error: string }>();
  const replays: ReplayVerdict[] = [];
  for (const d of docs) replays.push(await verifyOne(d, { keys, origins, fetchedKeys }, io));
  const status = worst(replays.map((r) => r.status));
  return { format: VERIFY_FORMAT, target, status, exit_code: VERIFY_EXIT[status], replays, error: null };
}

const LABEL: Record<ReplayStatus, string> = { verified: "VERIFIED", failed: "FAILED", unable: "NOT CHECKED", partial: "PARTLY CHECKED" };

/** Plain-English lines for a person. */
export function verifyLines(v: VerifyResult): string[] {
  if (v.error) return [`NOT CHECKED: ${v.error}`];
  const lines: string[] = [];
  // A note every replay shares (a bundle signed with the test key) is said once, at the end.
  const shared = v.replays.length > 1 ? v.replays[0]!.notes.filter((n) => v.replays.every((r) => r.notes.includes(n))) : [];
  for (const r of v.replays) {
    const what: string[] = [];
    if (r.format === 2) {
      if (r.chain === "ok") what.push(`hash chain intact (${r.steps} events)`);
      if (r.signature === "ok") what.push(`signature valid (key ${r.key_id}${r.key_source === "public_test_key" ? ", public test key" : r.key_source === "supplied" ? ", key you supplied" : `, published by ${r.signed_by}`})`);
    }
    if (r.referee.checked && r.referee.same_verdict) what.push(`referee ${r.referee.rules_here} recomputed the same verdict (${r.referee.recomputed.passed ? "passed" : "not passed"}, ${r.referee.recomputed.reason})`);
    if (r.referee.rules_of_run) what.push(`scored under ${r.referee.rules_of_run}`);
    lines.push(`${LABEL[r.status]} ${r.id ?? "(no id)"}${r.format ? ` · format v${r.format}` : ""}${what.length ? `: ${what.join("; ")}.` : ""}`);
    for (const p of r.problems) lines.push(`  - ${p}`);
    for (const n of r.notes) if (!shared.includes(n)) lines.push(`  note: ${n}`);
  }
  for (const n of shared) lines.push(`note: ${n}`);
  if (v.replays.length > 1) {
    const n = (s: ReplayStatus) => v.replays.filter((r) => r.status === s).length;
    lines.push(`${n("verified")} of ${v.replays.length} replays verified${n("partial") ? `, ${n("partial")} partly checked` : ""}${n("unable") ? `, ${n("unable")} not checked` : ""}${n("failed") ? `, ${n("failed")} FAILED` : ""}.`);
  }
  return lines;
}
