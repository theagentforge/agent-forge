// The PDF of a State of Agent Reliability edition (ADR 0079). A small, dependency-free PDF 1.4 writer: A4 pages, the
// standard Helvetica and Courier fonts (no embedding), uncompressed text, clickable source links. Why hand-written:
// the repo has no PDF tooling; a headless browser would add a large CI download and timestamps that change every
// build, and a PDF library would be a new dependency. This writer has no clock and no random IDs, so the same edition
// always gives the same bytes (checked by a test and by `node scripts/reliability-report.mjs rebuild`), and its text
// stays readable to any PDF reader, search engine or `grep`.
//
// No runtime imports (types only), so Node can run it from scripts/reliability-report.mjs.

import type { Edition, Seg } from "./reliability-edition";

/** Shown with the totals on the page and in the PDF (kept here: this file has no runtime imports). */
export const TOTALS_NOT_RATES =
  "These are activity counts, not the samples behind the rates: they can include bouts the rates leave out (older referee rules, results still under notice, events still being checked), so they can be larger than the ranked attempts in the findings.";

// ---------------------------------------------------------------- text helpers (kept in step with reliability-edition.ts)

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
};

/** The same formatting as `display` in reliability-edition.ts (a test checks they agree). */
export function pdfDisplay(v: number | string | boolean | null, fmt: string): string {
  if (v === null) return "not available";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return fmt === "date" ? dayText(v) : v.replace(/_/g, " ");
  if (fmt === "pct") return `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
  if (fmt === "pct2") return `${(Math.round(v * 10000) / 100).toFixed(2)}%`;
  if (fmt === "pct_lo") return `${(Math.floor(v * 1000 + 1e-9) / 10).toFixed(1)}%`;
  if (fmt === "pct_hi") return `${(Math.ceil(v * 1000 - 1e-9) / 10).toFixed(1)}%`;
  if (fmt === "ratio") return v.toFixed(2);
  return v.toLocaleString("en-US");
}

const segText = (segs: Seg[], e: Edition) => segs.map((s) => (typeof s === "string" ? s : pdfDisplay(e.nums[s.n]?.value ?? null, s.fmt))).join("");

/** Characters outside printable ASCII mapped to plain ones, so every byte of the file is 7-bit ASCII. */
export function asciiText(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/·/g, "-")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\n]/g, "?");
}

// Helvetica advance widths (Adobe AFM, 1/1000 em) for ASCII 32 to 126; Courier is 600 throughout.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667,
  667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500,
  556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
type Font = "F1" | "F2" | "F3";
function width(s: string, font: Font, size: number) {
  let w = 0;
  for (const ch of s) w += font === "F3" ? 600 : (HELV[ch.charCodeAt(0) - 32] ?? 556) * (font === "F2" ? 1.06 : 1);
  return (w * size) / 1000;
}

function wrap(text: string, font: Font, size: number, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    // Monospaced blocks (BibTeX, CFF) keep their spacing and break by characters only when too long.
    if (font === "F3") {
      let rest = para;
      const per = Math.max(1, Math.floor(max / ((600 * size) / 1000)));
      while (rest.length > per) {
        // Break at the last space that fits (so a copied BibTeX or CFF line keeps its words whole), else by characters.
        const sp = rest.lastIndexOf(" ", per);
        const cut = sp > per / 2 ? sp : per;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      out.push(rest);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, font, size) <= max || !line) {
        // A single word longer than the line (a URL) is broken by characters.
        if (width(next, font, size) > max && !line) {
          let chunk = "";
          for (const ch of word) {
            if (width(chunk + ch, font, size) > max) {
              out.push(chunk);
              chunk = "";
            }
            chunk += ch;
          }
          line = chunk;
        } else line = next;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

const esc = (s: string) => asciiText(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

// ---------------------------------------------------------------- layout

export interface Block {
  kind: "title" | "h2" | "h3" | "p" | "small" | "mono" | "bullet";
  text: string;
  url?: string;
  /** Start a new page before this block (the buyer brief's page 2, ADR 0102). */
  pageBreak?: boolean;
}

const STYLE: Record<Block["kind"], { font: Font; size: number; lead: number; before: number; indent?: number }> = {
  title: { font: "F2", size: 20, lead: 25, before: 0 },
  h2: { font: "F2", size: 13, lead: 17, before: 14 },
  h3: { font: "F2", size: 10.5, lead: 14, before: 8 },
  p: { font: "F1", size: 10, lead: 14, before: 5 },
  small: { font: "F1", size: 8.5, lead: 11.5, before: 3 },
  mono: { font: "F3", size: 7.5, lead: 9.5, before: 4 },
  bullet: { font: "F1", size: 10, lead: 14, before: 3, indent: 12 },
};

const W = 595.28;
const H = 841.89;
const M = 56;
const TOP = H - M;
const BOTTOM = M + 24;

export interface PageOut {
  ops: string[];
  links: { x: number; y: number; w: number; h: number; url: string }[];
}

/** Lays blocks out on A4 pages with a footer on each. Also used by the private buyer brief (reports/buyer-brief.ts). */
export function layout(blocks: Block[], footer: string): PageOut[] {
  const pages: PageOut[] = [];
  let page: PageOut = { ops: [], links: [] };
  let y = TOP;
  const newPage = () => {
    pages.push(page);
    page = { ops: [], links: [] };
    y = TOP;
  };
  for (const b of blocks) {
    const st = STYLE[b.kind];
    const indent = st.indent ?? 0;
    const max = W - 2 * M - indent;
    const lines = wrap(asciiText(b.text), st.font, st.size, max);
    if (b.pageBreak && y !== TOP) newPage();
    if (y !== TOP) y -= st.before;
    // Keep a heading with at least two lines of what follows.
    if ((b.kind === "h2" || b.kind === "h3") && y - st.lead * 3 < BOTTOM) newPage();
    lines.forEach((ln, i) => {
      if (y - st.lead < BOTTOM) newPage();
      y -= st.lead;
      const x = M + indent;
      if (b.kind === "bullet" && i === 0) page.ops.push(`BT /F1 ${st.size} Tf ${(M + 2).toFixed(2)} ${y.toFixed(2)} Td (-) Tj ET`);
      page.ops.push(`BT /${st.font} ${st.size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(ln)}) Tj ET`);
      if (b.url) page.links.push({ x, y: y - 2, w: width(ln, st.font, st.size), h: st.size + 2, url: b.url });
    });
  }
  pages.push(page);
  const total = pages.length;
  pages.forEach((p, i) => p.ops.push(`BT /F1 7.5 Tf ${M} ${(M - 6).toFixed(2)} Td (${esc(`${footer} - page ${i + 1} of ${total}`)}) Tj ET`));
  return pages;
}

/** Writes the PDF objects with an exact cross-reference table. Same input, same bytes. */
export function writePdf(pages: PageOut[], info: { title: string; author: string; subject: string; keywords: string; date: string }): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => {
    objs.push(s);
    return objs.length;
  };
  const catalog = add("");
  const pagesObj = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const f3 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const p of pages) {
    const stream = p.ops.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const annots = p.links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${l.x.toFixed(2)} ${l.y.toFixed(2)} ${(l.x + l.w).toFixed(2)} ${(l.y + l.h).toFixed(2)}] /Border [0 0 0] /A << /S /URI /URI (${esc(l.url)}) >> >>`));
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(" ")}]` : ""} >>`,
      ),
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R /Lang (en-GB) >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const d = info.date.replace(/-/g, "");
  const infoObj = add(`<< /Title (${esc(info.title)}) /Author (${esc(info.author)}) /Subject (${esc(info.subject)}) /Keywords (${esc(info.keywords)}) /Creator (The Agent Forge reliability-pdf) /Producer (The Agent Forge reliability-pdf) /CreationDate (D:${d}000000Z) /ModDate (D:${d}000000Z) >>`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is 7-bit ASCII (asciiText), so string length equals byte length and the offsets are exact.
  return new TextEncoder().encode(out);
}

