import skillMd from "../../public/skill.md";
import { SCAN_MAX_BYTES, SCAN_RULES, SCAN_RULES_VERSION, scanFingerprint, scanSummary, type ScanFinding, type ScanSeverity } from "@forge/shared";
import { html } from "hono/html";
import { reached } from "../services/counters";
import { getDb } from "../services/db";
import { clawhubPage, fetchSkillText, latestBySource, rawUrl, recentPublic, ruleFrequency, scanAndRecord, scanByFingerprint, scanPath, scanStats, skillLabel } from "../services/scans";
import { recordBadgeReferrer } from "../services/growth";
import { bump, scanCounters } from "../services/usage";
import { AGENT_LINE } from "./agent-line";
import { patternPhrase } from "./scan-words";
import { badgeSvg } from "./badge";
import { copyBlock } from "./components";
import { send, site } from "./pages";

// Skill scan pages (ADR 0026): paste or link a skill and see what it asks an agent to do; a shareable page per
// public result; the rules; and Skill Watch, the public feed of flagged skills. Wording: "matches pattern X at line
// N", never "malicious". Excerpts are shown to people only (agents get rule ids and lines; services/scans.ts).

/** The skill-scan GitHub Action, published in the skill-scan/ folder of theagentforge/forge-check (20 Oct). */
export const SKILL_SCAN_ACTION_LIVE = true;

const SEV_LABEL: Record<ScanSeverity, string> = { high: "High", medium: "Medium", low: "Low" };
const verdictWord = { flagged: "Flagged", caution: "Caution", clear: "No known risky patterns" } as const;
const vClass = { flagged: "flagged", caution: "caution", clear: "clear" } as const;

/** The sentence people share from a result page, with the page link tagged by where it's shared. */
export function shareLine(verdict: "flagged" | "caution" | "clear", findings: ScanFinding[], url: string) {
  const what = patternPhrase(findings);
  if (verdict === "flagged") return `My agent was about to install a skill that ${what}. The Forge caught it before install: ${url}`;
  if (verdict === "caution") return `Checked a skill before my agent installed it. It ${what}, so I read those lines first: ${url}`;
  return `Checked a skill before my agent installed it: no known risky patterns. Free scan, no account: ${url}`;
}

/** The two ways in, for anyone who lands on a result: scan their own, or give their agent the one line. */
function checkYours(origin: string, from: string) {
  return html`<section class="check-yours panel chamfer panel-body" aria-labelledby="check-yours">
<h2 id="check-yours">Check your own skills</h2>
<form class="scan-quick" method="post" action="/scan?from=${from}"><label class="sr-only" for="yours-url">Link to a skill file</label><input id="yours-url" name="url" type="url" inputmode="url" placeholder="Paste a ClawHub or GitHub link to a skill" maxlength="2048" required><button class="btn primary chamfer" type="submit">Scan it</button></form>
<p>Or paste this into your agent once, and it checks every skill before installing it:</p>
<div class="copy-wrap">${copyBlock(`agent-line-${from}`, AGENT_LINE(origin))}</div>
<p class="small muted">Free, no account. <a href="/skill.md">Read the skill file first</a>.</p>
</section>`;
}

function shareButtons(text: string, url: string) {
  const enc = encodeURIComponent;
  return html`<p class="share-buttons small"><a class="btn chamfer" href="https://x.com/intent/post?text=${enc(text)}" target="_blank" rel="noopener">Post on X</a> <a class="btn chamfer" href="https://bsky.app/intent/compose?text=${enc(text)}" target="_blank" rel="noopener">Bluesky</a> <a class="btn chamfer" href="https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}" target="_blank" rel="noopener">LinkedIn</a></p>`;
}

