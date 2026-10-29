import skillMd from "../../public/skill.md";
import { rightOfReply } from "./right-of-reply";
import { maintainerResponse } from "./maintainer-response";
import { SCAN_MAX_BYTES, SCAN_RULES, SCAN_RULES_VERSION, scanFingerprint, scanSummary, type ScanFinding, type ScanSeverity } from "@forge/shared";
import { html } from "hono/html";
import { reached } from "../services/counters";
import { getDb } from "../services/db";
import { clawhubPage, fetchSkillText, latestBySource, rawUrl, recentPublic, ruleFrequency, scanAndRecord, scanByFingerprint, scanPath, scanStats, skillLabel } from "../services/scans";
import { recordMiss, scanMissLabel } from "../services/misses";
import { bulkSummary, pct, type BulkSummary } from "../services/bulk-scan";
import { recordBadgeReferrer } from "../services/growth";
import { bump, scanCounters } from "../services/usage";
import { internalCaller, internalKey } from "../services/internal";

/** ADR 0067: a web scan by one of our tagged callers counts apart (internal:<component>:scans), never as outside use. */
export const webScanKeys = (headers: Pick<Headers, "get">, verdict: string, from: string[]) => {
  const ours = internalCaller(headers);
  return ours ? [internalKey(ours, "scans")] : [...scanCounters("web", verdict), ...from];
};
import { AGENT_LINE } from "./agent-line";
import { patternPhrase } from "./scan-words";
import { badgeSvg } from "./badge";
import { copyBlock } from "./components";
import { answerId, answerPath, latestFingerprintFor } from "./answers";
import { notFound, send, site, WEBMCP_SCRIPT } from "./pages";

// Skill scan pages (ADR 0026): paste or link a skill and see what it asks an agent to do; a shareable page per
// public result; the rules; and Skill Watch, the public feed of flagged skills. Wording: "matches pattern X at line
// N", never "malicious". Excerpts are shown to people only (agents get rule ids and lines; services/scans.ts).

/** The skill-scan GitHub Action, published at theagentforge/skill-scan (20 Oct; also in forge-check's skill-scan/ folder). */
export const SKILL_SCAN_ACTION_LIVE = true;

const SEV_LABEL: Record<ScanSeverity, string> = { high: "High", medium: "Medium", low: "Low" };
// Words, not the API enum: "Flagged" means three verified people on the Watchlist, so a scanner match says what it is.
const verdictWord = { flagged: "High-risk pattern", caution: "Medium-risk pattern", clear: "No known risky patterns" } as const;
const FLAG_NOTE = `"Flagged" here means the scanner matched a high-risk text pattern; it is not a Watchlist flag, which needs three verified people.`;
const vClass = { flagged: "flagged", caution: "caution", clear: "clear" } as const;

/** The sentence people share from a result page, with the page link tagged by where it's shared. */
export function shareLine(verdict: "flagged" | "caution" | "clear", findings: ScanFinding[], url: string) {
  const what = patternPhrase(findings);
  if (verdict === "flagged") return `This skill ${what}: a high-risk pattern, not proof of malice. Read the line before your agent installs it: ${url}`;
  if (verdict === "caution") return `Checked a skill before my agent installed it. It ${what}, so I read those lines first: ${url}`;
  return `Checked a skill before my agent installed it: no known risky patterns. Free scan, no account: ${url}`;
}

/** The two ways in, for anyone who lands on a result: scan their own, or give their agent the one line. */
function checkYours(origin: string, from: string) {
  return html`<section class="check-yours panel chamfer panel-body" aria-labelledby="check-yours">
<h2 id="check-yours">Check your own skills</h2>
<form class="scan-quick" method="post" action="/scan?from=${from}"><label class="sr-only" for="yours-url">Link to a skill file</label><input id="yours-url" name="url" type="url" inputmode="url" placeholder="Paste a ClawHub or GitHub link to a skill" maxlength="2048" required><button class="btn primary chamfer" type="submit">Scan it</button></form>
<p>Or paste this into your agent once. It then checks every skill before installing it:</p>
<div class="copy-wrap">${copyBlock(`agent-line-${from}`, AGENT_LINE(origin))}</div>
<p class="small muted">Free, no account. <a href="/skill.md">Read the skill file first</a>.</p>
</section>`;
}

