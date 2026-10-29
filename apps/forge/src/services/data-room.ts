import { and, count, desc, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { publicDatasetWhere } from "../arena/views";
import { BYOK_EXPIRES, byokSpendThisMonth, creditGuard, OPENROUTER_CREDIT_PURCHASED_USD } from "../arena/credit";
import * as t from "../db/schema";
import { thirdPartyData } from "../web/admin-kpis";
import { PEOPLE_RULES, statsData } from "../web/stats";
import { exportIndex, readManifest, type ExportManifest } from "./bulk-export";
import { ADR_INDEX, DOCS_INDEX_GENERATED, RUNBOOK_INDEX } from "./data-room-docs";
import { ASSET_SCHEDULE, CHECKLIST, COSTS, LEGAL_ITEMS } from "./data-room-private";
import { getDb } from "./db";
import { dataInventory, growthKpis } from "./kpis";
import { workTotals } from "./site-pulse";

// B2-09 and AQ-05 (ADR 0095): the private buyer data room. A founder admin sees it at /admin/data-room and can give one
// buyer, under NDA, a time-limited, revocable link (/data-room#<token>, ADR 0098) whose every access is logged. The outside-only
// numbers live here and on /admin/kpis only (Dinike, 28 Oct); every number is read live from the same functions as
// /admin/kpis and /stats, and each section carries the time it was read. Never indexed, never cached.

export const DATA_ROOM_PATH = "/admin/data-room";
/**
 * The buyer's side. The secret never travels in a URL the server sees (Workers Logs record every request URL, and a
 * path or query can reach browser history and proxies): a buyer link is `/data-room#<token>`, the fragment stays in the
 * browser, /data-room.js posts it in a form body to /data-room/open, and the Worker answers with an HttpOnly,
 * SameSite=Strict cookie scoped to /data-room. Every request re-checks the link (expiry, revocation) in D1.
 */
export const BUYER_PATH = "/data-room";
export const SHARE_PREFIX = "/data-room/";
export const BUYER_COOKIE = "forge_dr";
/** The cookie lives at most this long (and never past the link's end); the buyer reopens the link after it. */
export const BUYER_COOKIE_MAX_SECONDS = 8 * 3600;
export const shareUrl = (origin: string, token: string) => `${origin}${BUYER_PATH}#${token}`;
export const LINK_DAYS_DEFAULT = 14;
export const LINK_DAYS_MAX = 30;

/** NDA versions a buyer can confirm. The template is docs/strategy/nda-template.md (not yet lawyer-reviewed). */
export const NDA_VERSIONS = [
  { id: "forge-mutual-nda-template-2026-10-28", label: "The Agent Forge mutual NDA template, 28 Oct 2026 (not yet lawyer-reviewed)" },
  { id: "buyer-own-nda", label: "The buyer's own NDA (the admin note says which and when)" },
] as const;
export type NdaVersion = (typeof NDA_VERSIONS)[number]["id"];
export const isNdaVersion = (v: string): v is NdaVersion => NDA_VERSIONS.some((x) => x.id === v);

/** Response headers for every data-room response: private, never stored, never indexed, no referrer (the link is a secret). */
export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Referrer-Policy": "no-referrer",
} as const;

// --- The dataset table (W11: one count source) ------------------------------------------------------------------------

export interface DatasetRow {
  key: string;
  label: string;
  n: number;
  /** Where the same number is shown, and the rule that counts it. */
  rule: string;
}

/**
 * The dataset breakdown, from one source: the same functions /stats (workTotals) and /admin/kpis (dataInventory) use,
 * plus the /arena/dataset.json filter for public runs. The 3,031 vs 5,264 gap the audit found was public runs against
 * all refereed runs; both are rows here, with the runs that are not public broken down so the rows add up.
 */
