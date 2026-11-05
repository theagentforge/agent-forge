// The tool-selection test (docs/launch/agent-channels.md §4.1): asks the site to run the fixed 30 requests on a Claude
// and a GPT model in slices of 10, then writes the report to the job summary and an issue labelled "report", for Claude
// to commit as docs/reports/tool-selection-<date>.md. The site holds the model key; this script only has its OIDC token.
//   node tool-selection.mjs <site> [sets]
// ADR 0133: `sets` is "after,before" by default: each model runs the live descriptions (after) and the 4 Nov set
// (before) on the same day, so the report shows the change under the same conditions. "after" alone halves the cost.

export const MODELS = ["claude-sonnet-5.5", "gpt-6.1-sol"];
export const SLICES = [[0, 10], [10, 20], [20, 30]];
export const SETS = ["after", "before"];
const OURS = ["forge_check", "forge_traps", "forge_scan", "forge_watch", "arena_results", "forge_exposure"];
/** A run's column label: the model, plus its description set when it has one. */
export const label = (r) => (r.set ? `${r.model} (${r.set})` : r.model);

/** ADR 0133: for each model run on both sets, the change from before to after (accuracy and false triggers). */
export function deltas(runs) {
  const out = [];
  for (const a of runs.filter((r) => r.set === "after")) {
    const b = runs.find((r) => r.set === "before" && r.model === a.model);
    if (!b) continue;
    const sa = score(a.rows), sb = score(b.rows);
    const right = (s) => s.nFit - s.missed - s.wrongTool;
    out.push({ model: a.model, before: { right: right(sb), of: sb.nFit, falseTriggers: sb.falseTriggers }, after: { right: right(sa), of: sa.nFit, falseTriggers: sa.falseTriggers }, accept: right(sa) / Math.max(1, sa.nFit) > right(sb) / Math.max(1, sb.nFit) && sa.falseTriggers <= sb.falseTriggers });
  }
  return out;
}

export function score(rows) {
  const fit = rows.filter((r) => r.expect !== "none" && r.chose !== "error");
  const not = rows.filter((r) => r.expect === "none" && r.chose !== "error");
  return {
    accuracy: fit.length ? fit.filter((r) => r.correct).length / fit.length : null,
    missed: fit.filter((r) => !OURS.includes(r.chose)).length,
    wrongTool: fit.filter((r) => !r.correct && OURS.includes(r.chose)).length,
    falseTriggers: not.filter((r) => !r.correct).length,
    nFit: fit.length,
    nNot: not.length,
    errors: rows.filter((r) => r.chose === "error").length,
  };
}

const pct = (x) => (x === null ? "–" : `${Math.round(x * 100)}%`);

export function report(date, runs) {
  const head = ["| Model | Picked the right tool (of the 20 that fit) | Missed (no Forge tool) | Wrong Forge tool | False triggers (of the 10 that don't fit) | Errors | Cost |", "|---|--:|--:|--:|--:|--:|--:|"];
  const lines = runs.map((r) => {
    const s = score(r.rows);
    return `| ${label(r)} | ${pct(s.accuracy)} (${s.nFit - s.missed - s.wrongTool} of ${s.nFit}) | ${s.missed} | ${s.wrongTool} | ${s.falseTriggers} of ${s.nNot} | ${s.errors} | $${r.cost.toFixed(3)} |`;
  });
  const per = ["| # | Expected | " + runs.map(label).join(" | ") + " |", "|--:|---|" + runs.map(() => "---|").join("")];
  for (let i = 0; i < 30; i++) {
    const cells = runs.map((r) => {
      const row = r.rows.find((x) => x.i === i);
      return row ? `${row.correct ? "✓" : "✗"} ${row.chose}` : "–";
    });
    const exp = runs[0]?.rows.find((x) => x.i === i)?.expect;
    per.push(`| ${i + 1} | ${exp === "none" ? "none of ours" : (exp ?? []).join(" or ")} | ${cells.join(" | ")} |`);
  }
  return [
    `# Tool selection test, ${date}`,
    "",
    "docs/launch/agent-channels.md §4.1. The fixed 30 requests in `apps/forge/src/ops/tool-selection.ts` (20 that fit one of our six `/mcp/public` tools, 10 that fit none), sent to each model through its API with our tools mixed among eight ordinary ones (web search, fetch, read file, shell, npm install, email, weather, create repo). Temperature 0, one call each; the first tool call counts. Descriptions are tuned for accuracy on this set, never for win rate.",
    "",
    ...head,
    ...lines,
    "",
    ...(deltas(runs).length
      ? [
          "## Before → after (ADR 0133: the 4 Nov descriptions, then the structured ones, same day)",
          "",
          ...deltas(runs).map((d) => `- ${d.model}: right tool ${d.before.right} of ${d.before.of} → ${d.after.right} of ${d.after.of}; false triggers ${d.before.falseTriggers} → ${d.after.falseTriggers}. ${d.accept ? "Accuracy rose and false triggers didn't: the change is accepted." : "Accuracy didn't rise, or false triggers rose: the change is not accepted on this run."}`),
          "",
        ]
      : []),
    "## Each request",
    "",
    ...per,
    "",
    "Limits: one run per model, through the API rather than the Claude and ChatGPT apps' own tool search, and the decoys are ours. A change in a description shows here as a change in accuracy or false triggers.",
  ].join("\n");
}

async function oidc(audience) {
  const res = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!res.ok) throw new Error(`no OIDC token (HTTP ${res.status})`);
  return (await res.json()).value;
}

async function main(site, sets) {
  const runs = [];
  for (const model of MODELS) for (const set of sets) {
    const run = { model, set, rows: [], cost: 0 };
    for (const [from, to] of SLICES) {
      const res = await fetch(`${site}/api/v1/ops/tool-selection`, { method: "POST", headers: { Authorization: `Bearer ${await oidc(site)}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, from, to, set }) });
      const r = await res.json();
      if (!res.ok) throw new Error(`${model} ${set} ${from}-${to}: ${JSON.stringify(r)}`);
      run.rows.push(...r.rows);
      run.cost += r.cost;
    }
    runs.push(run);
  }
  const date = new Date().toISOString().slice(0, 10);
  const md = report(date, runs);
  const { appendFile } = await import("node:fs/promises");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  const gh = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ title: `Tool selection test ${date}`, labels: ["report"], body: `${md}\n\n<!-- forge-tool-selection ${JSON.stringify(runs)} -->\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_` }),
  });
  if (!gh.ok) throw new Error(`GitHub issue: HTTP ${gh.status}`);
  console.log(md);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = process.argv[2] ?? "https://theagentforge.io";
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) {
    console.error("site must be https://<host>");
    process.exit(1);
  }
  const sets = (process.argv[3] ?? SETS.join(",")).split(",").map((x) => x.trim()).filter(Boolean);
  if (!sets.length || sets.some((x) => !SETS.includes(x))) {
    console.error("sets must be after, before or after,before");
    process.exit(1);
  }
  main(site, sets).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
