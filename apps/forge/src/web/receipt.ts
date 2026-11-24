import { checkIdProblem, textLike, urlProblem } from "@forge/shared";
import { visible } from "@forge/shared/skill-scan";
import { html } from "hono/html";
import { arenaLivePath, arenaQueryOf, readReceipt, receiptPath, type ReceiptPayload } from "../services/receipts";
import { getDb } from "../services/db";
import { scanByFingerprint, scanPath } from "../services/scans";
import { bump } from "../services/usage";
import { badgeSvg, type Badge } from "./badge";
import { isLikelyBot } from "../services/bots";
import { LONG_EDGE_CACHE, send, site } from "./pages";

// Forge receipt pages (services/receipts.ts): /r/<token> shows what the Forge answered and when, with the signature
// checked on every view; /r/<token>/badge.svg is the same as a small image. JSON for agents with ?format=json or an
// Accept: application/json header. A bad or tampered token is a 404, never a page.

const COLORS: Record<string, string> = { unchanged: "#2e9e6b", changed: "#c27c0e", observed: "#3d6fa8", not_observed: "#5b6573", not_monitored: "#5b6573", clear: "#2e9e6b", caution: "#c27c0e", flagged: "#c43c35", confirmed_malicious: "#c43c35", insufficient: "#5b6573", headline: "#3d6fa8", practice: "#5b6573", none: "#5b6573" };
const WORDS: Record<string, string> = {
  clear: "clear",
  caution: "caution",
  flagged: "flagged",
  confirmed_malicious: "malicious",
  insufficient: "no reports yet",
  no_match: "no advisory matched",
  no_flags: "nothing flagged",
  // Arena trap data and results: the answer's data_kind.
  headline: "ranked results",
  practice: "practice results",
  none: "no results yet",
  // Live drift monitor (ADR 0151).
  observed: "digests observed",
  unchanged: "pinned tools unchanged",
  changed: "changed tool text",
  not_observed: "not observed yet",
  not_monitored: "not monitored",
};
const LABEL: Record<ReceiptPayload["kind"], string> = { check: "forge check", scan: "forge scan", exposure: "forge exposure", watch: "forge watch", traps: "forge traps", results: "arena results", drift: "forge drift" };
const WHAT: Record<ReceiptPayload["kind"], string> = { check: "Tool check", scan: "Skill scan", exposure: "Exposure check", watch: "Installed-skill watch", traps: "Arena trap data", results: "Arena results", drift: "Live tool-definition digests" };
const isArena = (p: ReceiptPayload): p is ReceiptPayload & { kind: "traps" | "results" } => p.kind === "traps" || p.kind === "results";

/** "Hard tier · job refund-hard3 · event crucible-2-hard": an Arena receipt's query, in words. */
function arenaQueryText(p: ReceiptPayload) {
  const q = arenaQueryOf(p.subject);
  const tier = q.tier === "hard" ? "Hard tier" : q.tier === "normal" ? "Normal tier" : "every tier";
  return [tier, q.task ? `job ${q.task}` : null, q.event ? `event ${q.event}` : null, q.model ? `model ${q.model}` : null].filter(Boolean).join(" · ");
}
const day = (iso: string) => new Date(iso).toUTCString().slice(5, 16);
const word = (p: ReceiptPayload) => WORDS[p.verdict] ?? p.verdict;

export function receiptBadge(p: ReceiptPayload): Badge {
  const advisories = p.kind === "check" && p.verdict === "insufficient" && (p.advisories ?? 0) > 0 ? `${p.advisories} advisories` : word(p);
  return { label: LABEL[p.kind], message: `${advisories} · ${day(p.at)}`, color: COLORS[p.security === "caution" || p.security === "flagged" ? p.security : p.verdict] ?? COLORS.insufficient! };
}

/**
 * ADR 0157: how far a receipt's subject can be trusted, from the record itself. Check and drift receipts from 23 Nov
 * 2026 say what their subject is (services/receipts.ts subject_kind); older ones don't, and their subject may be any
 * text a caller typed, so it is "asked_unverified" and is shown only when it is a valid id.
 */