export async function datasetBreakdown(env: Env, now = Date.now()) {
  const db = getDb(env);
  const [work, inv] = await Promise.all([workTotals(env), dataInventory(env, now)]);
  const n = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const done = eq(t.arenaRuns.status, "done");
  const runs = () => db.select({ n: count() }).from(t.arenaRuns).innerJoin(t.arenaEvents, eq(t.arenaEvents.id, t.arenaRuns.eventId));
  const [pub, heldOut, labArms, practice, rankedPublic] = await Promise.all([
    n(runs().where(publicDatasetWhere(now))),
    n(runs().where(and(done, eq(t.arenaRuns.heldOut, true)))),
    n(runs().where(and(done, eq(t.arenaRuns.heldOut, false), isNotNull(t.arenaEvents.arm)))),
    n(runs().where(and(done, eq(t.arenaEvents.kind, "practice")))),
    n(runs().where(and(publicDatasetWhere(now), or(eq(t.arenaEvents.kind, "card"), eq(t.arenaEvents.kind, "guest"))))),
  ]);
  const all = inv.refereed_runs.total;
  const rows: DatasetRow[] = [
    { key: "runs_all", label: "Refereed Arena runs, all", n: all, rule: "Every finished run (arena_runs.status = 'done'). /stats 'Arena bouts refereed' and /admin/kpis 'Refereed runs'." },
    { key: "runs_public", label: "…public, in /arena/dataset.json", n: pub, rule: "The /arena/dataset.json filter (views.ts publicDatasetWhere): no held-out seed, lab arm, embargoed model, private family, held event or unpremiered fixture. The 26 Oct '3,031 public runs' figure counted this row." },
    { key: "runs_held_out", label: "…private: held-out seeds", n: heldOut, rule: "arena_runs.held_out = 1. Counted only in aggregate, never published one by one (ADR 0058)." },
    { key: "runs_lab_arms", label: "…private: Forge Lab arms", n: labArms, rule: "Runs of lab events (arena_events.arm set), not held out. Published in each Lab's write-up, not in the dataset." },
    { key: "runs_other_withheld", label: "…private: other withheld runs", n: Math.max(0, all - pub - heldOut - labArms), rule: "The rest: embargoed models, private job families, events held for the results-policy notice, unpremiered fixtures." },
    { key: "runs_practice", label: "Practice runs (of all)", n: practice, rule: "arena_events.kind = 'practice'. Published but never ranked." },
    { key: "runs_ranked", label: "Ranked runs (of all)", n: inv.refereed_runs.ranked, rule: "Card and guest events, no lab arm (/admin/kpis 'ranked'). Held-out ranked runs are included here." },
    { key: "runs_ranked_public", label: "…of them public", n: rankedPublic, rule: "Ranked runs that pass the /arena/dataset.json filter." },
    { key: "runs_ranked_with_fall", label: "Ranked runs with a trap fall", n: inv.refereed_runs.with_trap_fall, rule: "Ranked runs with at least one trap triggered (/admin/kpis)." },
    { key: "runs_non_practice", label: "Non-practice runs (/stats '…of them ranked')", n: work.ranked_bouts ?? 0, rule: "/stats counts every run that isn't practice, lab arms and held-out runs included; it is not the same as 'Ranked runs' above." },
    { key: "traps_sprung_all", label: "Traps sprung, all runs", n: work.traps_sprung ?? 0, rule: "/stats 'Traps sprung': triggered traps across every finished run, practice included (one run can spring several)." },
    { key: "reports_readable", label: "Field reports, readable", n: work.field_reports ?? 0, rule: "/stats 'Field reports': not held, not rejected, House included." },
    { key: "reports_all", label: "Field reports, all stored", n: inv.field_reports.total, rule: "/admin/kpis: every row, held and rejected included." },
    { key: "reports_outside", label: "Field reports from outside the project", n: inv.field_reports.external, rule: "/admin/kpis: House and founder accounts left out. Outside-only: never public." },
    { key: "scans_all", label: "Distinct skill files scanned", n: inv.scans.unique_skills, rule: "/stats 'skills scanned' (launch-scan seed included)." },
    { key: "scans_public", label: "…public scan records", n: inv.scans.public, rule: "skill_scans.public = 1 (held scans are unlisted)." },
  ];
  const sum = pub + heldOut + labArms + Math.max(0, all - pub - heldOut - labArms);
  return {
    generated_at: new Date(now).toISOString(),
    rows,
    checks: {
      runs_match_stats: (work.bouts_refereed ?? 0) === all,
      parts_add_up: sum === all,
      dataset_json_cap: 5000,
      dataset_json_truncated: pub > 5000,
    },
  };
}

// --- The KPI time series ----------------------------------------------------------------------------------------------

export type SeriesBasis = "outside" | "ours" | "outside + ours" | "kpi (as defined)" | "dataset (gross)";

const DATA_LABELS: Record<string, string> = {
  data_refereed_runs: "Refereed runs, all",
  data_ranked_runs: "Ranked runs",
  data_trap_falls: "Ranked runs with a trap fall",
  data_models: "Ranked models",
  data_tasks_in_band: "Tasks in the 3–97% band",
  data_field_reports: "Field reports, all stored",
  data_unique_skills: "Distinct skill files scanned",
  data_controls_on: "Data controls on",
};

