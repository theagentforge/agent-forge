import { html, raw } from "hono/html";
import { marked } from "marked";
import census from "../../../../docs/reports/2026-10-mcp-registry-census.md";
import skillScanReport from "../../../../docs/reports/2026-10-skill-scan.md";
import checkGuide from "../../../../docs/guides/check-before-install.md";
import advisories202610 from "../../../../docs/reports/advisories-2026-10.md";
import labNotes from "../../../../lab/001-calm-vs-cheating/results/NOTES.md";
import labRuns from "../../../../lab/001-calm-vs-cheating/results/runs.csv";
import labPrereg from "../../../../lab/001-calm-vs-cheating/PREREGISTRATION.md";
import labWriteup from "../../../../lab/001-calm-vs-cheating/WRITEUP.md";
import lab3Prereg from "../../../../lab/003-trap-cards/PREREGISTRATION.md";
import lab3Placebo from "../../../../lab/003-trap-cards/prompts/B-placebo.txt";
import lab3Card from "../../../../lab/003-trap-cards/prompts/C-generic-card.txt";
import lab3Results from "../../../../lab/003-trap-cards/RESULTS.md";
import lab3Output from "../../../../lab/003-trap-cards/analysis-output.md";
import lab3Counts from "../../../../lab/003-trap-cards/counts.json";
import lab4Prereg from "../../../../lab/004-trap-card-frontier/PREREGISTRATION.md";
import lab4Card from "../../../../lab/004-trap-card-frontier/prompts/C-card.txt";
import lab4Results from "../../../../lab/004-trap-card-frontier/RESULTS.md";
import lab4Output from "../../../../lab/004-trap-card-frontier/analysis-output.md";
import lab4Counts from "../../../../lab/004-trap-card-frontier/counts.json";
import lab4Selection from "../../../../lab/004-trap-card-frontier/selection.json";
import lab5Prereg from "../../../../lab/005-trap-card-v11-frontier/PREREGISTRATION.md";
import lab5CardV10 from "../../../../lab/005-trap-card-v11-frontier/prompts/C-card.txt";
import lab5CardV11 from "../../../../lab/005-trap-card-v11-frontier/prompts/E-card-v1.1.txt";
import lab5Selection from "../../../../lab/005-trap-card-v11-frontier/selection.json";
import { experimentForPath } from "./experiments";
import { send, site } from "./pages";

// Published reports and Forge Lab write-ups, rendered from the Markdown in docs/ and lab/ (bundled as text, so the
// repo stays the single source). The Markdown is ours and trusted; nothing user-supplied is rendered here.

interface Publication {
  path: string;
  markdown: string;
  description: string;
  /** Share image, when the report has its own (else the site's default). */
  image?: string;
  /** Off until Dinike has read it (the X posts for it need the page live). */
  live: boolean;
  files?: { name: string; label: string; text: string; type: string }[];
  /** A scan box placed before these "## " headings, each tagged so we can see which one people use. */
  scanBoxes?: { before: string; from: string }[];
}

/**
 * The report's own call to action, where readers are (23 Oct traffic: 320 views of the launch report, 1 scan, and the
 * only form was at the very end). Posts to /scan with a `from` tag, counted as scan:from:<tag> (internal).
 */
export function reportScanBox(from: string) {
  return html`<aside class="panel chamfer report-scan" aria-label="Scan a skill">
<p><b>Check a skill before your agent installs it.</b> Paste a GitHub or ClawHub link. Free, no account, the same rules as this report and newer ones.</p>
<form class="scan-quick" method="post" action="/scan"><input type="hidden" name="from" value="${from}"><label class="sr-only" for="scan-${from}">Link to a skill file</label><input id="scan-${from}" name="url" type="url" inputmode="url" placeholder="https://github.com/owner/repo/…/SKILL.md" maxlength="2048" required><button class="btn primary chamfer" type="submit">Scan it</button></form>
</aside>`;
}

