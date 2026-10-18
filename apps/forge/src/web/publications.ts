import { html, raw } from "hono/html";
import { marked } from "marked";
import census from "../../../../docs/reports/2026-10-mcp-registry-census.md";
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
import { send, site } from "./pages";

// Published reports and Forge Lab write-ups, rendered from the Markdown in docs/ and lab/ (bundled as text, so the
// repo stays the single source). The Markdown is ours and trusted; nothing user-supplied is rendered here.

interface Publication {
  path: string;
  markdown: string;
  description: string;
  /** Off until Dinike has read it (the X posts for it need the page live). */
  live: boolean;
  files?: { name: string; label: string; text: string; type: string }[];
}

export const PUBLICATIONS: Publication[] = [
  {
    path: "/lab/3/results",
    markdown: lab3Results,
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
    path: "/reports/mcp-registry-census-2026-10",
    markdown: census,
    description: "A census of every server in the official MCP Registry: how many are remote-only, link no source, and how they're packaged.",
    live: true,
  },
  {
    path: "/lab/1",
    markdown: labWriteup,
    description: "Forge Lab #1: 150 pre-registered runs on impossible coding tasks, testing whether calming an agent changes how often it cheats.",
    live: false,
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
    const { title, body } = renderMarkdown(p.markdown);
    return send(c, {
      title,
      description: p.description,
      path: p.path,
      body: html`<article class="prose">
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
