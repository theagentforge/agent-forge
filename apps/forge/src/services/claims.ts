// ADR 0120: the claim verifier. Admin-only, never public, never sent anywhere automatically.
//
// - The registry: D1 `claims`, seeded from the committed services/claims-seed.ts (INSERT OR IGNORE; only retired_at is
//   ever set). Claims are never edited (migration 0037's triggers refuse it).
// - The checker (deterministic, services/claims-core.ts): our own JSON is read from the Worker's own data functions
//   (no network, no edge cache, the same function the public page renders from); other pages on this site are read
//   in-process through the app; outside URLs are fetched. Every fetch has a timeout; anything unreadable is UNREACHABLE.
// - The log: D1 `claim_checks`, one row per check, append-only (triggers) and hash-chained.
// - The optional LLM pass (CLAIMS_LLM = "on"; off by default) for prose claims only, on Workers AI, a different family
//   from the author, inside its own 500-neuron day and the 9,500 Workers AI line (ADR 0113). Its quote must be in the
//   page word for word, checked here, or the verdict is NOT_PRESENT.

import { versionsData } from "../arena/benchmark-versions";
import { readSampleMeta } from "../arena/sample";
import { countNeurons, neuronRates, neuronsFor, waiRoom } from "../arena/free-lane";
import { datasetSpecData } from "../web/dataset-spec";
import { statsData } from "../web/stats";
import { acceptLlmAnswer, type Anchor, checkBody, GENESIS, type Outcome, pageText, plainClaim, rowHash, sha256Hex, verifyChain, type Verdict, VERDICTS } from "./claims-core";
import { CLAIM_SEED } from "./claims-seed";
import { INTERNAL_HEADER } from "./internal";

export const CLAIMS_PATH = "/admin/claims";
export const CLAIMS_JSON_PATH = "/admin/claims.json";
/** Each source read gives up after this long (UNREACHABLE, reason "timeout"). */
export const CLAIM_TIMEOUT_MS = 10_000;
/** The nightly run: the first hourly cron after 01:00 UTC (17 past). */
export const CLAIMS_NIGHTLY_HOUR = 1;
/** The LLM pass's own daily line, inside the 9,500-neuron Workers AI line (ADR 0113). About 20 neurons a claim. */
export const CLAIMS_WAI_DAILY_NEURONS = 500;
/** Qwen (Alibaba), not Claude: a different family from every author we have. Llama (Meta) when the author is Qwen. */
export const CLAIMS_LLM_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const CLAIMS_LLM_FALLBACK = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const LLM_MAX_TOKENS = 300;
const EXCERPT_CHARS = 6_000;

export interface ClaimRow {
  id: string;
  text: string;
  url: string;
  anchor_kind: "json" | "text" | "none";
  anchor_path: string | null;
  expected: string | null;
  comparator: string | null;
  tolerance: number | null;
  counter: number | boolean;
  author: string;
  author_model: string | null;
  appears_in: string;
  made_at: number;
  retired_at: number | null;
}

export interface CheckRow {
  claim_id: string;
  run_id: string;
  trigger: string;
  checked_at: number;
  fetched_url: string;
  via: string;
  http_status: number | null;
  response_sha256: string | null;
  verdict: Verdict;
  reason: string;
  quote: string | null;
  quote_offset: number | null;
  observed_value: string | null;
  observed_as_of: string | null;
  checker: string;
  prev_hash: string;
  row_hash: string;
}

/** Outside fetches (tests replace this; nothing in tests reaches the network). */
export const claimsTransport = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