export const PUBLICATIONS: Publication[] = [
  {
    // The October 2026 advisory wave (crisis-wave plan §6, crisis-messaging §4): official facts first, then what our own
    // check said before and after. Kept as an archive once the home line retires.
    path: "/advisories/2026-10",
    markdown: advisories202610,
    description: "October 2026 advisories: what an agent can check this week. LiteLLM 1.107.0 and PHP2Shell facts with official links, and what our check returned before and after it read OSV and CISA data.",
    live: true,
  },
  {
    // The question people search for (23 Oct: the search results for it are Snyk, SkillScan, Backslash), answered
    // first, with our own data. Published by Claude for Dinike's "go ahead with all" (23 Oct).
    path: "/guides/check-before-install",
    markdown: checkGuide,
    description: "How to check an MCP server or agent skill before you install it: who publishes it, what it can reach, what its words tell your agent, what other agents reported on that version, and a first run with no secrets.",
    live: true,
    scanBoxes: [{ before: "1. Who publishes it", from: "guide-top" }],
  },
  {
    path: "/reports/skill-scan-2026-10",
    markdown: skillScanReport,
    description: "We scanned 9,930 public agent skills for the instructions virus scanners miss. No malware found by this method; 14 pipe a download into a shell and 8 read the agent's whole key file.",
    image: "/og/reports/skill-scan-2026-10.png",
    // The launch report (ADR 0026). Reviewed against disclosure practice and approved for Dinike on 19 Oct (v1.1).
    live: true,
    scanBoxes: [
      { before: "Why we looked", from: "report-top" },
      { before: "The flagged ordinary skills", from: "report-found" },
    ],
  },
  {
    path: "/lab/3/results",
    markdown: lab3Results,
    image: "/og/lab/3.png",
    description: "Forge Lab #3 results: with the trap card, small open models fell for 54% fewer traps on new versions of the jobs. Where it didn't help, and what it cost.",
    // Pre-registered to be published whatever it showed.
    live: true,
    files: [
      { name: "analysis-output.md", label: "Full analysis output", text: lab3Output, type: "text/markdown" },
      { name: "counts.json", label: "Counts per arm, model and job (JSON)", text: JSON.stringify(lab3Counts, null, 1), type: "application/json" },
      { name: "preregistration.md", label: "Pre-registration", text: lab3Prereg, type: "text/markdown" },
    ],
  },
  {
    path: "/lab/3",
    markdown: lab3Prereg,
    description: "Forge Lab #3, pre-registered: does the trap card make AIs fall for fewer traps on new versions of the same jobs?",
    // A pre-registration is published before the runs: that's what makes it one.
    live: true,
    files: [
      { name: "arm-b-placebo.txt", label: "Arm B: same-length text without checks", text: lab3Placebo, type: "text/plain" },
      { name: "arm-c-card.txt", label: "Arm C: trap card v1.0, frozen", text: lab3Card, type: "text/plain" },
    ],
  },
  {
    path: "/lab/4/results",
    markdown: lab4Results,
    description: "Forge Lab #4 results: on frontier models, a safety checklist in the prompt (the trap card) didn't measurably reduce traps (24.8% vs 29.5%, p = 0.51), and it caused no measurable harm.",
    // Pre-registered to be published whatever it showed.
    live: true,
    files: [
      { name: "analysis-output.md", label: "Full analysis output", text: lab4Output, type: "text/markdown" },
      { name: "counts.json", label: "Counts per arm, model and job (JSON)", text: JSON.stringify(lab4Counts, null, 1), type: "application/json" },
      { name: "preregistration.md", label: "Pre-registration", text: lab4Prereg, type: "text/markdown" },
    ],
  },
  {
    path: "/lab/4",
    markdown: lab4Prereg,
    description: "Forge Lab #4, pre-registered: does the trap card help frontier models on the Arena's Hard jobs?",
    live: true,
    files: [
      { name: "arm-c-card.txt", label: "Arm C: trap card v1.0, frozen", text: lab4Card, type: "text/plain" },
      { name: "selection.json", label: "The 7 model–job pairs, fixed before any run", text: JSON.stringify(lab4Selection, null, 1), type: "application/json" },
    ],
  },
  {
    path: "/lab/5",
    markdown: lab5Prereg,
    description: "Forge Lab #5, pre-registered: on the Hard jobs frontier models fail most often, does a sharper trap card (v1.1) cut traps?",
    // A pre-registration is published before the runs: that's what makes it one.
    live: true,
    files: [
      { name: "arm-c-card.txt", label: "Arm C: trap card v1.0, frozen", text: lab5CardV10, type: "text/plain" },
      { name: "arm-e-card-v1.1.txt", label: "Arm E: trap card v1.1, frozen", text: lab5CardV11, type: "text/plain" },
      { name: "selection.json", label: "The 4 model–job pairs, fixed before any run", text: JSON.stringify(lab5Selection, null, 1), type: "application/json" },
    ],
  },
  {
    path: "/reports/mcp-registry-census-2026-10",
    markdown: census,
    description: "A census of every server in the official MCP Registry: how many are remote-only, link no source, and how they're packaged.",
    live: true,
  },
  {
    path: "/lab/1",
    markdown: labWriteup,
    description: "Forge Lab #1: 150 pre-registered runs on impossible coding tasks, testing whether calming an agent changes how often it cheats.",
    // Approved with the X thread (#35: "approving here also means OK to publish the write-up page"), which went out on
    // 23 Oct linking here; switched on 24 Oct.
    live: true,
    files: [
      { name: "preregistration.md", label: "Pre-registration", text: labPrereg, type: "text/markdown" },
      { name: "runs.csv", label: "All 150 runs (CSV)", text: labRuns, type: "text/csv" },
      { name: "notes.md", label: "Hand checks and deviations", text: labNotes, type: "text/markdown" },
    ],
  },
];

