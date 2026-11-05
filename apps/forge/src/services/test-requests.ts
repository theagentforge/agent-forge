import { and, asc, eq, gte, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import * as t from "../db/schema";
import { getDb, newId } from "./db";
import { scanToolList, toolsBatchSchema } from "./house-tools";
import { registryTransport } from "./registry";

// ADR 0131: "Request a test" (build plan 5 Nov, P1 item 6). Anyone names a public npm or PyPI MCP server at an exact
// version; it joins the next weekly-sweep run of the House tester (.github/workflows/house-tester.yml, 05:41 UTC) and
// gets a dated public result page with a right of reply.
//
// - Input: a registry, a package name and an exact version. Never a URL, never credentials, environment variables or
//   arguments (unknown fields are refused). The package must exist at that version: the registry is asked here.
// - One row per server + version: a second request for the same one answers with the first one's status.
// - Limits: REPORT_LIMITER per IP per minute, then per IP per UTC day, all requests per UTC day, and a queue cap, all
//   checked again inside the single INSERT, so a sweep can never take more than REQUEST_CAPS.perSweep requests.
// - Attribution: a request counts as an owner's only after GitHub ownership proof (the signed-in account or one of its
//   public orgs is the owner named in the package's repository field: the publisher-claims rule). Unclaimed requests
//   run the same way but never count as outside use; their numbers are admin-only (/admin/requests).
// - Results use the scan wording rules: a match is "matches pattern X in tool Y", and a clear scan means no known
//   pattern matched.

export const REQUEST_CAPS = { perIpDay: 5, globalDay: 50, queue: 100, perSweep: 20 } as const;
/** The weekly sweep's daily start (the public mirror's cron "41 5 * * *"). */
export const SWEEP_UTC = { hour: 5, minute: 41 } as const;
/**
 * A queued request stays in the public queue until the sweep answers for it (a failed shard means it is offered again
 * the next day). One still unanswered this long after it was asked for is closed as not_tested, so a server that keeps
 * killing its shard can't hold a sweep slot for ever.
 */
export const STALE_MS = 7 * 86_400_000;
export const REQUEST_PATH = "/request-a-test";
export const REQUEST_FAMILY = "requested_servers";
const TIMEOUT_MS = 5000;

export type Registry = "npm" | "pypi";
export type Channel = "web" | "api" | "mcp";

const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PYPI_NAME = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/;
/** An exact semver version: no ranges, tags or "latest". */
const NPM_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]{1,64})?(\+[0-9A-Za-z.-]{1,64})?$/;
/** An exact PEP 440 public version: no specifiers, wildcards or local labels. */
const PYPI_VERSION = /^(\d{1,9}!)?\d{1,12}(\.\d{1,12}){0,5}((a|b|rc)\d{1,6})?(\.post\d{1,6})?(\.dev\d{1,6})?$/i;
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** What the request takes, and nothing else (strict: env, args, headers, url or token fields are refused). */
export const requestInput = z.strictObject({
  id: z.string().max(300).optional().describe("Package id with its exact version: npm:name@1.2.3, npm:@scope/name@1.2.3, pypi:name==1.2.3"),
  registry: z.enum(["npm", "pypi"]).optional().describe("npm or pypi (with package and version, as an alternative to id)"),
  package: z.string().max(214).optional().describe("The package name on that registry"),
  version: z.string().max(64).optional().describe("The exact published version, e.g. 1.4.2"),
});

export type RequestError =
  | { error: "invalid_input"; field: string | null; detail: string }
  | { error: "unsupported_field"; field: string; detail: string }
  | { error: "not_found_on_registry"; registry: Registry; package: string; version: string }
  | { error: "registry_unavailable"; retry_after_s: number }
  | { error: "rate_limited"; retry_after_s: number }
  | { error: "daily_limit_reached"; scope: "ip" | "global"; retry_after_s: number }
  | { error: "queue_full"; retry_after_s: number };

export type Parsed = { ok: true; registry: Registry; pkg: string; version: string } | { ok: false; error: RequestError };

const bad = (field: string | null, detail: string): Parsed => ({ ok: false, error: { error: "invalid_input", field, detail } });