/** 30 days of the daily snapshots /admin/kpis draws its trends from (proof_snapshots), each row labelled by basis. */
export async function kpiSeries(env: Env, now = Date.now(), days = 30) {
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await getDb(env).select().from(t.proofSnapshots).where(gte(t.proofSnapshots.date, since)).orderBy(t.proofSnapshots.date);
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const { kpis } = await growthKpis(env, now);
  const kpiName = new Map(kpis.map((k) => [`kpi_${k.id}`, k.name]));
  const peopleLabel = new Map(PEOPLE_RULES.map((r) => [r.key, r.label]));
  const metrics = [...new Set(rows.map((r) => r.metric))].sort();
  const at = (metric: string, date: string) => rows.find((r) => r.metric === metric && r.date === date);
  const series: { metric: string; label: string; basis: SeriesBasis; values: (number | null)[] }[] = [];
  for (const m of metrics) {
    const v = (f: (r: (typeof rows)[number]) => number) => dates.map((d) => {
      const r = at(m, d);
      return r ? f(r) : null;
    });
    if (m.startsWith("kpi_")) series.push({ metric: m, label: kpiName.get(m) ?? m, basis: "kpi (as defined)", values: v((r) => r.externalValue) });
    else if (m.startsWith("data_")) series.push({ metric: m, label: DATA_LABELS[m] ?? m, basis: "dataset (gross)", values: v((r) => r.externalValue) });
    else {
      const label = peopleLabel.get(m as never) ?? m;
      series.push({ metric: m, label, basis: "outside", values: v((r) => r.externalValue) });
      series.push({ metric: m, label, basis: "ours", values: v((r) => r.houseValue) });
      series.push({ metric: m, label, basis: "outside + ours", values: v((r) => r.externalValue + r.houseValue) });
    }
  }
  return {
    generated_at: new Date(now).toISOString(),
    source: "proof_snapshots (the daily snapshot /admin/kpis trends read; one row per UTC day that ended)",
    days: dates,
    series,
    kpis: kpis.map((k) => ({ id: k.id, name: k.name, value: k.value, unit: k.unit, definition: k.definition })),
  };
}

// --- The pack ---------------------------------------------------------------------------------------------------------

/** Everything the data room shows, read now. JSON at /admin/data-room/pack.json. */
export async function buyerPack(env: Env, now = Date.now()) {
  const [dataset, series, third, stats, credit, byok, exports] = await Promise.all([
    datasetBreakdown(env, now),
    kpiSeries(env, now),
    thirdPartyData(env, now).catch(() => null),
    // B3-04 (ADR 0099): the data room shows every row, those below their public minimum included.
    statsData(env, { allRows: true }).catch(() => null),
    creditGuard(env, now).catch(() => null),
    byokSpendThisMonth(env, now).catch(() => null),
    exportIndex(env),
  ]);
  const latest: ExportManifest | null = exports[0] ? await readManifest(env, exports[0].export_id) : null;
  return {
    data_kind: "buyer_data_room" as const,
    internal_only: true as const,
    generated_at: new Date(now).toISOString(),
    nda_required: true,
    assets: { licences: "Each part's licence as it stands today; at sale every part transfers under the IP assignment.", rows: ASSET_SCHEDULE },
    kpis: {
      gross: stats ? { generated_at: stats.generated_at, source: "/stats.json (public; our own test agents included), with every row: rows below their public minimum (ADR 0099) are only here and on /admin/kpis", totals: stats.totals.items, people_and_7_days: stats.gross.items, install: stats.install } : null,
      outside_only: third
        ? { generated_at: third.generated_at, source: "/admin/stats/third-party.json (internal; never public)", rules_version: third.rules_version, splits: third.splits, active_owners_30d: third.active_owners_30d, owners: third.owners, install_outside: third.install?.outside ?? null }
        : null,
      series,
    },
    costs: {
      rows: COSTS,
      credit: {
        generated_at: new Date(now).toISOString(),
        source: "/admin/kpis credit panel (ADR 0064)",
        openrouter_bought_usd: OPENROUTER_CREDIT_PURCHASED_USD,
        openrouter_left_usd: credit?.remaining ?? null,
        openrouter_guard: credit?.state ?? null,
        anthropic_byok_spend_this_month_usd: byok?.usd ?? null,
        anthropic_byok_expires: new Date(BYOK_EXPIRES).toISOString().slice(0, 10),
      },
    },
    dataset,
    runbooks: { generated: DOCS_INDEX_GENERATED || null, rows: RUNBOOK_INDEX },
    adrs: { generated: DOCS_INDEX_GENERATED || null, rows: ADR_INDEX },
    legal: LEGAL_ITEMS,
    checklist: CHECKLIST,
    /** B3-03 (ADR 0102): documents built live for buyers. Admins download at `admin_path`; a confirmed buyer at `buyer_path`. */
    documents: [{ name: "Two-page buyer brief (PDF, built from live numbers at download, gross totals only)", admin_path: "/admin/brief.pdf", buyer_path: "/data-room/brief.pdf" }],
    export: latest ? { export_id: latest.export_id, created_at: latest.created_at, exports_pseudonymised: latest.exports_pseudonymised, counts: latest.counts, files: latest.files } : null,
  };
}
export type BuyerPack = Awaited<ReturnType<typeof buyerPack>>;