function shareButtons(text: string, url: string) {
  const enc = encodeURIComponent;
  return html`<p class="share-buttons small"><button type="button" class="btn primary chamfer" data-native-share data-share-text="${text}" data-share-url="${url}" hidden>Share…</button> <a class="btn chamfer" href="https://x.com/intent/post?text=${enc(text)}" target="_blank" rel="noopener">Post on X</a> <a class="btn chamfer" href="https://bsky.app/intent/compose?text=${enc(text)}" target="_blank" rel="noopener">Bluesky</a> <a class="btn chamfer" href="https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}" target="_blank" rel="noopener">LinkedIn</a></p>`;
}

function scanForm(prefill: { url?: string; text?: string } = {}) {
  return html`<form class="scan-form" method="post" action="/scan">
<label for="scan-url">Link to the skill <span class="muted small">(a ClawHub page, or the file on GitHub, GitLab, Gist, Codeberg, unpkg or jsDelivr)</span></label>
<input id="scan-url" name="url" type="url" inputmode="url" placeholder="https://github.com/owner/repo/blob/main/SKILL.md" value="${prefill.url ?? ""}" maxlength="2048">
<label for="scan-text">…or paste its text</label>
<textarea id="scan-text" name="text" rows="8" maxlength="${SCAN_MAX_BYTES}" placeholder="Paste SKILL.md, an MCP server's tool descriptions, or an install script">${prefill.text ?? ""}</textarea>
<button class="btn primary chamfer" type="submit">Scan it</button>
<p class="small muted">Free, no account. We keep the findings, never the text you paste.</p>
</form>`;
}

function findingsTable(findings: ScanFinding[]) {
  if (!findings.length) return html`<p class="muted">Nothing matched any of the ${SCAN_RULES.length} rules.</p>`;
  return html`<table class="table stack"><thead><tr><th>Severity</th><th>Pattern</th><th class="num">Line</th><th>What it says</th></tr></thead><tbody>${findings.map(
    (f) => html`<tr><td data-label="Severity"><span class="sev sev-${f.severity}">${SEV_LABEL[f.severity]}</span></td><td><b>${f.title}</b> <a class="mono small" href="/scan/rules#${f.rule}">${f.rule}</a><br><span class="small muted">${f.why}</span></td><td class="num" data-label="Line">${f.line}</td><td data-label="Excerpt"><code class="excerpt">${f.evidence}</code></td></tr>`,
  )}</tbody></table>`;
}

function resultBlock(r: { verdict: "flagged" | "caution" | "clear"; counts: Record<ScanSeverity, number>; findings: ScanFinding[]; fingerprint: string; rules_version?: string; rulesVersion?: string }, extra: unknown = "") {
  return html`<section class="panel chamfer panel-body scan-result v-${vClass[r.verdict]}" aria-live="polite">
<p class="eyebrow">Skill scan · rules ${r.rules_version ?? r.rulesVersion}</p>
<h2 class="scan-verdict">${verdictWord[r.verdict]}</h2>
<p class="lead">${scanSummary(r)}</p>
${findingsTable(r.findings)}
<p class="small muted mono">${r.fingerprint}</p>
${r.verdict === "flagged" ? html`<p class="small muted">${FLAG_NOTE}</p>` : ""}
${extra}
</section>`;
}

