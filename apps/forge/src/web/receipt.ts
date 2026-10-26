import { html } from "hono/html";
import { readReceipt, receiptPath, type ReceiptPayload } from "../services/receipts";
import { scanPath } from "../services/scans";
import { bump } from "../services/usage";
import { badgeSvg, type Badge } from "./badge";
import { send, site } from "./pages";

// Forge receipt pages (services/receipts.ts): /r/<token> shows what the Forge answered and when, with the signature
// checked on every view; /r/<token>/badge.svg is the same as a small image. JSON for agents with ?format=json or an
// Accept: application/json header. A bad or tampered token is a 404, never a page.

const COLORS: Record<string, string> = { clear: "#2e9e6b", caution: "#c27c0e", flagged: "#c43c35", confirmed_malicious: "#c43c35", insufficient: "#5b6573" };
const WORDS: Record<string, string> = {
  clear: "clear",
  caution: "caution",
  flagged: "flagged",
  confirmed_malicious: "malicious",
  insufficient: "no reports yet",
  no_match: "no advisory matched",
  no_flags: "nothing flagged",
};
const LABEL: Record<ReceiptPayload["kind"], string> = { check: "forge check", scan: "forge scan", exposure: "forge exposure", watch: "forge watch" };
const WHAT: Record<ReceiptPayload["kind"], string> = { check: "Tool check", scan: "Skill scan", exposure: "Exposure check", watch: "Installed-skill watch" };
const day = (iso: string) => new Date(iso).toUTCString().slice(5, 16);
const word = (p: ReceiptPayload) => WORDS[p.verdict] ?? p.verdict;

export function receiptBadge(p: ReceiptPayload): Badge {
  const advisories = p.kind === "check" && p.verdict === "insufficient" && (p.advisories ?? 0) > 0 ? `${p.advisories} advisories` : word(p);
  return { label: LABEL[p.kind], message: `${advisories} · ${day(p.at)}`, color: COLORS[p.security === "caution" || p.security === "flagged" ? p.security : p.verdict] ?? COLORS.insufficient! };
}

/** The live page for the receipt's subject, so a reader can compare the answer then with the answer now; a list has none. */
function livePath(p: ReceiptPayload) {
  if (p.kind === "scan") return scanPath(p.subject);
  if (p.kind === "exposure" || p.kind === "watch") return null;
  return `/t/${encodeURIComponent(p.subject)}`;
}

const wantsJson = (accept: string | undefined, format: string | undefined) => format === "json" || (!!accept && accept.includes("application/json") && !accept.includes("text/html"));

site.get("/r/:token{[A-Za-z0-9_-]+\\.[0-9a-f]{64}}/badge.svg", async (c) => {
  const p = await readReceipt(c.env.REPORT_SIGNING_KEY, c.req.param("token"));
  if (!p) return c.text("Not a valid Forge receipt.", 404);
  c.executionCtx.waitUntil(bump(c.env, ["receipt:badge"]).catch(() => {}));
  return c.body(badgeSvg(receiptBadge(p)), 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400, immutable", "X-Content-Type-Options": "nosniff" });
});

site.get("/r/:token{[A-Za-z0-9_-]+\\.[0-9a-f]{64}}", async (c) => {
  const token = c.req.param("token");
  const p = await readReceipt(c.env.REPORT_SIGNING_KEY, token);
  if (!p) return c.text("Not a valid Forge receipt: the link is incomplete or was changed.", 404);
  const origin = c.env.PUBLIC_ORIGIN;
  const json = wantsJson(c.req.header("Accept"), c.req.query("format"));
  c.executionCtx.waitUntil(bump(c.env, [json ? "receipt:json" : "receipt:view"]).catch(() => {}));
  if (json)
    return c.json({ data_kind: "forge_receipt", valid: true, receipt: p, live_url: livePath(p) ? `${origin}${livePath(p)}` : null, receipt_url: `${origin}${receiptPath(token)}` }, 200, { "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
  const what = WHAT[p.kind];
  const list = p.kind === "exposure" || p.kind === "watch";
  const subject = p.kind === "scan" ? (p.source ?? p.subject) : list ? `${p.items ?? 0} ${p.kind === "exposure" ? "packages" : "installed files"}` : `${p.subject}${p.version ? `@${p.version}` : ""}`;
  const live = livePath(p);
  return send(c, {
    title: `Forge receipt: ${what.toLowerCase()} ${word(p)}`,
    description: `${what} of ${subject} by The Agent Forge on ${day(p.at)}: ${word(p)}. Signed receipt.`,
    path: receiptPath(token),
    nav: p.kind === "scan" || p.kind === "watch" ? "scan" : "check",
    body: html`<p class="eyebrow">Forge receipt · ${what} · ${p.at.replace("T", " ").replace("Z", " UTC")}</p>
<h1 class="page-title">${word(p)[0]!.toUpperCase()}${word(p).slice(1)}</h1>
<p class="mono small">${p.kind === "scan" && p.source ? html`<a href="${p.source}" rel="nofollow ugc">${p.source.replace(/^https:\/\//, "")}</a>` : subject}</p>
<p><img src="${receiptPath(token)}/badge.svg" alt="Forge receipt badge" height="20"></p>
<dl class="small">
${list ? html`<dt>List</dt><dd class="mono">${p.subject}</dd><dt>${p.kind === "exposure" ? "Matched a published advisory" : "Flagged or caution"}</dt><dd>${String(p.matched ?? 0)} of ${String(p.items ?? 0)}</dd>` : p.kind === "scan" ? html`<dt>File</dt><dd class="mono">${p.subject}</dd><dt>Rules</dt><dd>${p.rules ?? ""} (<a href="/scan/rules">what they look for</a>)</dd>` : html`<dt>Security status</dt><dd>${p.security ?? ""}</dd><dt>Published advisories matched</dt><dd>${String(p.advisories ?? 0)}</dd>${p.corroborated ? html`<dt>Corroborated reports</dt><dd>${String(p.corroborated)} (confirmed by 2 or more other verified owners' agents)</dd>` : ""}`}
<dt>Signature</dt><dd>valid: signed by The Agent Forge's server key and checked just now</dd>
</dl>
<p>This receipt records what the Forge answered at that moment. It isn't a promise that the tool is safe: rules, reports and advisories change. ${live ? html`<a class="btn chamfer" href="${live}">See the answer today</a>` : "The list itself isn't in the link: asking again with the same list gives today's answer."}</p>
<p class="small muted">Got this link from an agent? It's how agents show they checked a tool before installing it. <a href="/connect?from=receipt">Give your agent the same check</a> (free, no account).</p>`,
  });
});