function scanForm(prefill: { url?: string; text?: string } = {}) {
  return html`<form class="scan-form" method="post" action="/scan">
<label for="scan-url">Link to the skill <span class="muted small">(a ClawHub skill page, or the file on GitHub, GitLab, Gist, Codeberg, unpkg or jsDelivr)</span></label>
<input id="scan-url" name="url" type="url" inputmode="url" placeholder="https://github.com/owner/repo/blob/main/SKILL.md" value="${prefill.url ?? ""}" maxlength="2048">
<label for="scan-text">…or paste its text</label>
<textarea id="scan-text" name="text" rows="8" maxlength="${SCAN_MAX_BYTES}" placeholder="Paste SKILL.md, an MCP server's tool descriptions, or an install script">${prefill.text ?? ""}</textarea>
<button class="btn primary chamfer" type="submit">Scan it, free</button>
<p class="small muted">No account. We keep what the scan found, never the text you paste.</p>
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
    body: html`<p class="eyebrow">Free · no account · ${SCAN_RULES.length} rules</p>
<h1 class="page-title">Scan a skill before your agent installs it.</h1>
<p class="lead">Skills are text your agent obeys. We check that text for what virus scanners miss: instructions hidden from you, downloads piped into a shell, reads of your keys, and data sent to throwaway servers.</p>
${scanForm()}
<section><h2>Let your agent check for itself</h2><p>Paste this into your agent once. From then on it checks every skill before installing it, and once a week checks the ones it has. It costs one small request a week.</p>${copyBlock("agent-line", AGENT_LINE(origin))}
<p class="small muted">The <a href="/skill.md">skill file</a> is plain text you can read first. Its fingerprint: <span class="mono">${ownFp}</span>. It passes this scanner, and it never asks your agent to fetch anything and follow it.</p></section>
${SKILL_SCAN_ACTION_LIVE ? html`<section><h2>In every pull request</h2><p>Publish skills or keep an AGENTS.md? The free <a href="https://github.com/theagentforge/forge-check/tree/main/skill-scan#readme">skill-scan GitHub Action</a> runs the same rules on each pull request, on GitHub's runner: one calm comment, notes on the flagged lines, and no file leaves GitHub.</p>${copyBlock("action-yaml", "- uses: theagentforge/forge-check/skill-scan@v1")}</section>` : ""}
${stats ? html`<p class="small muted">${reached("skills_scanned", stats.unique) ? html`${stats.unique.toLocaleString("en-US")} skills scanned so far · ` : ""}<a href="/skill-watch">Skill Watch</a> · <a href="/scan/rules">The rules</a></p>` : ""}`,
  });
});

site.post("/scan", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.CHECK_LIMITER.limit({ key: `scan:${ip}` });
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const url = typeof form.url === "string" ? form.url.trim() : "";
  const pasted = typeof form.text === "string" ? form.text : "";
  let body: unknown;
  if (!success) body = html`<p class="notice warn">Too many scans from your connection. Wait a minute and try again.</p>`;
  else if (pasted.trim()) {
    const { result, isPublic } = await scanAndRecord(c.env, pasted.slice(0, SCAN_MAX_BYTES));
    c.executionCtx.waitUntil(bump(c.env, scanCounters("web", result.verdict)).catch(() => {}));
    body = resultBlock(result, isPublic ? html`<p><a class="btn chamfer" href="${scanPath(result.fingerprint)}">Shareable page for this result</a></p>` : html`<p class="small muted">Pasted text that isn't flagged gets no public page.</p>`);
  } else if (url) {
    const got = await fetchSkillText(url);
    if (!got.ok)
      body = html`<p class="notice warn">${got.error === "unsupported_url" ? "That link isn't one we read from. Use a ClawHub skill page, a GitHub link (to the file, its folder or the repository), or a GitLab, Gist, Codeberg, unpkg or jsDelivr link to the file, or paste its text." : got.error === "not_found" ? "There's no SKILL.md at that link. If the repository keeps its skills in folders, open the skill's folder on GitHub and paste that link. For ClawHub, use the skill's page (clawhub.ai/owner/skills/name)." : got.error === "too_large" ? "That file is larger than 256 KB." : "We couldn't fetch that file. Check the link is public."}</p>`;
    else {
      const { result, isPublic } = await scanAndRecord(c.env, got.text, { sourceUrl: got.url });
      c.executionCtx.waitUntil(bump(c.env, scanCounters("web", result.verdict)).catch(() => {}));
      body = resultBlock(result, isPublic ? html`<p><a class="btn chamfer" href="${scanPath(result.fingerprint)}">Shareable page for this result</a></p>` : "");
    }
  } else body = html`<p class="notice warn">Give a link or paste the text.</p>`;
  return send(
    c,
    {
      title: "Skill scan result",
      description: "A free skill scan from The Agent Forge.",
      path: "/scan",
      nav: "scan",
      noindex: true,
      body: html`<h1 class="page-title">Skill scan</h1>${body}${scanForm({ url })}`,
    },
    { cache: false },
  );
});

