import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { BizCell } from "../src/arena/business";
import { HOUSE_METHOD_ANCHOR, HOUSE_METHOD_PATH } from "../src/services/site-pulse";
import { modelsLine } from "../src/web/security";
import { toolAnswerLine } from "../src/web/tool-answer";
import { fetchWorker } from "./helpers";
import "../src/index";

// Review of the site audit batches A-D (ADR 0118): the fixes an independent review made, each with its guard.
const page = async (path: string) => (await fetchWorker(path, { headers: { Accept: "text/html" } })).text();
const str = async (h: unknown) => String(await h);
const cell = (breaks: number, n: number, o: Partial<BizCell> = {}): BizCell =>
  ({ n, shown: true, breaks, rate: breaks / n, ci: [0, 1], early: false, topTrap: null, knockouts: 0, replays: [], ...o }) as BizCell;

describe("/security keeps the spread between models visible while the table is folded", () => {
  it("names the highest and lowest shown rates with their counts", async () => {
    const line = await str(modelsLine([{ name: "Low", cell: cell(0, 20) }, { name: "High", cell: cell(8, 20) }, { name: "Mid", cell: cell(3, 20) }]));
    expect(line).toBe("<p data-models-line>Highest: <b>High</b>, 40% (8 of 20). Lowest: <b>Low</b>, 0% (0 of 20).</p>");
  });
  it("never names a model without enough attempts, and marks early reads", async () => {
    const hidden = { name: "Few", cell: cell(0, 2, { shown: false, breaks: null, rate: null, ci: null }) };
    expect(await str(modelsLine([hidden]))).toBe("");
    const one = await str(modelsLine([hidden, { name: "Only", cell: cell(2, 5, { early: true }) }]));
    expect(one).toBe("<p data-models-line>Only one model has enough attempts for a rate: <b>Only</b>, 40% (2 of 5, early read).</p>");
    expect(one).not.toContain("Few");
  });
  it("says so when every shown model fell at the same rate", async () => {
    expect(await str(modelsLine([{ name: "A", cell: cell(0, 10) }, { name: "B", cell: cell(0, 12) }]))).toBe(
      "<p data-models-line>All 2 models with enough attempts for a rate fell at the same rate: 0%.</p>",
    );
  });
});

describe("/methodology after the folds", () => {
  it("keeps #house-install-tests outside the fold, so every 'mostly our House install tests' link lands on a visible heading", async () => {
    const body = await page("/methodology");
    const at = body.indexOf(`<h3 id="${HOUSE_METHOD_ANCHOR}">`);
    expect(at).toBeGreaterThan(0);
    // The heading is not inside a <details>: every <details> opened before it is closed before it.
    const before = body.slice(0, at);
    expect(before.split("<details").length).toBe(before.split("</details>").length);
    // The sentence under it reads on its own (it used to start "So", left over from the paragraph above it).
    expect(body).toContain("<p>House reports measure install compatibility");
    expect(body).not.toContain("<p>So House reports");
    // The old #public-numbers anchor still lands on the renamed section.
    expect(body).toMatch(/<h2 id="counting"><span id="public-numbers"><\/span>Public numbers/);
    for (const path of ["/stats", "/dataset"]) expect(await page(path), path).toContain(`href="${HOUSE_METHOD_PATH}"`);
  });
});

describe("folded sections and themes", () => {
  it("site.js opens a folded section when a link targets something inside it", async () => {
    const js = await (await env.ASSETS.fetch("https://assets.local/site.js")).text();
    expect(js).toContain('var d = el.closest("details")');
    expect(js).toContain('window.addEventListener("hashchange", reveal);');
  });
  it("the replay terminal keeps its dark text tokens in the light theme (WCAG AA on its near-black panel)", async () => {
    const css = (await (await env.ASSETS.fetch("https://assets.local/site.css")).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    const block = /(^|\})\.gx-term\{([^}]*)\}/m.exec(css)?.[2] ?? "";
    expect(block).toContain("background:#05070a");
    for (const d of ["--text:#E8ECF1", "--text-muted:#9AA5B4", "--brand:#4AA8FF"]) expect(block).toContain(d);
  });
});

describe("the tool page's answer line", () => {
  it("doesn't say an npm or PyPI package has no advisory lookup when the lookup just didn't answer", () => {
    const at = Date.UTC(2026, 9, 25, 12);
    const none = { worked: 0, partial: 0, failed: 0 };
    expect(toolAnswerLine("npm:x", { version: "1.0.0", outcome_breakdown: none, public_signals_summary: null }, at)).toBe(
      "As of 25 Oct 2026, no field reports on npm:x@1.0.0 yet. The advisory lookup didn't answer this time, so advisories aren't shown.",
    );
    expect(toolAnswerLine("pypi:y", { version: null, outcome_breakdown: none, public_signals_summary: null }, at)).toContain("didn't answer this time");
    expect(toolAnswerLine("github.com/o/r", { version: null, outcome_breakdown: none, public_signals_summary: null }, at)).toContain("No advisory lookup for this kind of tool");
  });
});