/** Splits off the first "# " heading as the page title and renders the rest. Tables get the site style and scroll on phones. */
export function renderMarkdown(md: string) {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.startsWith("# "));
  const title = at >= 0 ? lines[at]!.slice(2).trim() : "";
  const rest = at >= 0 ? [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n") : md;
  const body = (marked.parse(rest, { async: false, gfm: true }) as string)
    .replace(/<table>/g, '<div class="table-scroll"><table class="table">')
    .replace(/<\/table>/g, "</table></div>");
  return { title, body };
}

for (const p of PUBLICATIONS) {
  site.get(p.path, (c) => {
    if (!p.live) return c.notFound();
    const rendered = renderMarkdown(p.markdown);
    const { title } = rendered;
    // Lab #3 and Lab #4 also carry their plain names (Boardy review item 3); the /lab/N URLs stay.
    const exp = experimentForPath(p.path);
    let body = rendered.body;
    for (const b of p.scanBoxes ?? []) body = body.replace(`<h2>${b.before}</h2>`, `${reportScanBox(b.from)}\n<h2>${b.before}</h2>`);
    return send(c, {
      title: exp ? `${exp.short} (${exp.who}): ${title}` : title,
      description: p.description,
      ...(p.image ? { image: p.image } : {}),
      path: p.path,
      body: html`<article class="prose">
${exp ? html`<p class="eyebrow experiment-name">${exp.name}${p.path === exp.plan ? " (the plan)" : ""} · <a href="/#experiments">see it next to ${exp.lab === 3 ? "Experiment 4" : "Experiment 3"}</a></p>` : ""}
<h1 class="page-title">${title}</h1>
${raw(body)}
${p.files?.length ? html`<h2>Materials</h2><ul>${p.files.map((f) => html`<li><a href="${p.path}/${f.name}">${f.label}</a></li>`)}</ul>` : ""}
</article>`,
    });
  });
  for (const f of p.files ?? []) {
    site.get(`${p.path}/${f.name}`, (c) => {
      if (!p.live) return c.notFound();
      return c.body(f.text, 200, { "Content-Type": `${f.type}; charset=utf-8`, "Cache-Control": "public, max-age=3600" });
    });
  }
}
