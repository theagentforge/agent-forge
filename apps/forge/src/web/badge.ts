import type { CheckResult } from "../services/forge";
import { checkTool } from "../services/forge";
import { recordBadgeReferrer } from "../services/growth";
import { site } from "./pages";

// README badges for maintainers (ADR 0011 e): an SVG and a shields.io endpoint. Pinned to the version the Forge
// has reports for, and only served for tools with data, so an empty badge never ends up in someone's README.

export interface Badge {
  label: string;
  message: string;
  color: string;
}

const COLORS = { green: "#2e9e6b", amber: "#c27c0e", red: "#c43c35", grey: "#5b6573" };

export function badgeFor(c: CheckResult): Badge | null {
  if (!c.known || c.distinct_owners === 0) return null;
  const v = c.version ? ` v${c.version}` : "";
  if (c.security_status === "confirmed_malicious") return { label: "forge", message: `malicious${v}`, color: COLORS.red };
  if (c.security_status === "flagged") return { label: "forge", message: `flagged${v}`, color: COLORS.red };
  if (c.security_status === "caution") return { label: "forge", message: `under review${v}`, color: COLORS.amber };
  const people = `${c.distinct_owners} ${c.distinct_owners === 1 ? "person" : "people"}`;
  if (c.forge_score != null) return { label: "forge", message: `${c.forge_score}${v} · ${people}`, color: c.forge_score >= 70 ? COLORS.green : c.forge_score >= 40 ? COLORS.amber : COLORS.red };
  return { label: "forge", message: `early reports${v} · ${people}`, color: COLORS.grey };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Rough Verdana 11px width, good enough for a flat badge. */
const width = (s: string) => Math.round(s.length * 6.6 + 10);

export function badgeSvg(b: Badge) {
  const lw = width(b.label);
  const mw = width(b.message);
  const w = lw + mw;
  const title = `${b.label}: ${b.message}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#0B0E12"/><rect x="${lw}" width="${mw}" height="20" fill="${b.color}"/><rect width="${w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(b.label)}</text><text x="${lw + mw / 2}" y="14">${esc(b.message)}</text></g></svg>`;
}

site.get("/badge/:file{.+\\.(svg|json)}", async (c) => {
  const file = c.req.param("file");
  const json = file.endsWith(".json");
  let id: string;
  try {
    id = decodeURIComponent(file.replace(/\.(svg|json)$/, ""));
  } catch {
    return c.text("Not a valid tool id.", 400);
  }
  const check = await checkTool(c.env, { id }).catch(() => null);
  const b = check ? badgeFor(check) : null;
  const headers = { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" };
  if (!b) return c.text("No reports for this tool yet, so there's no badge. It appears once an agent reports.", 404, { "Cache-Control": "public, max-age=600" });
  c.executionCtx.waitUntil(recordBadgeReferrer(c.env, c.req.header("Referer")).catch(() => {}));
  if (json) return c.json({ schemaVersion: 1, label: b.label, message: b.message, color: b.color.replace("#", "") }, 200, headers);
  return c.body(badgeSvg(b), 200, { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" });
});
