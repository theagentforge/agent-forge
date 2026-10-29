// B3-03 (ADR 0102): the private two-page buyer brief, /admin/brief.pdf. Built from live numbers each time it is
// downloaded, with the same PDF writer as the State of Agent Reliability report (reports/reliability-pdf.ts). Gross
// totals only, the same numbers the public site shows: the brief may be forwarded, so no outside-only number is ever
// read here (no thirdPartyData, no datasetBreakdown). The hand-kept words are in services/brief-private.ts (private).

import { BENCHMARK_VERSIONS_PATH } from "../arena/benchmark-versions";
import { benchmarkData } from "../arena/benchmark";
import { SAMPLE_DIR } from "../arena/sample";
import { exportIndex, readManifest } from "../services/bulk-export";
import { BRIEF_CONTACT, BRIEF_FOR_SALE, BRIEF_MOAT, BRIEF_NOT_READY, BRIEF_PRICE, BRIEF_ROADMAP } from "../services/brief-private";
import { rowShown } from "../services/counters";
import { getDb } from "../services/db";
import { FIELD_REPORTS_LABEL } from "../services/site-pulse";
import { INSTALL_CLIENT_NAMES } from "../services/install-metrics";
import { EXPERIMENTS, intervalText, pct, pText } from "../web/experiments";
import { statsData } from "../web/stats";
import { type Block, layout, writePdf } from "./reliability-pdf";

export const BRIEF_PATH = "/admin/brief.pdf";
/** The buyer's copy in the data room (a confirmed link only; every download logged). */
export const BRIEF_BUYER_PATH = "/data-room/brief.pdf";
/** The /dataset spec page (B3-01, built in parallel). Linked by path. */
export const DATASET_PATH = "/dataset";
export const BRIEF_MAX_PAGES = 2;

/** Field reports are mostly the House agent's nightly install tests (B3-06): the brief uses the site's own label. */
const FIELD_REPORTS_NOTE = `${FIELD_REPORTS_LABEL.replace(/\)$/, "")} of MCP servers)`;

/** A home-band total is shown when the site shows it: above zero, and the install total only past its minimum (ADR 0099). */
export const shownOnSite = (key: string, v: number | null | undefined): v is number =>
  typeof v === "number" && v > 0 && (key !== "install_checks_total" || rowShown("install_checks", v));

/** Every number the brief prints, read from the functions behind /stats, /benchmark and /lab/4/results. */
export async function briefData(env: Env, now = Date.now()) {
  const origin = env.PUBLIC_ORIGIN;
  const [stats, bench, exports] = await Promise.all([statsData(env), benchmarkData(getDb(env), origin), exportIndex(env)]);
  const latest = exports[0] ? await readManifest(env, exports[0].export_id) : null;
  const lab = (n: 3 | 4) => EXPERIMENTS.find((e) => e.lab === n)!;
  const l4 = lab(4).stats;
  const l3 = lab(3).stats;
  return {
    generated_at: new Date(now).toISOString(),
    gross_only: true as const,
    // The public home band rows (/stats.json totals), shown only when the site shows a number (it shows "none yet" else).
    totals: stats.totals.items.filter((x) => shownOnSite(x.key, x.value)).map((x): { key: string; label: string; value: number } => ({ key: x.key, label: x.key === "field_reports" ? FIELD_REPORTS_NOTE : x.label, value: x.value as number })),
    benchmark: {
      version: bench.version,
      traps: bench.counts.traps,
      families: bench.counts.families,
      jobs: bench.counts.jobs,
      ranked_attempts: bench.counts.ranked_attempts,
      models: bench.counts.models,
      not_known: bench.limits.not_known,
    },
    lab4: { bouts: l4.boutsTotal, pairs: l4.pairs, card_rate: l4.card.rate, none_rate: l4.none.rate, p: l4.p, interval: intervalText(l4), significant: l4.significant, results: lab(4).results },
    lab3: { fewer: l3.fewer, results: lab(3).results },
    export: latest ? { export_id: latest.export_id, created_at: latest.created_at, runs: latest.counts.runs, reports: latest.counts.reports, scans: latest.counts.scans } : null,
  };
}
export type BriefData = Awaited<ReturnType<typeof briefData>>;

const n = (v: number) => v.toLocaleString("en-US");
const pc = (r: number) => `${(Math.round(r * 1000) / 10).toFixed(1)}%`;