/** Validates a request. Pure. */
export function parseRequest(raw: unknown): Parsed {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad(null, "expected an object with id, or registry, package and version");
  const extra = Object.keys(raw).find((k) => !(k in requestInput.shape));
  if (extra) return { ok: false, error: { error: "unsupported_field", field: extra.slice(0, 40), detail: "only id, registry, package and version are accepted; no credentials, environment variables, arguments or URLs" } };
  const p = requestInput.safeParse(raw);
  if (!p.success) {
    const i = p.error.issues[0];
    return bad(i?.path.join(".") || null, "not in the accepted format");
  }
  let { registry, package: pkg, version } = p.data;
  const id = p.data.id?.trim();
  for (const [field, v] of [["id", id], ["package", pkg], ["version", version]] as const) {
    if (v && (/:\/\//.test(v) || /^(https?|git|ssh|file)[:+]/i.test(v) || /\s/.test(v.trim()))) return bad(field, "a package name and version only; URLs and paths are not accepted");
  }
  if (id) {
    if (registry || pkg || version) return bad("id", "give id, or registry, package and version, not both");
    const m = /^(npm|pypi):(.+?)(?:==|@)([^@=]+)$/i.exec(id);
    if (!m) return bad("id", "expected npm:name@version or pypi:name==version");
    registry = m[1]!.toLowerCase() as Registry;
    pkg = m[2]!;
    version = m[3]!;
  }
  if (!registry) return bad("registry", "npm or pypi");
  if (!pkg) return bad("package", "missing");
  if (!version) return bad("version", "missing: an exact published version");
  pkg = pkg.trim();
  version = version.trim();
  if (registry === "npm") {
    pkg = pkg.toLowerCase();
    if (pkg.length > 214 || !NPM_NAME.test(pkg)) return bad("package", "not a valid npm package name");
    if (!NPM_VERSION.test(version)) return bad("version", "not an exact version (no ranges, tags or latest)");
  } else {
    if (!PYPI_NAME.test(pkg.toLowerCase())) return bad("package", "not a valid PyPI project name");
    pkg = pep503(pkg);
    if (!PYPI_VERSION.test(version)) return bad("version", "not an exact version (no specifiers, wildcards or local labels)");
  }
  return { ok: true, registry, pkg, version };
}

/** owner/repo from a repository field (npm's string or {url}; PyPI's project URLs), GitHub only, lower case; or null. */
export function githubRepoFrom(value: unknown): { owner: string; repo: string } | null {
  const raw = typeof value === "string" ? value : value && typeof value === "object" && typeof (value as { url?: unknown }).url === "string" ? (value as { url: string }).url : "";
  const s = raw.trim();
  if (!s || s.length > 500) return null;
  const m =
    /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(s) ??
    /^git@github\.com:([^/]+)\/([^/#?]+)/i.exec(s) ??
    /^github:([^/]+)\/([^/#?]+)$/i.exec(s) ??
    /^([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)$/i.exec(s);
  if (!m) return null;
  const owner = m[1]!.toLowerCase();
  const repo = m[2]!.toLowerCase().replace(/\.git$/, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(owner) || !/^[a-z0-9._-]{1,100}$/.test(repo)) return null;
  return { owner, repo };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

export type Lookup = { found: true; fingerprint: string; repo: { owner: string; repo: string } | null } | { found: false } | { unavailable: true };

/**
 * Asks the registry whether this exact version is published, with its fingerprint (the House tester's: npm, sha256 of
 * dist.integrity; PyPI, sha256 over the sorted sha256 digests of the version's files) and its GitHub repository. Only
 * registry.npmjs.org and pypi.org are ever fetched, with the name and version only, and redirects are never followed
 * (a 3xx answers "not found"). Never throws.
 */
export async function lookupPackage(registry: Registry, pkg: string, version: string): Promise<Lookup> {
  try {
    if (registry === "npm") {
      const res = await registryTransport.fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" }, redirect: "manual" });
      // A redirect is never followed (it could name another host); the exact name and version must answer directly.
      if (res.status === 404 || (res.status >= 300 && res.status < 400)) return { found: false };
      if (!res.ok) return { unavailable: true };
      const m = (await res.json()) as { name?: unknown; version?: unknown; dist?: { integrity?: unknown }; repository?: unknown };
      if (m.version !== version || String(m.name ?? "").toLowerCase() !== pkg || typeof m.dist?.integrity !== "string") return { found: false };
      return { found: true, fingerprint: `sha256:${await sha256Hex(m.dist.integrity)}`, repo: githubRepoFrom(m.repository) };
    }
    const res = await registryTransport.fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" }, redirect: "manual" });
    if (res.status === 404 || (res.status >= 300 && res.status < 400)) return { found: false };
    if (!res.ok) return { unavailable: true };
    const m = (await res.json()) as { info?: { name?: unknown; version?: unknown; project_urls?: Record<string, unknown> | null; home_page?: unknown }; urls?: { yanked?: boolean; digests?: { sha256?: unknown } }[] };
    if (m.info?.version !== version || pep503(String(m.info?.name ?? "")) !== pkg) return { found: false };
    const digests = (m.urls ?? []).filter((f) => !f.yanked && typeof f.digests?.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.digests.sha256)).map((f) => f.digests!.sha256 as string);
    if (!digests.length) return { found: false };
    const urls = [...Object.values(m.info.project_urls ?? {}), m.info.home_page];
    const repo = urls.map(githubRepoFrom).find((r) => r) ?? null;
    return { found: true, fingerprint: `sha256:${await sha256Hex(digests.sort().join("\n"))}`, repo };
  } catch {
    return { unavailable: true };
  }
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The next sweep start strictly after `now`. */
export function nextSweepAt(now: number) {
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SWEEP_UTC.hour, SWEEP_UTC.minute);
  if (at <= now) at += 86_400_000;
  return at;
}

const secondsToNextDay = (now: number) => Math.max(60, Math.ceil((Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1) - now) / 1000));

/**
 * The address a limit counts against: an IPv4 address as it is, an IPv6 address by its /64 (one household or server
 * gets a whole /64, so per-address limits on IPv6 would be one rotation away from void).
 */
export function ipBucket(ip: string) {
  const s = ip.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1]!;
  if (!s.includes(":") || !/^[0-9a-f:]+$/.test(s) || s.split("::").length > 2) return s;
  const [head = "", tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

async function ipDayKey(secret: string, ip: string, day: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`test-request:${day}:${ip}`))).slice(0, 32);
}

type Row = typeof t.testRequests.$inferSelect;

export interface RequestResult {
  outcome: string;
  tested_at: string;
  fingerprint: string | null;
  tools_count: number | null;
  ms: number | null;
  slow: boolean;
  tools: string[];
  scan: {
    verdict: "clear" | "caution" | "flagged";
    rules_version: string;
    fingerprint: string;
    counts: Record<string, number>;
    findings: { rule: string; severity: string; title: string; tool: string; evidence: string; context?: "warning" }[];
  } | null;
}

export const toolIdOf = (r: Pick<Row, "registry" | "package">) => `${r.registry}:${r.package}`;
export const resultUrl = (origin: string, id: string) => `${origin}${REQUEST_PATH}/${id}`;
export const replyUrl = (origin: string, r: Pick<Row, "registry" | "package">) => `${origin}/disputes?tool=${encodeURIComponent(toolIdOf(r))}&from=maintainer`;

/** Where a queued request stands: 1-based, oldest first. */
async function queuePosition(env: Env, row: Row) {
  const [x] = await getDb(env)
    .select({ n: sql<number>`count(*)` })
    .from(t.testRequests)
    .where(and(eq(t.testRequests.status, "queued"), or(lt(t.testRequests.requestedAt, row.requestedAt), and(eq(t.testRequests.requestedAt, row.requestedAt), lt(t.testRequests.id, row.id)))));
  return Number(x?.n ?? 0) + 1;
}

/** The structured answer for agents and the JSON API (AGENTS.md rule 7: data only). */
export async function requestView(env: Env, row: Row, o: { duplicate?: boolean; now?: number } = {}) {
  const now = o.now ?? Date.now();
  const position = row.status === "queued" ? await queuePosition(env, row) : null;
  const expected = row.status === "queued" ? nextSweepAt(now) + Math.floor((position! - 1) / REQUEST_CAPS.perSweep) * 86_400_000 : null;
  const r = row.result as RequestResult | null;
  return {
    data_kind: "test_request",
    id: row.id,
    tool: toolIdOf(row),
    registry: row.registry,
    package: row.package,
    version: row.version,
    fingerprint: row.fingerprint,
    status: row.status as "queued" | "done",
    duplicate: !!o.duplicate,
    queue_position: position,
    expected_sweep_at: expected ? new Date(expected).toISOString() : null,
    requested_at: new Date(row.requestedAt).toISOString(),
    completed_at: row.completedAt ? new Date(row.completedAt).toISOString() : null,
    attribution: row.claimedAt ? ("owner_verified" as const) : ("unclaimed" as const),
    result_url: resultUrl(env.PUBLIC_ORIGIN, row.id),
    reply_url: replyUrl(env.PUBLIC_ORIGIN, row),
    result:
      row.status !== "done"
        ? null
        : !r
          ? { outcome: row.outcome ?? "not_tested", tested_at: null, tools_count: null, fingerprint: null, scan: null }
          : {
            outcome: r.outcome,
            tested_at: r.tested_at,
            tools_count: r.tools_count,
            // The fingerprint of what was started, when the House tester read one (a PyPI version can gain files).
            fingerprint: r.fingerprint,
            scan: r.scan ? { verdict: r.scan.verdict, rules_version: r.scan.rules_version, counts: r.scan.counts, rule_ids: [...new Set(r.scan.findings.map((f) => f.rule))] } : null,
          },
  };
}
export type RequestView = Awaited<ReturnType<typeof requestView>>;

const findServer = (env: Env, registry: string, pkg: string, version: string) =>
  getDb(env).query.testRequests.findFirst({ where: and(eq(t.testRequests.registry, registry), eq(t.testRequests.package, pkg), eq(t.testRequests.version, version)) });

export const getRequest = (env: Env, id: string) => (REQUEST_ID.test(id) ? getDb(env).query.testRequests.findFirst({ where: eq(t.testRequests.id, id) }) : Promise.resolve(undefined));

/** Who is asking. `isOwner` is the publisher-claims rule applied to the package's GitHub owner (web sign-in only). */
export interface Requester {
  channel: Channel;
  ip: string;
  humanId?: string | null;
  isOwner?: (repoOwner: string) => boolean;
}

/** Sets the claim when the signed-in requester proves ownership and nobody has claimed it yet. */
async function maybeClaim(env: Env, row: Row, who: Requester, now: number) {
  if (row.claimedAt || !who.humanId || !row.repoOwner || !who.isOwner?.(row.repoOwner)) return row;
  const u = await env.DB.prepare("UPDATE test_requests SET claimed_at = ?1, claimed_by_human_id = ?2 WHERE id = ?3 AND claimed_at IS NULL").bind(now, who.humanId, row.id).run();
  // Someone else's claim landed first: theirs stands, and this answer shows it.
  if (!u.meta.changes) return (await getRequest(env, row.id)) ?? row;
  await getDb(env).insert(t.auditLog).values({ id: newId(), actor: `human:${who.humanId}`, action: "test_request_claim", target: `test_request:${row.id}`, createdAt: now });
  return { ...row, claimedAt: now, claimedByHumanId: who.humanId };
}

async function capsReached(env: Env, ipDay: string, day: string): Promise<RequestError | null> {
  const r = await env.DB.prepare(
    `SELECT (SELECT count(*) FROM test_requests WHERE status = 'queued') AS queued,
            (SELECT count(*) FROM test_requests WHERE day = ?1) AS today,
            (SELECT count(*) FROM test_requests WHERE ip_day = ?2) AS mine`,
  )
    .bind(day, ipDay)
    .first<{ queued: number; today: number; mine: number }>();
  const now = Date.now();
  if ((r?.mine ?? 0) >= REQUEST_CAPS.perIpDay) return { error: "daily_limit_reached", scope: "ip", retry_after_s: secondsToNextDay(now) };
  if ((r?.today ?? 0) >= REQUEST_CAPS.globalDay) return { error: "daily_limit_reached", scope: "global", retry_after_s: secondsToNextDay(now) };
  if ((r?.queued ?? 0) >= REQUEST_CAPS.queue) return { error: "queue_full", retry_after_s: Math.ceil((nextSweepAt(now) - now) / 1000) };
  return null;
}

/** Files a request (or answers with the existing one for that server + version). */
export async function createRequest(env: Env, raw: unknown, who: Requester, now = Date.now()): Promise<{ ok: true; view: RequestView; created: boolean } | { ok: false; error: RequestError; status: number }> {
  const p = parseRequest(raw);
  if (!p.ok) return { ok: false, error: p.error, status: 400 };
  const bucket = ipBucket(who.ip);
  const { success } = await env.REPORT_LIMITER.limit({ key: `test-request:${bucket}` });
  if (!success) return { ok: false, error: { error: "rate_limited", retry_after_s: 60 }, status: 429 };
  const existing = await findServer(env, p.registry, p.pkg, p.version);
  if (existing) return { ok: true, created: false, view: await requestView(env, await maybeClaim(env, existing, who, now), { duplicate: true, now }) };

  await closeStale(env, now);
  const day = utcDay(now);
  const ipDay = await ipDayKey(env.SESSION_SECRET, bucket, day);
  // Checked before the registry is asked, so a flood never turns into outbound fetches.
  const capped = await capsReached(env, ipDay, day);
  if (capped) return { ok: false, error: capped, status: 429 };
  const found = await lookupPackage(p.registry, p.pkg, p.version);
  if ("unavailable" in found) return { ok: false, error: { error: "registry_unavailable", retry_after_s: 300 }, status: 503 };
  if (!found.found) return { ok: false, error: { error: "not_found_on_registry", registry: p.registry, package: p.pkg, version: p.version }, status: 404 };

  const id = newId();
  const claimed = !!(who.humanId && found.repo && who.isOwner?.(found.repo.owner));
  // One statement: the caps are checked again as the row goes in, so parallel requests can't pass them.
  const ins = await env.DB.prepare(
    `INSERT INTO test_requests (id, registry, package, version, fingerprint, repo_owner, repo_name, status, channel, requester_human_id, claimed_by_human_id, claimed_at, ip_day, day, requested_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8, ?9, ?10, ?11, ?12, ?13, ?14
     WHERE (SELECT count(*) FROM test_requests WHERE status = 'queued') < ?15
       AND (SELECT count(*) FROM test_requests WHERE day = ?13) < ?16
       AND (SELECT count(*) FROM test_requests WHERE ip_day = ?12) < ?17
     ON CONFLICT (registry, package, version) DO NOTHING`,
  )
    .bind(id, p.registry, p.pkg, p.version, found.fingerprint, found.repo?.owner ?? null, found.repo?.repo ?? null, who.channel, who.humanId ?? null, claimed ? who.humanId! : null, claimed ? now : null, ipDay, day, now, REQUEST_CAPS.queue, REQUEST_CAPS.globalDay, REQUEST_CAPS.perIpDay)
    .run();
  if (!ins.meta.changes) {
    const raced = await findServer(env, p.registry, p.pkg, p.version);
    if (raced) return { ok: true, created: false, view: await requestView(env, await maybeClaim(env, raced, who, now), { duplicate: true, now }) };
    return { ok: false, error: (await capsReached(env, ipDay, day)) ?? { error: "queue_full", retry_after_s: 3600 }, status: 429 };
  }
  if (claimed) await getDb(env).insert(t.auditLog).values({ id: newId(), actor: `human:${who.humanId}`, action: "test_request_claim", target: `test_request:${id}`, createdAt: now });
  const row = (await getRequest(env, id))!;
  return { ok: true, created: true, view: await requestView(env, row, { now }) };
}

/** Closes requests no sweep has answered for within STALE_MS (outcome not_tested). */
export async function closeStale(env: Env, now = Date.now()) {
  const r = await env.DB.prepare("UPDATE test_requests SET status = 'done', outcome = 'not_tested', completed_at = ?1 WHERE status = 'queued' AND requested_at < ?2").bind(now, now - STALE_MS).run();
  return r.meta.changes ?? 0;
}

/**
 * The sweep's input hook, read only: the next perSweep queued requests, oldest first, as the House tester's plan job
 * reads them (GET /api/v1/house/requests/queue; that job holds no token, by design). Names and versions only.
 */
export async function queueForSweep(env: Env, now = Date.now()) {
  const rows = await getDb(env)
    .select({ id: t.testRequests.id, registry: t.testRequests.registry, pkg: t.testRequests.package, version: t.testRequests.version })
    .from(t.testRequests)
    .where(and(eq(t.testRequests.status, "queued"), gte(t.testRequests.requestedAt, now - STALE_MS)))
    .orderBy(asc(t.testRequests.requestedAt), asc(t.testRequests.id))
    .limit(REQUEST_CAPS.perSweep);
  return rows.map((r) => ({ request_id: r.id, registry: r.registry as Registry, pkg: r.pkg, version: r.version }));
}

const OUTCOMES = ["worked", "partial", "failed", "needs_config", "no_answer", "not_on_npm", "not_on_pypi", "no_command", "error"] as const;
const houseServer = toolsBatchSchema.shape.servers.element;
const resultSchema = z.strictObject({
  request_id: z.string().regex(REQUEST_ID),
  registry: z.enum(["npm", "pypi"]),
  pkg: z.string().max(214),
  version: z.string().max(64),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  outcome: z.enum(OUTCOMES),
  tools_count: z.number().int().min(0).max(9_999).nullable(),
  ms: z.number().int().min(0).max(600_000).nullable(),
  slow: z.boolean(),
  tools: houseServer.shape.tools.nullable(),
});
export const resultsBatchSchema = z.strictObject({ probedAt: z.string().datetime(), results: z.array(resultSchema).min(1).max(REQUEST_CAPS.perSweep) });

/** Stores the House tester's answers for requested servers (file job, OIDC). Only queued rows that match are written. */
export async function completeRequests(env: Env, input: unknown, now = Date.now()) {
  const parsed = resultsBatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false as const, detail: parsed.error.issues[0]?.message };
  const db = getDb(env);
  await closeStale(env, now);
  let stored = 0;
  let ignored = 0;
  for (const r of parsed.data.results) {
    const row = await getRequest(env, r.request_id);
    if (!row || row.status !== "queued" || row.registry !== r.registry || row.package !== r.pkg || row.version !== r.version) {
      ignored++;
      continue;
    }
    const scan = r.outcome === "worked" && r.tools?.length ? await scanToolList({ id: toolIdOf(row), version: row.version, tools: r.tools }, now) : null;
    const result: RequestResult = {
      outcome: r.outcome,
      tested_at: parsed.data.probedAt,
      fingerprint: r.fingerprint,
      tools_count: r.tools_count,
      ms: r.ms,
      slow: r.slow,
      tools: (r.tools ?? []).map((x) => x.name).slice(0, 100),
      scan: scan ? { verdict: scan.verdict, rules_version: scan.rules_version, fingerprint: scan.fingerprint, counts: scan.counts, findings: scan.findings.map(({ family: _f, ...f }) => f) } : null,
    };
    await db.update(t.testRequests).set({ status: "done", completedAt: now, outcome: r.outcome, result }).where(and(eq(t.testRequests.id, row.id), eq(t.testRequests.status, "queued")));
    stored++;
  }
  return { ok: true as const, stored, ignored };
}

/**
 * The requested-servers metric family (admin only, ADR 0131): requests, claimed (owner-verified) and completed, per UTC
 * day and in total, from the table itself. Unclaimed requests are counted here and nowhere else.
 */
export async function requestMetrics(env: Env, days = 14, now = Date.now()) {
  const since = utcDay(now - (days - 1) * 86_400_000);
  const [tot] = await env.DB.prepare(
    `SELECT count(*) AS requests, coalesce(sum(claimed_at IS NOT NULL), 0) AS claimed, coalesce(sum(status = 'done'), 0) AS completed,
            coalesce(sum(status = 'queued'), 0) AS queued, coalesce(sum(outcome = 'not_tested'), 0) AS not_tested,
            coalesce(sum(status = 'done' AND claimed_at IS NOT NULL), 0) AS claimed_completed, min(day) AS first_day
       FROM test_requests`,
  ).all<Record<string, number | string | null>>().then((r) => r.results);
  const byDay = await env.DB.prepare(
    `SELECT day, count(*) AS requests, coalesce(sum(claimed_at IS NOT NULL), 0) AS claimed, coalesce(sum(status = 'done'), 0) AS completed
       FROM test_requests WHERE day >= ?1 GROUP BY day ORDER BY day DESC`,
  )
    .bind(since)
    .all<{ day: string; requests: number; claimed: number; completed: number }>()
    .then((r) => r.results);
  const byChannel = await env.DB.prepare(`SELECT channel, count(*) AS requests, coalesce(sum(claimed_at IS NOT NULL), 0) AS claimed FROM test_requests GROUP BY channel ORDER BY channel`)
    .all<{ channel: string; requests: number; claimed: number }>()
    .then((r) => r.results);
  const byOutcome = await env.DB.prepare(`SELECT outcome, count(*) AS n FROM test_requests WHERE status = 'done' GROUP BY outcome ORDER BY n DESC`)
    .all<{ outcome: string; n: number }>()
    .then((r) => r.results);
  const n = (k: string) => Number(tot?.[k] ?? 0);
  return {
    family: REQUEST_FAMILY,
    counted_at: new Date(now).toISOString(),
    first_day: (tot?.first_day as string | null) ?? null,
    totals: { requests: n("requests"), claimed: n("claimed"), completed: n("completed"), claimed_completed: n("claimed_completed"), queued: n("queued"), not_tested: n("not_tested") },
    caps: REQUEST_CAPS,
    by_day: byDay.map((d) => ({ day: d.day, requests: Number(d.requests), claimed: Number(d.claimed), completed: Number(d.completed) })),
    by_channel: byChannel.map((c) => ({ channel: c.channel, requests: Number(c.requests), claimed: Number(c.claimed) })),
    by_outcome: byOutcome.map((o) => ({ outcome: o.outcome, n: Number(o.n) })),
  };
}