site.get("/scan", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const stats = await scanStats(getDb(c.env)).catch(() => null);
  const ownFp = await scanFingerprint(skillMd);
  return send(c, {
    title: "Scan a skill before your agent installs it",
    description: "Free: paste or link an agent skill, plugin or MCP server and see the hidden instructions, piped installs and credential reads that virus scanners miss.",
    path: "/scan",
    nav: "scan",
    modules: [WEBMCP_SCRIPT],
    body: html`<p class="eyebrow">Free · no account · ${SCAN_RULES.length} rules</p>
<h1 class="page-title">Scan a skill before your agent installs it.</h1>
<p class="lead">Skills are text your agent obeys. We check it for what virus scanners miss: hidden instructions, downloads piped into a shell, key reads, and data sent to throwaway servers.</p>
${scanForm()}
<section><h2>Let your agent check for itself</h2><p>Paste this into your agent once. It then checks each skill before installing it, and rechecks installed ones weekly: one small request.</p>${copyBlock("agent-line", AGENT_LINE(origin))}
<p class="small muted">The <a href="/skill.md">skill file</a> is plain text: read it first. Fingerprint: <span class="mono">${ownFp}</span>. It passes this scanner and never tells your agent to fetch and follow anything.</p></section>
${SKILL_SCAN_ACTION_LIVE ? html`<section><h2>In every pull request</h2><p>The free <a href="https://github.com/theagentforge/skill-scan">skill-scan GitHub Action</a> runs the same rules on each pull request: one short comment, with notes on flagged lines. No file leaves GitHub.</p>${copyBlock("action-yaml", "- uses: theagentforge/skill-scan@v1")}</section>` : ""}
${stats ? html`<p class="small muted">${reached("skills_scanned", stats.unique) ? html`${stats.unique.toLocaleString("en-US")} skill files scanned so far, our launch and bulk scans included (<a href="/stats/rules#skills_scanned">how it's counted</a>) · ` : ""}<a href="/skill-watch">Skill Watch</a> · <a href="/scan/rules">The rules</a></p>` : ""}`,
  });
});

site.post("/scan", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `scan:${ip}` });
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const url = typeof form.url === "string" ? form.url.trim() : "";
  const pasted = typeof form.text === "string" ? form.text : "";
  // Which form the scan came from (report boxes, home), counted alongside the scan; internal only.
  const from = typeof form.from === "string" && /^[a-z0-9-]{1,32}$/.test(form.from) ? [`scan:from:${form.from}`] : [];
  let body: unknown;
  if (!success) body = html`<p class="notice warn">Too many scans from your connection. Try again in a minute.</p>`;
  else if (pasted.trim()) {
    const { result, isPublic } = await scanAndRecord(c.env, pasted.slice(0, SCAN_MAX_BYTES));
    c.executionCtx.waitUntil(bump(c.env, webScanKeys(c.req.raw.headers, result.verdict, from)).catch(() => {}));
    body = resultBlock(result, isPublic ? html`<p><a class="btn chamfer" href="${scanPath(result.fingerprint)}">Share this result</a></p>` : html`<p class="small muted">Pasted text that isn't flagged gets no public page.</p>`);
  } else if (url) {
    const got = await fetchSkillText(url);
    if (!got.ok) c.executionCtx.waitUntil(recordMiss(c.env, "scan", scanMissLabel(url, got.error), { userAgent: c.req.header("User-Agent") }));
    if (!got.ok)
      body = html`<p class="notice warn">${got.error === "unsupported_url" ? "We can't read that link. Use a ClawHub skill page, a GitHub link (file, folder or repository), a GitLab, Gist, Codeberg, unpkg or jsDelivr link to the file, or paste the text." : got.error === "not_found" ? "No SKILL.md at that link. If the repository keeps skills in folders, paste the link to the skill's folder on GitHub. For ClawHub, use the skill's page (clawhub.ai/owner/skills/name)." : got.error === "too_large" ? "That file is over 256 KB." : "We couldn't fetch that file. Check the link is public."}</p>`;
    else {
      const { result, isPublic } = await scanAndRecord(c.env, got.text, { sourceUrl: got.url });
      c.executionCtx.waitUntil(bump(c.env, webScanKeys(c.req.raw.headers, result.verdict, from)).catch(() => {}));
      body = resultBlock(result, isPublic ? html`<p><a class="btn chamfer" href="${scanPath(result.fingerprint)}">Share this result</a></p>` : "");
    }
  } else body = html`<p class="notice warn">Give a link or paste the text.</p>`;
  return scanResultPage(c, body, url);
});

