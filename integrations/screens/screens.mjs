// Screenshots of the live site, desktop and iPhone, for visual checks from places that can't reach it (cloud agent
// sessions). Run by .github/workflows/screens.yml; it writes PNGs and a summary (HTTP status, sideways scroll,
// browser errors) into <out dir>, plus the body of any JSON answer (an API check). Public pages only, no secrets.
//
//   PLAYWRIGHT_DIR=<dir with playwright installed> node screens.mjs <site> <out dir> [path ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PATHS = ["/", "/arena", "/wire", "/skill-watch", "/scan", "/trap-card", "/lab/3/results", "/check", "/stats"];
// A query string is allowed (for /api/v1/check?id=…&version=…), with the same plain characters.
const PATH_RE = /^\/[A-Za-z0-9/_.%:@-]*(\?[A-Za-z0-9_.%:@=&-]*)?$/;

/** A safe file name for a page: "/" is "home", "/lab/3/results" is "lab-3-results". */
export const shotName = (path) => (path === "/" ? "home" : path.replace(/^\//, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "")) || "home";

/** The page's address, tagged from=screens so our visit counts apart; API endpoints reject unknown keys, so not those. */
export const screenUrl = (site, path) => (path.startsWith("/api/") ? `${site}${path}` : `${site}${path}${path.includes("?") ? "&" : "?"}from=screens`);

/**
 * Browser settings for one view, tagged as our own probe (K7, apps/forge/src/services/internal.ts): the header goes
 * on every request the page makes, and a device's User-Agent (the iPhone view) gets the tag added at the end, so the
 * page looks the same. The desktop view keeps the browser's own User-Agent and is tagged by the header. The tag only
 * keeps these visits out of agent and visitor counts; it grants nothing.
 */
export const INTERNAL_TAG = "theagentforge-internal/screens";
export const INTERNAL_HEADERS = { "X-Forge-Internal": "screens" };
export function contextOptions(opts) {
  return { ...opts, ...(opts.userAgent ? { userAgent: `${opts.userAgent} ${INTERNAL_TAG}` } : {}), extraHTTPHeaders: { ...opts.extraHTTPHeaders, ...INTERNAL_HEADERS } };
}

export function validPaths(list) {
  return list.filter((p) => PATH_RE.test(p) && !p.includes("..")).slice(0, 20);
}

async function main() {
  const [siteArg, out, ...rest] = process.argv.slice(2);
  const site = (siteArg ?? "").replace(/\/$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) throw new Error("site must be https://<host>");
  const paths = validPaths(rest.length ? rest : DEFAULT_PATHS);
  const dir = process.env.PLAYWRIGHT_DIR;
  if (!dir) throw new Error("set PLAYWRIGHT_DIR");
  const pw = await import(pathToFileURL(createRequire(join(dir, "noop.js")).resolve("playwright")).href);
  const { chromium, devices } = pw.chromium ? pw : pw.default;
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const summary = [];
  const views = [
    ["desktop", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
    ["iphone", { ...devices["iPhone 15"], deviceScaleFactor: 2 }],
  ];
  try {
    for (const [view, opts] of views) {
      const ctx = await browser.newContext(contextOptions(opts));
      for (const path of paths) {
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
        const url = screenUrl(site, path);
        let status = 0;
        try {
          const res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
          status = res?.status() ?? 0;
          await page.waitForTimeout(2500);
          if (view === "desktop" && (res?.headers()["content-type"] ?? "").includes("json")) {
            writeFileSync(join(out, `${shotName(path)}.json`), (await res.text()).slice(0, 200_000));
          }
          const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
          const file = `${view}-${shotName(path)}.png`;
          await page.screenshot({ path: join(out, file), fullPage: true });
          summary.push({ view, path, status, sideways: sw > iw ? `${sw}px in ${iw}px` : null, errors, file });
        } catch (e) {
          summary.push({ view, path, status, error: String(e?.message ?? e).slice(0, 200), errors });
        }
        await page.close();
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(out, "summary.json"), `${JSON.stringify({ site, at: new Date().toISOString(), pages: summary }, null, 2)}\n`);
  console.log(summary.map((s) => `${s.view} ${s.path} ${s.status}${s.sideways ? ` sideways ${s.sideways}` : ""}${s.errors.length ? ` errors ${s.errors.length}` : ""}`).join("\n"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