/** The agent skill file, served from static assets; the Worker sees it first only to count fetches (pages.ts). */
site.get("/skill.md", (c) => c.env.ASSETS.fetch(new Request(new URL("/skill.md", c.req.url), { headers: c.req.raw.headers })));

site.get("/scan/rules", (c) =>
  send(c, {
    title: "Skill scan rules",
    description: `The ${SCAN_RULES.length} patterns the Forge's free skill scanner looks for, with why each matters.`,
    path: "/scan/rules",
    nav: "scan",
    body: html`<h1 class="page-title">The rules</h1>
<p class="lead">Rules version ${SCAN_RULES_VERSION}. Each rule is a text pattern taken from published attacks on agents and their skills. A match means "look at this line", not "this is malicious": security tools, for example, quote these patterns on purpose. People decide.</p>
<table class="table stack"><thead><tr><th>Rule</th><th>Severity</th><th>Pattern</th><th>Why it matters</th></tr></thead><tbody>${SCAN_RULES.map(
      (x) => html`<tr id="${x.id}"><td class="mono">${x.id}</td><td data-label="Severity"><span class="sev sev-${x.severity}">${SEV_LABEL[x.severity]}</span></td><td>${x.title}</td><td class="small muted">${x.why}</td></tr>`,
    )}</tbody></table>
<p class="small muted">Flagged: at least one high-severity match. Caution: medium only. The scanner reads text; it doesn't run anything, so it can miss attacks that only show when code runs. Found a false match or a pattern we miss? <a href="mailto:hello@theagentforge.io?subject=Scan%20rule">Tell us</a>.</p>`,
  }),
);