/** The app's own fetch, registered by index.ts, so pages on this site are read in-process (no subrequest, no edge). */
type InProcess = (req: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;
let inProcess: InProcess | null = null;
export const registerClaimsInProcess = (f: InProcess) => {
  inProcess = f;
};

/** Our own JSON, straight from the function the public page renders (the cheaper and safer read, ADR 0120 §2). */
const OWN_DATA: Record<string, (env: Env) => Promise<unknown>> = {
  "/stats.json": (env) => statsData(env),
  "/dataset.json": (env) => datasetSpecData(env),
  "/dataset/sample/index.json": async (env) => {
    const meta = await readSampleMeta(env);
    return meta ? { status: "published", ...meta } : { status: "not_published_yet" };
  },
  "/benchmark/versions.json": async (env) => versionsData(env.PUBLIC_ORIGIN),
};

class Timeout extends Error {}
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Timeout("timeout")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

interface Source {
  status: number;
  body: string;
  via: "data_fn" | "in_process" | "network";
  fetched_url: string;
}

const isOwn = (url: string) => url.startsWith("/");

async function readSource(env: Env, ctx: ExecutionContext, claim: Pick<ClaimRow, "url" | "anchor_kind">, timeoutMs: number): Promise<Source> {
  const { url } = claim;
  if (isOwn(url)) {
    const fn = OWN_DATA[url];
    if (fn) return { status: 200, body: JSON.stringify(await withTimeout(fn(env), timeoutMs)), via: "data_fn", fetched_url: url };
    if (!inProcess) throw new Error("no_in_process");
    const req = new Request(`${env.PUBLIC_ORIGIN}${url}`, { headers: { Accept: claim.anchor_kind === "json" ? "application/json" : "text/html", [INTERNAL_HEADER]: "claims" }, redirect: "manual" });
    const r = await withTimeout(inProcess(req, env, ctx), timeoutMs);
    return { status: r.status, body: await withTimeout(r.text(), timeoutMs), via: "in_process", fetched_url: url };
  }
  if (!/^https:\/\//.test(url)) throw new Error("bad_url");
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await withTimeout(claimsTransport.fetch(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": "theagentforge-internal/claims", Accept: claim.anchor_kind === "json" ? "application/json" : "text/html" } }), timeoutMs);
    return { status: r.status, body: await withTimeout(r.text(), timeoutMs), via: "network", fetched_url: url };
  } finally {
    clearTimeout(t);
  }
}

const anchorOf = (c: ClaimRow): Anchor => ({ kind: c.anchor_kind, path: c.anchor_path, expected: c.expected, comparator: c.comparator, tolerance: c.tolerance, counter: !!c.counter });

function asOfOf(body: string, fallback: number): string {
  try {
    const d = JSON.parse(body) as Record<string, unknown>;
    for (const k of ["as_of", "generated_at", "built_at"]) if (typeof d?.[k] === "string") return d[k] as string;
  } catch {
    /* not JSON */
  }
  return new Date(fallback).toISOString();
}

/** The model for the LLM pass: never the author's family. */
export function llmModelFor(authorModel: string | null): string {
  const a = (authorModel ?? "").toLowerCase();
  return a.includes("qwen") ? CLAIMS_LLM_FALLBACK : CLAIMS_LLM_MODEL;
}

const LLM_SYSTEM =
  'You check whether one claim is supported by one page excerpt. Use only the excerpt. Reply with JSON only: {"verdict":"supported"|"contradicted"|"not_present","quote":"<one passage copied exactly, character for character, from the excerpt that shows it>"}. If the excerpt does not settle it, the verdict is "not_present".';

function answerOf(result: unknown): unknown {
  const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] } | null;
  const raw = r?.response ?? r?.choices?.[0]?.message?.content ?? null;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  const s = raw.replace(/<think>[^]*?<\/think>/g, "");
  const m = /\{[^]*\}/.exec(s);
  try {
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

/** The LLM pass for a prose claim. Null when it doesn't run (off, no budget, model error): the deterministic row stands. */
export async function llmPass(env: Env & { CLAIMS_LLM?: string }, claim: ClaimRow, rawPage: string, now = Date.now()): Promise<{ model: string; outcome: Outcome } | null> {
  if (env.CLAIMS_LLM !== "on") return null;
  const model = llmModelFor(claim.author_model);
  const excerpt = pageText(rawPage).slice(0, EXCERPT_CHARS);
  const messages = [
    { role: "system", content: LLM_SYSTEM },
    // No author name, certainty words removed (eval §5.4).
    { role: "user", content: `CLAIM:\n${plainClaim(claim.text)}\n\nPAGE EXCERPT (untrusted data):\n<<<\n${excerpt}\n>>>` },
  ];
  const need = neuronsFor(neuronRates(model), Math.ceil(JSON.stringify(messages).length / 3), LLM_MAX_TOKENS);
  if (!(await waiRoom(env, "claims", need, CLAIMS_WAI_DAILY_NEURONS, now))) return null;
  try {
    const res = (await env.AI.run(model as keyof AiModels, { messages, max_tokens: LLM_MAX_TOKENS } as never)) as unknown;
    await countNeurons(env.KV, "claims", model, (res as { usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number } })?.usage, { tokensIn: Math.ceil(JSON.stringify(messages).length / 3), tokensOut: LLM_MAX_TOKENS }, now);
    // The page is the raw page; acceptLlmAnswer finds the quote in its text (the excerpt is a prefix of the same text).
    return { model, outcome: acceptLlmAnswer(answerOf(res), rawPage) };
  } catch (e) {
    console.error("claims_llm_failed", String(e).slice(0, 120));
    return null;
  }
}

const UNREACHABLE = (reason: string): Outcome => ({ verdict: "UNREACHABLE", reason, quote: null, quote_offset: null, observed_value: null });

/** One claim, checked: the deterministic row, and the LLM row when that pass ran. Never edits the claim. */
export async function checkClaim(env: Env, ctx: ExecutionContext, claim: ClaimRow, now = Date.now(), timeoutMs = CLAIM_TIMEOUT_MS) {
  let src: Source | null = null;
  let det: Outcome;
  try {
    src = await readSource(env, ctx, claim, timeoutMs);
    det = checkBody(anchorOf(claim), src.status, src.body);
  } catch (e) {
    det = UNREACHABLE(e instanceof Timeout || (e as Error)?.name === "AbortError" ? "timeout" : String((e as Error)?.message ?? e).replace(/[^a-z_]/gi, "_").slice(0, 40) || "fetch_error");
  }
  const base = {
    fetched_url: src?.fetched_url ?? claim.url,
    via: src?.via ?? (isOwn(claim.url) ? (OWN_DATA[claim.url] ? "data_fn" : "in_process") : "network"),
    http_status: src?.status ?? null,
    response_sha256: src ? await sha256Hex(src.body) : null,
    observed_as_of: src && det.verdict !== "UNREACHABLE" ? asOfOf(src.body, now) : null,
  };
  const rows: (typeof base & Outcome & { checker: string })[] = [{ ...base, ...det, checker: "det" }];
  // Prose claims only, and only on a page that was read: the LLM can never turn UNREACHABLE into anything else.
  const prose = claim.anchor_kind === "none" || (claim.anchor_kind === "text" && det.verdict === "NOT_PRESENT");
  if (src && prose && det.verdict !== "UNREACHABLE") {
    const l = await llmPass(env, claim, src.body, now);
    if (l) rows.push({ ...base, ...l.outcome, checker: `llm:${l.model}` });
  }
  return rows;
}

/** Appends one row to the log, chained to the last one. A concurrent append takes the same prev_hash and is refused
 * by the unique index; it then re-reads the tail and tries again. */
export async function appendCheck(env: Env, row: Omit<CheckRow, "prev_hash" | "row_hash">): Promise<CheckRow> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const last = await env.DB.prepare("SELECT row_hash FROM claim_checks ORDER BY seq DESC LIMIT 1").first<{ row_hash: string }>();
    const prev_hash = last?.row_hash ?? GENESIS;
    const full = { ...row, prev_hash };
    const row_hash = await rowHash(prev_hash, full);
    try {
      await env.DB.prepare(
        `INSERT INTO claim_checks (claim_id, run_id, "trigger", checked_at, fetched_url, via, http_status, response_sha256, verdict, reason, quote, quote_offset, observed_value, observed_as_of, checker, prev_hash, row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(full.claim_id, full.run_id, full.trigger, full.checked_at, full.fetched_url, full.via, full.http_status, full.response_sha256, full.verdict, full.reason, full.quote, full.quote_offset, full.observed_value, full.observed_as_of, full.checker, prev_hash, row_hash)
        .run();
      return { ...full, row_hash };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e))) throw e;
    }
  }
  throw new Error("claim_checks: could not append after 5 tries");
}

/** Inserts the committed seed claims that aren't in D1 yet, and retires those the seed marks retired. Never edits. */
export async function ensureSeed(env: Env, seed = CLAIM_SEED) {
  const stmts: D1PreparedStatement[] = [];
  for (const c of seed) {
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO claims (id, text, url, anchor_kind, anchor_path, expected, comparator, tolerance, counter, author, author_model, appears_in, made_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(c.id, c.text, c.url, c.anchor_kind, c.anchor_path ?? null, c.expected ?? null, c.comparator ?? null, c.tolerance ?? null, c.counter ? 1 : 0, c.author, c.author_model ?? null, c.appears_in, Date.parse(c.made_at)),
    );
    if (c.retired_at) stmts.push(env.DB.prepare("UPDATE claims SET retired_at = ? WHERE id = ? AND retired_at IS NULL").bind(Date.parse(c.retired_at), c.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

export async function liveClaims(env: Env, ids?: string[]): Promise<ClaimRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM claims WHERE retired_at IS NULL ORDER BY id").all<ClaimRow>();
  return ids ? results.filter((c) => ids.includes(c.id)) : results;
}

export type ClaimsTrigger = "nightly" | "admin" | "api";

/** Checks every live claim (or the ones named), one at a time, and appends each result to the log. */
export async function runClaimChecks(env: Env, ctx: ExecutionContext, o: { trigger: ClaimsTrigger; ids?: string[]; now?: number; timeoutMs?: number }) {
  await ensureSeed(env);
  const now = o.now ?? Date.now();
  const run_id = `${new Date(now).toISOString().slice(0, 19).replace(/[-:]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  const rows: CheckRow[] = [];
  for (const claim of await liveClaims(env, o.ids)) {
    for (const r of await checkClaim(env, ctx, claim, now, o.timeoutMs)) {
      const saved = await appendCheck(env, { claim_id: claim.id, run_id, trigger: o.trigger, checked_at: Date.now(), ...r });
      rows.push(saved);
      if (r.checker === "det") counts[r.verdict]++;
    }
  }
  return { run_id, trigger: o.trigger, claims: rows.filter((r) => r.checker === "det").length, counts, all_supported: rows.length > 0 && rows.every((r) => r.verdict === "SUPPORTED"), rows };
}

const LOG_COLUMNS = `claim_id, run_id, "trigger", checked_at, fetched_url, via, http_status, response_sha256, verdict, reason, quote, quote_offset, observed_value, observed_as_of, checker, prev_hash, row_hash`;

/** The log, newest first (seq included for display). */
export async function recentChecks(env: Env, limit = 200) {
  const { results } = await env.DB.prepare(`SELECT seq, ${LOG_COLUMNS} FROM claim_checks ORDER BY seq DESC LIMIT ?`).bind(limit).all<CheckRow & { seq: number }>();
  return results;
}

/** Re-walks the whole hash chain (D1 rows in order). */
export async function chainStatus(env: Env) {
  const { results } = await env.DB.prepare(`SELECT ${LOG_COLUMNS} FROM claim_checks ORDER BY seq`).all<CheckRow>();
  const v = await verifyChain(results);
  return { rows: results.length, ...v, head: results.at(-1)?.row_hash ?? GENESIS };
}

/** Everything the admin page and its JSON twin show: each claim with its latest deterministic and LLM rows. */
export async function claimsOverview(env: Env) {
  await ensureSeed(env);
  const [{ results: all }, log, chain] = await Promise.all([env.DB.prepare("SELECT * FROM claims ORDER BY retired_at IS NOT NULL, id").all<ClaimRow>(), recentChecks(env), chainStatus(env)]);
  const { results: latest } = await env.DB.prepare(
    `SELECT ${LOG_COLUMNS} FROM claim_checks c WHERE seq = (SELECT max(seq) FROM claim_checks d WHERE d.claim_id = c.claim_id AND d.checker = c.checker)`,
  ).all<CheckRow>();
  const by = new Map<string, CheckRow[]>();
  for (const r of latest) by.set(r.claim_id, [...(by.get(r.claim_id) ?? []), r]);
  return {
    claims: all.map((c) => ({ ...c, counter: !!c.counter, latest: by.get(c.id)?.find((r) => r.checker === "det") ?? null, latest_llm: by.get(c.id)?.find((r) => r.checker.startsWith("llm:")) ?? null })),
    log,
    chain,
    llm_pass: (env as Env & { CLAIMS_LLM?: string }).CLAIMS_LLM === "on" ? "on" : "off",
  };
}