/** The edition as PDF blocks, in the page's order: stamp, methods and limits, findings, case, totals, sources, citation. */
export function editionBlocks(e: Edition, origin: string, parts: { methods: { title: string; text: Seg[] }[]; caseText: Seg[] | null }): Block[] {
  const base = origin.replace(/\/$/, "");
  const rv = e.rules_versions;
  const b: Block[] = [];
  b.push({ kind: "title", text: `${e.name}` });
  b.push({ kind: "h3", text: `Edition ${e.edition} (${e.quarter}) - The Agent Forge (theagentforge.io)` });
  b.push({
    kind: "small",
    text: `Edition ${e.edition}, generated ${dayText(e.generated)}${e.mode === "live_preview" ? " (live preview: not yet frozen)" : ""}. Rules versions: Arena referee ${rv.arena_referee ?? "n/a"}; Trap Set ${rv.trap_set ?? "n/a"}; skill scan ${rv.skill_scan ?? "n/a"}; stats ${rv.stats_rules ?? "n/a"}. Regenerated each quarter; next edition due ${dayText(`${e.next_due}-01`).replace(/^1 /, "")}.`,
  });
  b.push({ kind: "small", text: `Online, with every number linked to its source: ${base}${e.path}`, url: `${base}${e.path}` });
  if (e.mode !== "frozen")
    b.push({ kind: "h3", text: "LIVE PREVIEW - NOT FROZEN. The numbers are read from the live files when this PDF is built and will change. Do not cite this preview; cite the frozen edition once it is published at the address above." });

  b.push({ kind: "h2", text: "Methods and limits (read first)" });
  for (const m of parts.methods) b.push({ kind: "bullet", text: `${m.title}. ${segText(m.text, e)}` });

  b.push({ kind: "h2", text: "Findings" });
  e.findings.forEach((f, i) => {
    b.push({ kind: "h3", text: `${i + 1}. ${f.title}` });
    b.push({ kind: "p", text: segText(f.text, e) });
    if (f.warning) b.push({ kind: "small", text: `Note: ${segText(f.warning, e)}` });
    b.push({ kind: "small", text: `Source: ${base}${sourcePath(e, f.source)} (more: ${base}${f.more})`, url: `${base}${sourcePath(e, f.source)}` });
  });

  if (e.groups.length) {
    b.push({ kind: "h3", text: "Fall rate by kind of job (ranked attempts, current referee rules)" });
    for (const g of e.groups) {
      const v = (id: string | null, fmt: string) => (id ? pdfDisplay(e.nums[id]?.value ?? null, fmt) : "");
      b.push({
        kind: "bullet",
        text: g.shown
          ? `${v(g.name, "text")}: ${v(g.falls, "int")} of ${v(g.attempts, "int")} (${v(g.rate, "pct")}; 95% interval ${v(g.lo, "pct_lo")} to ${v(g.hi, "pct_hi")})${g.early ? " - early read, small sample" : ""}`
          : `${v(g.name, "text")}: ${v(g.attempts, "int")} attempts - too few to show a rate`,
      });
    }
  }

  b.push({ kind: "h2", text: e.nums.case_ranked?.value === true ? "Illustrative case (a ranked bout)" : "Illustrative case (practice, not ranked)" });
  b.push({ kind: "p", text: parts.caseText ? segText(parts.caseText, e) : "No public replay currently shows both a paid fake invoice and a model reporting the job done; the case is left out rather than guessed." });
  if (e.case_study.replay_url) b.push({ kind: "small", text: `Replay: ${e.case_study.replay_url}`, url: e.case_study.replay_url });

  b.push({ kind: "h2", text: "Activity totals" });
  b.push({ kind: "small", text: "Includes The Forge's own test agents. Practice is included unless a line says ranked." });
  for (const t of e.totals) b.push({ kind: "bullet", text: `${t.label}: ${pdfDisplay(e.nums[t.n]?.value ?? null, "int")}` });
  b.push({ kind: "small", text: TOTALS_NOT_RATES });
  b.push({ kind: "small", text: `Source: ${base}${sourcePath(e, "stats")} (how each is counted: ${base}/stats/rules)`, url: `${base}${sourcePath(e, "stats")}` });

  b.push({ kind: "h2", text: "Sources and how to reproduce" });
  b.push({ kind: "p", text: `Every number is a value at a JSON pointer in one of these public files${e.mode === "frozen" ? `, saved when this edition was generated (copies at ${base}/reports/state-of-agent-reliability/2026-q4/sources/)` : ""}. The full list of numbers, pointers and formulas is in the edition's data file: ${base}${e.path}.json` });
  for (const s of e.sources) b.push({ kind: "bullet", text: `${s.key}: ${base}${s.path}`, url: `${base}${s.path}` });
  for (const [op, text] of Object.entries(e.ops)) b.push({ kind: "small", text: `${op}: ${text}` });

  b.push({ kind: "h2", text: "How to cite" });
  b.push({ kind: "p", text: e.citation.text });
  b.push({ kind: "h3", text: "BibTeX" });
  b.push({ kind: "mono", text: e.citation.bibtex });
  b.push({ kind: "h3", text: "CITATION.cff" });
  b.push({ kind: "mono", text: e.citation.cff.trimEnd() });
  b.push({ kind: "small", text: "Data is free for evaluation, research and reporting with attribution, and not for training AI models." });
  if (e.canary) {
    b.push({ kind: "h3", text: "Canary" });
    b.push({ kind: "small", text: e.canary });
  }
  return b;
}

const COPY_FILES: Record<string, string> = { benchmark: "benchmark-v1.json", stats: "stats.json", security: "security.json", home: "home.json" };
/** A finding's source: the saved copy once frozen (as the page links), else the live file. Kept in step with SOURCE_FILES. */
const sourcePath = (e: Edition, key: string) =>
  e.mode === "frozen" ? `${e.path}/sources/${COPY_FILES[key] ?? ""}` : (e.sources.find((s) => s.key === key)?.path ?? "");

/** The whole PDF for an edition. */
export function editionPdf(e: Edition, origin: string, parts: { methods: { title: string; text: Seg[] }[]; caseText: Seg[] | null }): Uint8Array {
  const blocks = editionBlocks(e, origin, parts);
  const pages = layout(blocks, `${e.name}, Edition ${e.edition} (${e.quarter}), generated ${e.generated}${e.mode === "frozen" ? "" : " - LIVE PREVIEW, not frozen"}`);
  return writePdf(pages, {
    title: `${e.name}, Edition ${e.edition} (${e.quarter})`,
    author: "The Agent Forge",
    subject: "How often AI agents fell for planted traps in refereed business jobs, with sample sizes and 95% intervals",
    keywords: e.canary ?? "",
    date: e.generated,
  });
}