/** The result page for a scan that has no public page to send people to (POST /scan, and /go for a held file). */
const scanResultPage = (c: Parameters<typeof send>[0], body: unknown, url: string) =>
  send(
    c,
    {
      title: "Skill scan result",
      description: "A free skill scan from The Agent Forge.",
      path: "/scan",
      nav: "scan",
      modules: [WEBMCP_SCRIPT],
      noindex: true,
      body: html`<h1 class="page-title">Skill scan</h1>${body}${scanForm({ url })}`,
    },
    { cache: false },
  );

/** The agent skill file, served from static assets; the Worker sees it first only to count fetches (pages.ts). */
// CORS-open like the other discovery files, so a browser-based agent on another site can read them too.
const openAsset = async (c: { env: Env; req: { url: string; raw: Request } }, path: string) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL(path, c.req.url), { headers: c.req.raw.headers }));
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, headers });
};
site.get("/skill.md", (c) => openAsset(c, "/skill.md"));
site.get("/llms.txt", (c) => openAsset(c, "/llms.txt"));

site.get("/scan/rules", (c) =>
  send(c, {
    title: "Skill scan rules",
    description: `The ${SCAN_RULES.length} patterns the Forge's free skill scanner looks for, with why each matters.`,
    path: "/scan/rules",
    nav: "scan",
    body: html`<h1 class="page-title">The rules</h1>
<p class="lead">Rules version ${SCAN_RULES_VERSION}. Each rule is a text pattern from published attacks on agents and their skills. A match means "look at this line", not "this is malicious": security tools quote these patterns on purpose. People decide.</p>
<table class="table stack"><thead><tr><th>Rule</th><th>Severity</th><th>Pattern</th><th>Why it matters</th></tr></thead><tbody>${SCAN_RULES.map(
      (x) => html`<tr id="${x.id}"><td class="mono">${x.id}</td><td data-label="Severity"><span class="sev sev-${x.severity}">${SEV_LABEL[x.severity]}</span></td><td>${x.title}</td><td class="small muted">${x.why}</td></tr>`,
    )}</tbody></table>
<p class="small muted">High-risk pattern: at least one high-severity match. Medium-risk pattern: medium matches only. The scanner reads text and runs nothing, so it can miss attacks that only show when code runs. A false match, or a pattern we miss? <a href="mailto:hello@theagentforge.io?subject=Scan%20rule">Tell us</a>.</p>`,
  }),
);

