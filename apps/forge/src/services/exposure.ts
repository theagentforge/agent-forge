import { VERSION_PATTERN } from "@forge/shared";
import { osvPackageFor, queryAdvisoriesBatch, type Advisory, type OsvPackage } from "./advisories";
import { kevState, markExploited } from "./kev";

// "Was my agent stack hit?" (crisis-wave plan P2, C4): an agent sends the names and versions of what it has installed
// (npm and PyPI packages) and gets back the ones that match a published advisory. Names and versions only: no file
// contents, paths or environment, and nothing about the list is stored beyond daily counts (exposure:checks,
// exposure:hits). The answer is data, one line per match, never advice.

export const EXPOSURE_MAX_ITEMS = 500;
/** pip freeze or requirements text, read for `name==version` lines only. */
export const EXPOSURE_MAX_TEXT = 100_000;

export interface ExposureItem {
  ecosystem: "npm" | "pypi";
  name: string;
  version: string;
}

export interface ExposureMatch {
  package: string;
  ecosystem: "npm" | "pypi";
  version: string;
  /** "flagged": a malicious-package record for this exact version; "caution": any other advisory for it. */
  status: "flagged" | "caution";
  /** The match as one data line, e.g. "litellm 1.107.0 matches MAL-2026-2144; source https://osv.dev/…". */
  line: string;
  advisories: Pick<Advisory, "id" | "kind" | "aliases" | "fixed" | "exploited_in_wild" | "url">[];
}

export interface ExposureResult {
  source: "osv";
  checked_at: string;
  kev_as_of: string | null;
  items: number;
  checked: number;
  matched: number;
  /** Items OSV couldn't be asked about just now: "not checked", never "clear". */
  not_checked: { ecosystem: string; name: string; version: string }[];
  matches: ExposureMatch[];
}

export type ExposureError = { error: "invalid_items"; detail: string; invalid: { index: number; reason: string }[] } | { error: "no_items"; detail: string };

/** `name==version` lines from pip freeze or a pinned requirements file. Comments, options, URLs and ranges are skipped. */
export function parsePipFreeze(text: string): ExposureItem[] {
  const out: ExposureItem[] = [];
  for (const raw of text.slice(0, EXPOSURE_MAX_TEXT).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([A-Za-z0-9.+!_-]+)\s*(?:;.*)?$/.exec(line);
    if (m) out.push({ ecosystem: "pypi", name: m[1]!, version: m[2]! });
  }
  return out;
}