export type SubjectTrust = "tool_on_file" | "asked_sha256" | "fingerprint" | "asked_unverified" | "withheld" | "file_sha256" | "list_sha256" | "query";
const legacyDriftOk = (s: string) => (/^https:\/\//i.test(s) ? urlProblem(s) === null : /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(s) && s.length <= 200 && !textLike(s));
export function subjectTrust(p: ReceiptPayload): SubjectTrust {
  if (p.kind === "scan") return "file_sha256";
  if (p.kind === "exposure" || p.kind === "watch") return "list_sha256";
  if (isArena(p)) return "query";
  if (p.subject_kind === "tool") return "tool_on_file";
  if (p.subject_kind === "asked_sha256") return "asked_sha256";
  if (p.subject_kind === "fingerprint" && /^sha256:[0-9a-f]{64}$/.test(p.subject)) return "fingerprint";
  const ok = p.kind === "drift" ? legacyDriftOk(p.subject) : checkIdProblem(p.subject) === null;
  return ok ? "asked_unverified" : "withheld";
}

/** A scan receipt's source link, only when it is a plain URL (older receipts may hold any URL a caller gave). */
const safeSource = (p: ReceiptPayload) => (p.kind === "scan" && p.source && urlProblem(p.source, 2048) === null ? p.source : null);

/** The receipt as agents get it: a subject that isn't a valid id, or an odd source, is left out (ADR 0157). */
export function receiptForAgents(p: ReceiptPayload) {
  const trust = subjectTrust(p);
  return { ...p, ...(trust === "withheld" ? { subject: null } : {}), ...(p.kind === "scan" ? { source: safeSource(p) } : {}), subject_trust: trust };
}

/** The live page for the receipt's subject, so a reader can compare the answer then with the answer now; a list has none. */
function livePath(p: ReceiptPayload) {
  if (p.kind === "scan") return scanPath(p.subject);
  if (isArena(p)) return arenaLivePath(p.kind, arenaQueryOf(p.subject));
  if (p.kind === "exposure" || p.kind === "watch") return null;
  const trust = subjectTrust(p);
  if (trust !== "tool_on_file" && trust !== "asked_unverified") return null;
  if (p.kind === "drift") return `/api/drift/tool?server=${encodeURIComponent(p.subject)}`;
  return `/t/${encodeURIComponent(p.subject)}`;
}

/** How the page names a check or drift receipt's subject: a label and a short value, never a heading. */
function subjectRow(p: ReceiptPayload): { label: string; value: string; plain: string } {
  const trust = subjectTrust(p);
  const ver = p.version ? `@${p.version}` : "";
  if (trust === "tool_on_file") return { label: p.kind === "drift" ? "Server (monitored)" : "Tool (on file)", value: `${p.subject}${ver}`, plain: `${p.subject}${ver}` };
  if (trust === "fingerprint") return { label: "Fingerprint asked", value: p.subject, plain: "a file fingerprint" };
  if (trust === "asked_sha256") return { label: "Asked (not on file; the record holds only its sha256)", value: p.subject, plain: p.kind === "drift" ? "a server not monitored" : "a tool not on file" };
  if (trust === "asked_unverified") return { label: "Asked (unverified)", value: visible(`${p.subject}${ver}`, 120), plain: p.kind === "drift" ? "a server" : "a tool" };
  return { label: "Asked (unverified)", value: "not shown: not a valid tool id", plain: p.kind === "drift" ? "a server" : "a tool" };
}

const wantsJson = (accept: string | undefined, format: string | undefined) => format === "json" || (!!accept && accept.includes("application/json") && !accept.includes("text/html"));

site.get("/r/:token{[A-Za-z0-9_-]+\\.[0-9a-f]{64}}/badge.svg", async (c) => {
  const p = await readReceipt(c.env.REPORT_SIGNING_KEY, c.req.param("token"));
  if (!p) return c.text("Not a valid Forge receipt.", 404);
  // Counted in the site middleware (web/pages.ts), before the edge cache, people only (ADR 0124). A receipt never
  // changes, so the badge is immutable; the edge keeps it a week.
  return c.body(badgeSvg(receiptBadge(p)), 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": `${LONG_EDGE_CACHE}, immutable`, "X-Content-Type-Options": "nosniff" });
});

site.get("/r/:token{[A-Za-z0-9_-]+\\.[0-9a-f]{64}}", async (c) => {
  const token = c.req.param("token");
  const p = await readReceipt(c.env.REPORT_SIGNING_KEY, token);
  if (!p) return c.text("Not a valid Forge receipt: the link is incomplete or was changed.", 404);
  const origin = c.env.PUBLIC_ORIGIN;
  const json = wantsJson(c.req.header("Accept"), c.req.query("format"));
  // ADR 0124: bots aren't counted (the JSON twin with the agents' rule, the page with the people's).
  if (!isLikelyBot(c.req.raw, json ? "api" : "page")) c.executionCtx.waitUntil(bump(c.env, [json ? "receipt:json" : "receipt:view"]).catch(() => {}));
  if (json)
    return c.json({ data_kind: "forge_receipt", valid: true, signature_covers: "answer_at_time", receipt: receiptForAgents(p), live_url: livePath(p) ? `${origin}${livePath(p)}` : null, receipt_url: `${origin}${receiptPath(token)}` }, 200, { "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
  const what = WHAT[p.kind];
  const list = p.kind === "exposure" || p.kind === "watch";
  const arena = isArena(p);
  const source = safeSource(p);
  const row = p.kind === "check" || p.kind === "drift" ? subjectRow(p) : null;
  // ADR 0157: the words used in the title and description; a check or drift subject is named only when it is on file.
  const subject = p.kind === "scan" ? (source ?? "a skill file") : list ? `${p.items ?? 0} ${p.kind === "exposure" ? "packages" : "installed files"}` : arena ? arenaQueryText(p) : row!.plain;
  // A scan of pasted text, or a result not public yet, has no page: link to it only when it's public, so neither people
  // nor crawlers land on a 404 (Search Console, 26 Oct: 54 such scan links). The JSON above is unchanged.
  const scanRow = p.kind === "scan" ? await scanByFingerprint(getDb(c.env), p.subject).catch(() => null) : null;
  const live = p.kind === "scan" && !scanRow?.public ? null : livePath(p);
  return send(c, {
    title: arena ? `Forge receipt: ${what.toLowerCase()}, ${word(p)}` : `Forge receipt: ${what.toLowerCase()} ${word(p)}`,
    description: arena ? `${what} for ${subject} from The Agent Forge on ${day(p.at)}: ${word(p)}, ${p.attempts ?? 0} refereed attempts. Signed receipt.` : `${what} of ${subject} by The Agent Forge on ${day(p.at)}: ${word(p)}. Signed receipt.`,
    path: receiptPath(token),
    nav: p.kind === "scan" || p.kind === "watch" ? "scan" : arena ? "arena" : "check",
    // A receipt is a dated record for whoever reviews the agent's work, one URL per answer: reachable, not for search.
    noindexFollow: true,
    body: html`<p class="eyebrow">Forge receipt · ${what} · ${p.at.replace("T", " ").replace("Z", " UTC")}</p>
<h1 class="page-title">${word(p)[0]!.toUpperCase()}${word(p).slice(1)}</h1>
${p.kind === "scan" ? html`<p class="mono small">${source ? html`<a href="${source}" rel="nofollow ugc">${source.replace(/^https:\/\//, "")}</a>` : "pasted text (no public link)"}</p>` : row ? "" : html`<p class="mono small">${subject}</p>`}
<p><img src="${receiptPath(token)}/badge.svg" alt="Forge receipt badge" height="20"></p>
<dl class="small">
${row ? html`<dt>${row.label}</dt>${subjectTrust(p) === "asked_unverified" ? html`<dd class="mono receipt-subject" data-untrusted="asked id">${row.value}</dd>` : html`<dd class="mono receipt-subject">${row.value}</dd>`}` : ""}
${p.kind === "drift" ? html`<dt>Tools observed or pinned</dt><dd>${String(p.items ?? 0)}</dd><dt>Changed against the pins</dt><dd>${String(p.matched ?? 0)}</dd><dt>Observed at</dt><dd>${p.as_of ?? "not yet"}</dd>` : arena ? html`<dt>Query</dt><dd class="mono">${p.subject}</dd><dt>Data</dt><dd>${word(p)}${p.kind === "traps" ? " (how often models fell for each planted trap)" : " (passes, traps fallen for and knockouts per job and model)"}</dd><dt>Refereed attempts counted</dt><dd>${String(p.attempts ?? 0)}</dd><dt>Newest attempt</dt><dd>${p.as_of ?? "none"}</dd>` : list ? html`<dt>List</dt><dd class="mono">${p.subject}</dd><dt>${p.kind === "exposure" ? "Matched a published advisory" : "Flagged or caution"}</dt><dd>${String(p.matched ?? 0)} of ${String(p.items ?? 0)}</dd>` : p.kind === "scan" ? html`<dt>File</dt><dd class="mono">${p.subject}</dd><dt>Rules</dt><dd>${p.rules ?? ""} (<a href="/scan/rules">what they look for</a>)</dd>` : html`<dt>Security status</dt><dd>${p.security === "clear" && p.advisories_checked === false ? "not flagged" : String(p.security ?? "").replace(/_/g, " ")}</dd><dt>Published advisories matched</dt><dd>${p.advisories_checked === false ? "not checked (no advisory source for this tool)" : String(p.advisories ?? 0)}</dd>${p.corroborated ? html`<dt>Corroborated reports</dt><dd>${String(p.corroborated)} (confirmed by 2 or more other verified owners' agents)</dd>` : ""}`}
<dt>Signature</dt><dd>valid (checked just now): The Agent Forge's server key signed this record of the answer it gave on ${day(p.at)}. It covers that answer and its date; it doesn't vouch for the tool or for what was asked.</dd>
</dl>
<p>${arena ? "This receipt records what the Forge Arena's data said at that moment: new refereed runs change the figures." : "This receipt records what the Forge answered at that moment. It isn't a promise that the tool is safe: rules, reports and advisories change."} ${live ? html`<a class="btn chamfer" href="${live}">See the answer today</a>` : p.kind === "scan" ? html`This file has no public scan page. <a href="/scan">Scanning it again</a> gives today's answer.` : list ? "The list itself isn't in the link: asking again with the same list gives today's answer." : "Asking again gives today's answer."}</p>
<p class="small muted">Got this link from an agent? It's how agents show they checked a tool before installing it. <a href="/connect?from=receipt">Give your agent the same check</a> (free, no account).</p>`,
  });
});