// --- Share links ------------------------------------------------------------------------------------------------------

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const tokenHash = async (token: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(`data-room:${token}`)));
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type Link = typeof t.dataRoomLinks.$inferSelect;
export type LinkState = "active" | "expired" | "revoked";
export const linkState = (l: Link, now = Date.now()): LinkState => (l.revokedAt ? "revoked" : now >= l.expiresAt ? "expired" : "active");

/** Makes a link. The token is returned once and only its hash is stored. */
export async function createLink(env: Env, o: { label: string; days: number; ndaVersion: NdaVersion; includeExport: boolean; by: string }, now = Date.now()) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const days = Math.min(LINK_DAYS_MAX, Math.max(1, Math.round(o.days) || LINK_DAYS_DEFAULT));
  const row = { id: crypto.randomUUID(), tokenHash: await tokenHash(token), label: o.label.slice(0, 80), ndaVersion: o.ndaVersion, includeExport: o.includeExport, createdAt: now, createdBy: o.by, expiresAt: now + days * 86_400_000 };
  await getDb(env).insert(t.dataRoomLinks).values(row);
  return { ...row, token };
}

/** Looks a link up by the SHA-256 of its token (an indexed equality on a hash: no comparison of the secret itself). */
export async function linkByToken(env: Env, token: string): Promise<Link | null> {
  if (!TOKEN.test(token)) return null;
  return (await getDb(env).query.dataRoomLinks.findFirst({ where: eq(t.dataRoomLinks.tokenHash, await tokenHash(token)) })) ?? null;
}

// The new link is shown to the admin once. It must not ride in the redirect's URL (Workers Logs record URLs), so it is
// kept for ten minutes in KV under a key bound to the admin's session and read (and deleted) by the next page load.
const madeKey = async (sessionToken: string) => `dataroom:made:${hex(await crypto.subtle.digest("SHA-256", enc.encode(`made:${sessionToken}`)))}`;
export async function stashMade(env: Env, sessionToken: string, token: string) {
  await env.KV.put(await madeKey(sessionToken), token, { expirationTtl: 600 });
}
export async function takeMade(env: Env, sessionToken: string) {
  const key = await madeKey(sessionToken);
  const token = await env.KV.get(key);
  if (token !== null) await env.KV.delete(key);
  return token && TOKEN.test(token) ? token : null;
}

export async function listLinks(env: Env) {
  const db = getDb(env);
  const links = await db.select().from(t.dataRoomLinks).orderBy(desc(t.dataRoomLinks.createdAt)).limit(100);
  const log = await db.select().from(t.dataRoomAccess).orderBy(desc(t.dataRoomAccess.at)).limit(500);
  return links.map((l) => ({ ...l, access: log.filter((a) => a.linkId === l.id) }));
}

export async function revokeLink(env: Env, id: string, by: string, now = Date.now()) {
  await getDb(env).update(t.dataRoomLinks).set({ revokedAt: now, revokedBy: by }).where(and(eq(t.dataRoomLinks.id, id), isNull(t.dataRoomLinks.revokedAt)));
}

export async function noteLink(env: Env, id: string, note: string, now = Date.now()) {
  await getDb(env).update(t.dataRoomLinks).set({ adminNote: note.slice(0, 500) || null, noteUpdatedAt: now }).where(eq(t.dataRoomLinks.id, id));
}

export async function confirmLink(env: Env, id: string, ndaVersion: string, org: string, now = Date.now()) {
  await getDb(env).update(t.dataRoomLinks).set({ confirmedAt: now, confirmedNdaVersion: ndaVersion, confirmedOrg: org.slice(0, 120) }).where(and(eq(t.dataRoomLinks.id, id), isNull(t.dataRoomLinks.confirmedAt)));
}

export type AccessEvent = "view" | "confirm" | "download" | "refused_expired" | "refused_revoked" | "refused_unconfirmed";

/** Logs one access: never the IP, only an HMAC of it with the link id, and Cloudflare's country code. */
export async function logAccess(env: Env, linkId: string, event: AccessEvent, req: Request, detail: string | null = null, now = Date.now()) {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const viewer = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`data-room-viewer:${linkId}:${ip}`))).slice(0, 12);
  const country = (req as Request & { cf?: { country?: string } }).cf?.country ?? null;
  await getDb(env).insert(t.dataRoomAccess).values({ id: crypto.randomUUID(), linkId, at: now, event, detail: detail?.slice(0, 120) ?? null, viewer, country: typeof country === "string" ? country.slice(0, 2) : null });
}

/** The CSRF token for a buyer's NDA confirmation (the buyer has no session): bound to the link. */
export async function confirmToken(env: Env, linkId: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`data-room-confirm:${linkId}`))).slice(0, 32);
}