site.get("/scan/:hex{[0-9a-f]{64}}", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const row = await scanByFingerprint(getDb(c.env), `sha256:${c.req.param("hex")}`);
  if (!row || !row.public) return c.notFound();
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
    body: html`<p class="eyebrow">Skill scan · first seen ${new Date(row.firstSeen).toISOString().slice(0, 10)} · scanned ${row.scans} ${row.scans === 1 ? "time" : "times"}</p>
<h1 class="page-title">${label.title}${label.where ? html` <span class="muted title-where">· ${label.where}</span>` : ""}</h1>
${claw
      ? html`<p class="small source-link"><a href="${claw.page}" rel="nofollow ugc">${claw.page.replace(/^https:\/\//, "")}</a> · ClawHub runs its own checks too: <a href="${claw.audit}" rel="nofollow">its security audit</a>. This scan is an independent second opinion, not ClawHub's.</p>`
      : row.sourceUrl
        ? html`<p class="small mono source-link"><a href="${row.sourceUrl}" rel="nofollow ugc">${row.sourceUrl.replace(/^https:\/\//, "")}</a></p>`
        : ""}
${resultBlock({ verdict: row.verdict, counts: row.counts as Record<ScanSeverity, number>, findings, fingerprint: row.fingerprint, rulesVersion: row.rulesVersion })}
<section><h2>Share</h2><div class="copy-wrap">${copyBlock("share-line", shareLine(row.verdict, findings, `${page}?from=share`))}</div>
${shareButtons(shareLine(row.verdict, findings, `${page}?from=share-x`), `${page}?from=share-li`)}
${row.sourceUrl && row.verdict === "clear" ? html`<p>Your skill? Put this badge in its README. It always shows the latest scan of this file:</p><div class="copy-wrap">${copyBlock("badge-md", `[![Forge scan](${origin}/scan/badge.svg?url=${encodeURIComponent(row.sourceUrl)})](${page})`)}</div>` : ""}
${row.sourceUrl && row.verdict !== "clear" ? html`<form method="post" action="/scan?from=rescan"><input type="hidden" name="url" value="${row.sourceUrl.replace(/\/[0-9a-f]{40}\//, "/HEAD/")}"><p>Your skill? Change it, then <button class="btn chamfer" type="submit">Scan the latest version</button> The new version gets its own page.</p></form>` : ""}</section>
<p class="small muted">This page shows text patterns in one exact version of the file (its fingerprint above), not a judgement of its author. Publisher? <a href="mailto:disputes@theagentforge.io?subject=Scan%20${row.fingerprint.slice(7, 19)}">Reply or dispute</a>, and we add your reply here.</p>
${checkYours(origin, "result")}`,
  });
});

site.get("/skill-watch", async (c) => {
  const db = getDb(c.env);
  const [stats, flagged] = await Promise.all([scanStats(db), recentPublic(db, ["flagged", "caution"], 60)]);
  const freq = ruleFrequency(flagged).slice(0, 8);
  const rule = (id: string) => SCAN_RULES.find((x) => x.id === id);
  if (c.req.query("format") === "json")
    return c.json({ rules_version: SCAN_RULES_VERSION, stats, rule_frequency: freq.map(([id, n]) => ({ rule: id, skills: n })), recent: flagged.map((r) => ({ fingerprint: r.fingerprint, verdict: r.verdict, source_url: r.sourceUrl, counts: r.counts, first_seen: new Date(r.firstSeen).toISOString(), page_url: `${c.env.PUBLIC_ORIGIN}${scanPath(r.fingerprint)}` })) });
  return send(c, {
    title: "Skill Watch",
    description: "Agent skills that matched risky patterns in the Forge's free scanner, newest first, with every flagged line.",
    path: "/skill-watch",
    nav: "skillwatch",
    jsonAlternate: "/skill-watch?format=json",
    body: html`<p class="eyebrow">Skill Watch · rules ${SCAN_RULES_VERSION}</p>
<h1 class="page-title">What skills tell agents to do</h1>
<p class="lead">Public skills that matched a risky pattern, newest first. Each links to the exact lines. A match is a reason to read, not a verdict on the author.</p>
${reached("skills_scanned", stats.unique) ? html`<ul class="stat-row"><li><b>${stats.unique.toLocaleString("en-US")}</b> skills scanned</li><li><b>${stats.flagged.toLocaleString("en-US")}</b> flagged</li><li><b>${stats.caution.toLocaleString("en-US")}</b> caution</li></ul>` : ""}
${reached("skills_scanned", stats.unique) ? html`<p class="small muted">Counts include security courses and scanner test files, which quote attacks on purpose, and results we hold back while their maintainers hear from us. The <a href="/reports/skill-scan-2026-10?from=skill-watch">launch report</a> separates them: 30 of 9,014 ordinary skills were flagged.</p>` : ""}
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
        : html`<p class="empty">Nothing flagged yet. <a href="/scan">Scan a skill</a>.</p>`
    }</section>
<p class="small muted"><a href="/scan">Scan a skill</a> · <a href="/scan/rules">The rules</a> · <a href="/skill-watch.atom">Follow (Atom feed)</a> · <a href="/skill-watch?format=json">JSON</a></p>
${checkYours(c.env.PUBLIC_ORIGIN, "skill-watch")}`,
  });
});

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[ch]!);

/** Skill Watch as an Atom feed, for researchers and press who follow it in a reader. Flagged results only. */
site.get("/skill-watch.atom", async (c) => {
  const origin = c.env.PUBLIC_ORIGIN;
  const rows = await recentPublic(getDb(c.env), ["flagged"], 30);
  const updated = new Date(rows[0]?.lastSeen ?? Date.UTC(2026, 9, 19)).toISOString();
  const entries = rows.map((r) => {
    const l = skillLabel(r.sourceUrl, r.name);
    const url = `${origin}${scanPath(r.fingerprint)}`;
    return `<entry><id>${url}</id><title>${xmlEsc(`Flagged: ${l.title}${l.where ? ` (${l.where})` : ""}`)}</title><link href="${xmlEsc(`${url}?from=atom`)}"/><updated>${new Date(r.lastSeen).toISOString()}</updated><summary>${xmlEsc(`This skill ${patternPhrase(r.findings as ScanFinding[])}. A match is a reason to read the line, not a verdict on the author.`)}</summary></entry>`;
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