/** The brief as PDF blocks: page 1 (sale, not ready, what the data shows, traction), page 2 (dataset, moat, price). */
export function briefBlocks(d: BriefData, origin: string): Block[] {
  const base = origin.replace(/\/$/, "");
  const b: Block[] = [];
  const bullets = (xs: string[]) => xs.forEach((text) => b.push({ kind: "bullet", text }));
  const day = d.generated_at.slice(0, 10);

  // Page 1
  b.push({ kind: "title", text: "The Agent Forge: buyer brief" });
  b.push({ kind: "small", text: `Private and confidential. Built from live numbers on ${day} (${d.generated_at.slice(11, 16)} UTC). Every number is a gross total, the same as on the public site, our own test agents included.` });
  b.push({ kind: "h2", text: "What is for sale (as assets): a planted-trap test for AI agents, and safety data on the tools they install" });
  bullets(BRIEF_FOR_SALE);
  b.push({ kind: "h2", text: "What is not for sale, or not ready yet" });
  bullets(BRIEF_NOT_READY);
  b.push({ kind: "h2", text: "What the data shows" });
  const bm = d.benchmark;
  b.push({ kind: "bullet", text: `Trap Set v${bm.version}: ${n(bm.traps)} public traps in ${n(bm.families)} families across ${n(bm.jobs)} everyday jobs; ${n(bm.ranked_attempts)} ranked attempts on ${n(bm.models)} models (${base}/benchmark).` });
  const l4 = d.lab4;
  b.push({
    kind: "bullet",
    text: `Null result, Lab #4: a safety checklist in the prompt (our trap card) did not measurably reduce traps on frontier models. With it ${pc(l4.card_rate)} of bouts fell for a trap, without it ${pc(l4.none_rate)} (${n(l4.bouts)} bouts, ${l4.pairs} model-job pairs, ${pText(l4.p)}; 95% interval ${l4.interval}). It caused no measurable harm to legitimate work either. On small open models (Lab #3) the same card cut traps by ${pct(d.lab3.fewer)}%. We publish both (${base}${l4.results}).`,
  });
  b.push({ kind: "h2", text: "Traction (gross totals, as on the public site)" });
  if (d.totals.length) b.push({ kind: "p", text: `${d.totals.map((x) => `${n(x.value)} ${x.label}`).join("; ")}.` });
  else b.push({ kind: "p", text: "Not available at the time this brief was built." });
  b.push({ kind: "small", text: `Includes The Forge's own test agents, founder accounts and tests; traffic also includes crawlers and uptime checks. Counting rules: ${base}/stats/rules.` });

  // Page 2
  b.push({ kind: "h2", text: "The dataset in brief", pageBreak: true });
  b.push({ kind: "bullet", text: `Public: the Trap Set as JSON with a JSON Schema, Croissant metadata, CITATION.cff and an OSV feed. Frozen, hashed versions: ${base}${BENCHMARK_VERSIONS_PATH}.`, url: `${base}${BENCHMARK_VERSIONS_PATH}` });
  b.push({ kind: "bullet", text: `A sample buyers can open: ${base}${SAMPLE_DIR} (records drawn from public bouts, signed replays, a loader). The spec: ${base}${DATASET_PATH}.`, url: `${base}${SAMPLE_DIR}` });
  if (bm.not_known.length) b.push({ kind: "bullet", text: `Not yet known (stated on /benchmark): ${bm.not_known.map((x) => x.replace(/_/g, " ")).join("; ")}.` });
  b.push({ kind: "bullet", text: "Licence: evaluation only, not for training. Commercial and derivative licences by written agreement." });
  b.push({
    kind: "bullet",
    text: `Under NDA, a buyer receives: the full pseudonymised export (JSONL, CSV, Croissant, SHA-256 manifest${d.export ? `; latest ${d.export.created_at.slice(0, 10)}: ${n(d.export.runs)} runs, ${n(d.export.reports)} reports, ${n(d.export.scans)} scans` : ""}), the held-out panels and seeds, the private job families, the trap generator and job source, the referee code, the signing keys (handed over at close, never in the data room), and the data room (KPIs, costs, legal items, runbooks, decision records).`,
  });
  b.push({ kind: "h2", text: "Integrations" });
  b.push({ kind: "p", text: `${Object.values(INSTALL_CLIENT_NAMES).join("; ")}; public and signed-in MCP servers; an A2A endpoint; dev-split environments for verifiers and OpenEnv.` });
  if (BRIEF_MOAT.length) {
    b.push({ kind: "h2", text: "Why it is hard to copy" });
    bullets(BRIEF_MOAT);
  }
  if (BRIEF_ROADMAP.length) {
    b.push({ kind: "h2", text: "Next" });
    bullets(BRIEF_ROADMAP);
  }
  b.push({ kind: "h2", text: "Price and contact" });
  // The price line goes to buyers as it stands: no attribution (coordinator, 29 Oct review).
  b.push({ kind: "p", text: BRIEF_PRICE });
  b.push({ kind: "p", text: `Contact: ${BRIEF_CONTACT}. More under NDA in the data room.` });
  return b;
}

/** The PDF, two A4 pages at most (a test checks it). */
export function briefPdf(d: BriefData, origin: string) {
  const pages = layout(briefBlocks(d, origin), `The Agent Forge buyer brief, built ${d.generated_at.slice(0, 16).replace("T", " ")} UTC - private and confidential`);
  return {
    pages: pages.length,
    bytes: writePdf(pages, { title: "The Agent Forge: buyer brief", author: "The Agent Forge", subject: "Private two-page buyer brief", keywords: "", date: d.generated_at.slice(0, 10) }),
  };
}
