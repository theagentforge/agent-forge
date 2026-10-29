import { badgeSvg, toolBadge } from "./badge-core";
import { site } from "./pages";
import { scoreBadgeResponse } from "./score";

// GET /badge/<tool id>.svg|json (?v=<version> pins it): see badge-core.ts for what the badge counts.
export * from "./badge-core";

const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;

// ADR 0069: the Gauntlet score badge, registered first so the tool badge route below never sees it.
site.get("/badge/score/:file", (c) => scoreBadgeResponse(c, c.req.param("file")));

site.get("/badge/:file{.+\\.(svg|json)}", async (c) => {
  const file = c.req.param("file");
  const json = file.endsWith(".json");
  let id: string;
  try {
    id = decodeURIComponent(file.replace(/\.(svg|json)$/, ""));
  } catch {
    return c.text("Not a valid tool id.", 400);
  }
  const v = c.req.query("v");
  if (v !== undefined && !VERSION.test(v)) return c.text("Not a valid version.", 400);
  const r = await toolBadge(c.env, id, v ?? null).catch(() => null);
  const headers = { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
  if (!r) return c.text(v ? `No counted reports for ${v} yet, so there's no badge for it.` : "No reports for this tool yet, so there's no badge. It appears once an agent reports.", 404, { "Cache-Control": "public, max-age=600" });
  if (json) return c.json({ schemaVersion: 1, label: r.badge.label, message: r.badge.message, color: r.badge.color.replace("#", "") }, 200, headers);
  return c.body(badgeSvg(r.badge), 200, { ...headers, "Content-Type": "image/svg+xml; charset=utf-8" });
});