/** Validates and de-duplicates the items, keeping their order. */
export function normaliseItems(items: ExposureItem[]): { ok: { item: ExposureItem; pkg: OsvPackage }[] } | ExposureError {
  if (!items.length) return { error: "no_items", detail: "Give packages as {ecosystem, name, version} or pip_freeze text with name==version lines." };
  if (items.length > EXPOSURE_MAX_ITEMS) return { error: "invalid_items", detail: `At most ${EXPOSURE_MAX_ITEMS} items per call.`, invalid: [] };
  const invalid: { index: number; reason: string }[] = [];
  const seen = new Set<string>();
  const ok: { item: ExposureItem; pkg: OsvPackage }[] = [];
  items.forEach((item, index) => {
    const pkg = osvPackageFor(`${item.ecosystem}:${item.name}`);
    if (!pkg) return invalid.push({ index, reason: "name" });
    if (typeof item.version !== "string" || item.version.length > 64 || !VERSION_PATTERN.test(item.version)) return invalid.push({ index, reason: "version" });
    const key = `${pkg.ecosystem}:${pkg.name}@${item.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    ok.push({ item: { ecosystem: item.ecosystem, name: pkg.name, version: item.version }, pkg });
  });
  if (invalid.length) return { error: "invalid_items", detail: `${invalid.length} item(s) have a name or version we can't read.`, invalid: invalid.slice(0, 50) };
  return { ok };
}

const lineFor = (m: Omit<ExposureMatch, "line">) => {
  const a = m.advisories[0]!;
  const fixed = [...new Set(m.advisories.flatMap((x) => x.fixed))];
  return [
    `${m.package} ${m.version} matches ${m.advisories.map((x) => x.id).slice(0, 3).join(", ")}${m.advisories.length > 3 ? ` (+${m.advisories.length - 3})` : ""}`,
    fixed.length ? `fixed ${fixed.slice(0, 3).join(", ")}` : "no fixed version listed",
    ...(m.advisories.some((x) => x.exploited_in_wild) ? ["exploited in the wild (CISA KEV)"] : []),
    `source ${a.url}`,
  ].join("; ");
};

/** Asks OSV about every item at once (querybatch) and returns the matches. Never throws. */
export async function checkExposure(env: Pick<Env, "KV">, ok: { item: ExposureItem; pkg: OsvPackage }[], opts: { fetcher?: typeof fetch; now?: number } = {}): Promise<ExposureResult> {
  const now = opts.now ?? Date.now();
  const results = await queryAdvisoriesBatch(env, ok.map((o) => ({ pkg: o.pkg, version: o.item.version })), opts);
  const kev = await kevState(env);
  const matches: ExposureMatch[] = [];
  const notChecked: ExposureResult["not_checked"] = [];
  results.forEach((r, i) => {
    const { item } = ok[i]!;
    if (!r) return notChecked.push({ ...item });
    const marked = markExploited(r, kev.ids, kev.updated);
    if (!marked.advisories.length) return;
    const m: Omit<ExposureMatch, "line"> = {
      package: item.name,
      ecosystem: item.ecosystem,
      version: item.version,
      status: marked.advisories.some((a) => a.kind === "malicious") ? "flagged" : "caution",
      advisories: marked.advisories.map(({ id, kind, aliases, fixed, exploited_in_wild, url }) => ({ id, kind, aliases, fixed, exploited_in_wild, url })),
    };
    matches.push({ ...m, line: lineFor(m) });
  });
  matches.sort((a, b) => (a.status === b.status ? 0 : a.status === "flagged" ? -1 : 1));
  return {
    source: "osv",
    checked_at: new Date(now).toISOString(),
    kev_as_of: kev.updated,
    items: ok.length,
    checked: ok.length - notChecked.length,
    matched: matches.length,
    not_checked: notChecked,
    matches,
  };
}

/** Daily counters only: one check, and one hit per call that matched anything. */
export const exposureCounters = (r: ExposureResult) => ["exposure:checks", ...(r.matched ? ["exposure:hits"] : [])];

/**
 * One exposure request from MCP or HTTP: `packages` ({ecosystem, name, version}) and/or `pip_freeze` text. Returns the
 * result, or a structured error. Unknown keys and anything that isn't a name or version are never read.
 */
export async function exposureRequest(env: Pick<Env, "KV">, body: { packages?: unknown; pip_freeze?: unknown }, opts: { fetcher?: typeof fetch; now?: number } = {}): Promise<ExposureResult | ExposureError> {
  const raw = Array.isArray(body.packages) ? body.packages : [];
  if (raw.length > EXPOSURE_MAX_ITEMS) return { error: "invalid_items", detail: `At most ${EXPOSURE_MAX_ITEMS} items per call.`, invalid: [] };
  const items: ExposureItem[] = raw.map((p) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const eco = typeof o.ecosystem === "string" ? o.ecosystem.toLowerCase() : "";
    return { ecosystem: (eco === "pypi" ? "pypi" : eco === "npm" ? "npm" : "") as ExposureItem["ecosystem"], name: typeof o.name === "string" ? o.name.slice(0, 214) : "", version: typeof o.version === "string" ? o.version : "" };
  });
  if (typeof body.pip_freeze === "string") items.push(...parsePipFreeze(body.pip_freeze));
  const norm = normaliseItems(items);
  if ("error" in norm) return norm;
  return checkExposure(env, norm.ok, opts);
}