site.get("/scan/:hex{[0-9a-f]{64}}", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const db = getDb(c.env);
  const row = await scanByFingerprint(db, `sha256:${c.req.param("hex")}`);
  // One answer for unknown and private fingerprints alike, so the page never reveals that a private scan exists. Not
  // 410: nothing public was deleted. Pasted-text results never get a page, and results held during a disclosure window
  // (services/skill-seed.ts) are not public yet (ADR 0060).
  if (!row || !row.public)
    return notFound(c, "No public scan at this address", "There is no public scan page for this fingerprint. Most scans of pasted text stay private, and some results are held back for a while as their maintainers hear from us. Scan the file yourself to see today's result.");
  // A clear result for a GitHub skill says the same as the skill's answer page (ADR 0060): the newest one points search
  // engines there (canonical), and an older clear version stays reachable but out of search. Pages with a matched
  // pattern quote the lines and stay their own.
  const id = row.verdict === "clear" ? answerId(row.sourceUrl) : null;
  const latest = id ? await latestFingerprintFor(db, id) : null;
  // No newest found (the answer page couldn't read this skill's rows): leave the page as its own canonical rather than
  // take the only indexable copy out of search.
  const consolidate = id && latest ? (latest === row.fingerprint ? { canonicalPath: answerPath(id) } : { noindexFollow: true }) : {};
  const findings = row.findings as ScanFinding[];
  const page = `${origin}${scanPath(row.fingerprint)}`;
  const label = skillLabel(row.sourceUrl, row.name);
  const claw = clawhubPage(row.sourceUrl);
  const named = label.where ? `${label.title} · ${label.where}` : label.title;
  return send(c, {
    title: `${verdictWord[row.verdict]}: ${named}`,
    description: `${row.verdict === "clear" ? "No known risky patterns." : `This skill ${patternPhrase(findings)}.`} ${scanSummary({ verdict: row.verdict, counts: row.counts as Record<ScanSeverity, number> })} Free skill scan by The Agent Forge.`,
    path: scanPath(row.fingerprint),
    image: `/og/scan/${row.fingerprint.replace("sha256:", "")}.png`,
    nav: "scan",
    ...consolidate,
    body: html`<p class="eyebrow">Skill scan · first seen ${new Date(row.firstSeen).toISOString().slice(0, 10)} · scanned ${row.scans} ${row.scans === 1 ? "time" : "times"}</p>
<h1 class="page-title">${label.title}${label.where ? html` <span class="muted title-where">· ${label.where}</span>` : ""}</h1>
${claw
      ? html`<p class="small source-link"><a href="${claw.page}" rel="nofollow ugc">${claw.page.replace(/^https:\/\//, "")}</a> · <a href="${claw.audit}" rel="nofollow">ClawHub's own security audit</a>. This scan is an independent second opinion, not ClawHub's.</p>`
      : row.sourceUrl
        ? html`<p class="small mono source-link"><a href="${row.sourceUrl}" rel="nofollow ugc">${row.sourceUrl.replace(/^https:\/\//, "")}</a></p>`
        : ""}
${resultBlock({ verdict: row.verdict, counts: row.counts as Record<ScanSeverity, number>, findings, fingerprint: row.fingerprint, rulesVersion: row.rulesVersion })}
${maintainerResponse(row)}
${rightOfReply(row)}
<section><h2>Share</h2><div class="copy-wrap">${copyBlock("share-line", shareLine(row.verdict, findings, `${page}?from=share`))}</div>
${shareButtons(shareLine(row.verdict, findings, `${page}?from=share-x`), `${page}?from=share-li`)}
${row.sourceUrl && row.verdict === "clear" ? html`<p>Your skill? Add this badge to its README. It shows the latest scan of this file:</p><div class="copy-wrap">${copyBlock("badge-md", `[![Forge scan](${origin}/scan/badge.svg?url=${encodeURIComponent(row.sourceUrl)})](${page})`)}</div>` : ""}
${row.sourceUrl && row.verdict !== "clear" ? html`<form method="post" action="/scan?from=rescan"><input type="hidden" name="url" value="${row.sourceUrl.replace(/\/[0-9a-f]{40}\//, "/HEAD/")}"><p>Your skill? Change it, then <button class="btn chamfer" type="submit">Scan the latest version</button>. The new version gets its own page.</p></form>` : ""}</section>
<p class="small muted">This page shows text patterns in one exact version of the file (fingerprint above), not a judgement of its author. Publisher? <a href="mailto:disputes@theagentforge.io?subject=Scan%20${row.fingerprint.slice(7, 19)}">Reply or dispute</a>, and we add your reply here.</p>
${id ? html`<p class="small">Every scanned version of this skill, with field reports: <a href="${answerPath(id)}">Is ${label.title} safe to install?</a></p>` : ""}
${checkYours(origin, "result")}`,
  });
});

site.get("/skill-watch", async (c) => {
  const db = getDb(c.env);
  const [stats, flagged, bulk] = await Promise.all([scanStats(db), recentPublic(db, ["flagged", "caution"], 60), bulkSummary(c.env).catch(() => null)]);
  const freq = ruleFrequency(flagged).slice(0, 8);
  const rule = (id: string) => SCAN_RULES.find((x) => x.id === id);
  if (c.req.query("format") === "json")
    return c.json({ rules_version: SCAN_RULES_VERSION, stats, rule_frequency: freq.map(([id, n]) => ({ rule: id, skills: n })), bulk_scan: bulk ? { ...bulk, rules_url: `${c.env.PUBLIC_ORIGIN}/scan/rules`, counting_rule_url: `${c.env.PUBLIC_ORIGIN}/skill-watch#bulk-scan` } : null, recent: flagged.map((r) => ({ fingerprint: r.fingerprint, verdict: r.verdict, source_url: r.sourceUrl, counts: r.counts, first_seen: new Date(r.firstSeen).toISOString(), page_url: `${c.env.PUBLIC_ORIGIN}${scanPath(r.fingerprint)}` })) });
  return send(c, {
    title: "Skill Watch",
    description: "Agent skills that matched risky patterns in the Forge's free scanner, newest first, with every flagged line.",
    path: "/skill-watch",
    nav: "skillwatch",
    jsonAlternate: "/skill-watch?format=json",
    body: html`<p class="eyebrow">Skill Watch · rules ${SCAN_RULES_VERSION}</p>
<h1 class="page-title">What skills tell agents to do</h1>
<p class="lead">Public skills that matched a risky pattern, newest first. Each links to the exact lines. A match is a reason to read, not a verdict on the author.</p>
<p><a class="btn primary chamfer" href="#check-yours">Scan your skill</a></p>
${reached("skills_scanned", stats.unique) ? html`<ul class="stat-row"><li><b>${stats.unique.toLocaleString("en-US")}</b> skill files scanned, our launch and bulk scans included</li><li><b>${stats.flagged.toLocaleString("en-US")}</b> with a high-risk pattern</li><li><b>${stats.caution.toLocaleString("en-US")}</b> with a medium-risk pattern</li></ul>` : ""}
${reached("skills_scanned", stats.unique) ? html`<p class="small muted">Counts include security courses and scanner tests, which quote attacks on purpose, and results held back while we contact maintainers. The <a href="/reports/skill-scan-2026-10?from=skill-watch">launch report</a> separates them: 30 of 9,014 ordinary skills matched a high-risk pattern.</p>` : ""}
<p class="small muted">${FLAG_NOTE}</p>
${bulk ? bulkSection(bulk) : ""}
${freq.length ? html`<section><h2>Most common patterns</h2><table class="table"><thead><tr><th>Pattern</th><th class="num">Skills</th></tr></thead><tbody>${freq.map(([id, n]) => html`<tr><td><a href="/scan/rules#${id}">${rule(id)?.title ?? id}</a></td><td class="num">${n}</td></tr>`)}</tbody></table></section>` : ""}
<section><h2>Newest</h2>${
      flagged.length
        ? html`<table class="table stack"><thead><tr><th>Verdict</th><th>Skill</th><th>Top pattern</th><th class="num">Seen</th></tr></thead><tbody>${flagged.map((r) => {
            const top = (r.findings as ScanFinding[])[0];
            return html`<tr><td><span class="verdict v-${vClass[r.verdict]} chamfer">${verdictWord[r.verdict]}</span></td><td class="wide">${(() => {
              const l = skillLabel(r.sourceUrl, r.name);
              return html`<a href="${scanPath(r.fingerprint)}"><b>${l.title}</b></a>${l.where ? html` <span class="small muted mono">${l.where}</span>` : ""}`;
            })()}</td><td data-label="Top pattern">${top?.title ?? "—"}</td><td class="num" data-label="Seen">${new Date(r.lastSeen).toISOString().slice(0, 10)}</td></tr>`;
          })}</tbody></table>`
        : html`<p class="empty">No high-risk patterns yet. <a href="/scan">Scan a skill</a>.</p>`
    }</section>
<p class="small muted"><a href="/scan">Scan a skill</a> · <a href="/scan/rules">The rules</a> · <a href="/skill-watch.atom">Follow (Atom feed)</a> · <a href="/skill-watch?format=json">JSON</a></p>
${checkYours(c.env.PUBLIC_ORIGIN, "skill-watch")}`,
  });
});

/**
 * The bulk scan's rates (B3-11, ADR 0107; run by the Worker's cron since ADR 0112): counts only, no names. A match is a
 * pattern, never called malicious; files that matched one get no page from the bulk scan.
 */
export function bulkSection(b: BulkSummary) {
  const n = (x: number) => x.toLocaleString("en-US");
  return html`<section id="bulk-scan"><h2>Every public skill we can reach</h2>
<p>Each week we read every public SKILL.md we can lawfully reach (ClawHub's public catalogue and public GitHub skill repositories) and run the same rules on it. We read the files; we never run them. So far: <b>${n(b.files)}</b> distinct files.</p>
<ul class="stat-row"><li><b>${pct(b.high_rate)}</b> matched a high-risk pattern (${n(b.high_pattern)} files)</li><li><b>${pct(b.medium_rate)}</b> matched only medium-risk patterns (${n(b.medium_pattern_only)})</li><li><b>${n(b.no_pattern)}</b> matched no known pattern</li></ul>
${b.sources.length ? html`<table class="table stack"><thead><tr><th>Source</th><th class="num">Files</th><th class="num">High-risk pattern</th><th class="num">Medium only</th></tr></thead><tbody>${b.sources.map((s) => html`<tr><td>${s.label}</td><td class="num" data-label="Files">${n(s.files)}</td><td class="num" data-label="High-risk pattern">${pct(s.high_rate)}</td><td class="num" data-label="Medium only">${pct(s.medium_rate)}</td></tr>`)}</tbody></table>` : ""}
${b.families.length ? html`<table class="table stack"><thead><tr><th>Kind of pattern</th><th class="num">Files with a high-risk match</th><th class="num">Share of all files</th><th class="num">Medium-risk matches</th></tr></thead><tbody>${b.families.map((f) => html`<tr><td>${f.label}</td><td class="num" data-label="High-risk">${n(f.files_high)}</td><td class="num" data-label="Share">${pct(f.high_rate)}</td><td class="num" data-label="Medium">${n(f.files_medium)}</td></tr>`)}</tbody></table>` : ""}
<p class="small muted">How it's counted: distinct files by sha256 fingerprint (so each version of a skill is its own file), each counted once, under the bulk source that first read it. A pattern match is a reason to read the line, not proof of malice. Nobody has read these matches by hand yet, and they include security courses and examples that quote attacks on purpose. The bulk scan gives no public page to a file that matched a pattern (one appears only if someone scans that link here, like any link scan); files with no match get a page. ClawHub files are labelled by skill name only, because ClawHub's file API doesn't say which publisher's file it returned. Numbers as of ${b.as_of.slice(0, 10)}.</p>
</section>`;
}

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);

/** Skill Watch as an Atom feed, for researchers and press who follow it in a reader. Flagged results only. */
site.get("/skill-watch.atom", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const rows = await recentPublic(getDb(c.env), ["flagged"], 30);
  const updated = new Date(rows[0]?.lastSeen ?? Date.UTC(2026, 9, 19)).toISOString();
  const entries = rows.map((r) => {
    const l = skillLabel(r.sourceUrl, r.name);
    const url = `${origin}${scanPath(r.fingerprint)}`;
    return `<entry><id>${url}</id><title>${xmlEsc(`High-risk pattern: ${l.title}${l.where ? ` (${l.where})` : ""}`)}</title><link href="${xmlEsc(`${url}?from=atom`)}"/><updated>${new Date(r.lastSeen).toISOString()}</updated><summary>${xmlEsc(`This skill ${patternPhrase(r.findings as ScanFinding[])}. A match is a reason to read the line, not a verdict on the author.`)}</summary></entry>`;
  });
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${origin}/skill-watch</id><title>Skill Watch: The Agent Forge</title><subtitle>Agent skills that matched a high-risk pattern in the Forge's free scanner.</subtitle><link href="${origin}/skill-watch"/><link rel="self" href="${origin}/skill-watch.atom"/><updated>${updated}</updated><author><name>The Agent Forge</name></author>${entries.join("")}</feed>`;
  return c.body(xml, 200, { "Content-Type": "application/atom+xml; charset=utf-8", "Cache-Control": "public, max-age=900" });
});

/**
 * README badge for skill authors (ADR 0026): the latest scan of a public file by its URL. Only served once that URL
 * has been scanned, so a badge never triggers a fetch and never shows a guess. Links back to the result page.
 */
site.get("/scan/badge.svg", async (c) => {
  const u = rawUrl(c.req.query("url") ?? "");
  c.executionCtx.waitUntil(recordBadgeReferrer(c.env, c.req.header("Referer")).catch(() => {}));
  const row = u ? await latestBySource(getDb(c.env), u.toString()) : null;
  const b = !row
    ? { label: "forge scan", message: "not scanned yet", color: "#5b6573" }
    : row.verdict === "flagged"
      ? { label: "forge scan", message: "flagged", color: "#c43c35" }
      : row.verdict === "caution"
        ? { label: "forge scan", message: "caution", color: "#c27c0e" }
        : { label: "forge scan", message: "no risky patterns", color: "#2e9e6b" };
  return c.body(badgeSvg(b), 200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
});

/** Links that point at a skill file (or a page that holds one), which the one box on the home page scans. */
export function looksLikeSkillLink(q: string) {
  if (!/^https?:\/\//i.test(q)) return false;
  let u: URL;
  try {
    u = new URL(q);
  } catch {
    return false;
  }
  return u.hostname === "clawhub.ai" || u.hostname.endsWith(".clawhub.ai") || u.hostname === "gist.github.com" || /\.md$/i.test(u.pathname) || /\/skills?\//i.test(u.pathname);
}

/**
 * The one box (conversion review, 24 Oct): paste anything. A link to a skill file is fetched and scanned, and the
 * result page opens; anything else (npm:…, pypi:…, a GitHub repository, a bare name) opens the check page. POST only,
 * so crawlers following links never trigger a scan.
 */
site.post("/go", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const q = (typeof form.q === "string" ? form.q : "").trim().slice(0, 2048);
  const from = typeof form.from === "string" && /^[a-z0-9-]{1,32}$/.test(form.from) ? form.from : "go";
  if (!q) return c.redirect("/scan", 303);
  c.executionCtx.waitUntil(bump(c.env, [`go:${looksLikeSkillLink(q) ? "scan" : "check"}`, `go:from:${from}`]).catch(() => {}));
  if (looksLikeSkillLink(q)) {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.CHECK_LIMITER.limit({ key: `scan:${ip}` });
    const got = success ? await fetchSkillText(q) : null;
    if (got?.ok) {
      const { result, isPublic } = await scanAndRecord(c.env, got.text, { sourceUrl: got.url });
      c.executionCtx.waitUntil(bump(c.env, webScanKeys(c.req.raw.headers, result.verdict, [`scan:from:${from}`])).catch(() => {}));
      if (isPublic) return c.redirect(`${scanPath(result.fingerprint)}?from=${from}`, 303);
      // A file held during a disclosure window has no page yet: show the asker the result here.
      return scanResultPage(c, resultBlock(result, ""), q);
    }
  }
  return c.redirect(`/check?q=${encodeURIComponent(q.slice(0, 512))}&from=${from}`, 303);
});
