// The weekly "cited in AI search" check (docs/launch/agent-channels.md §4.5): asks the site to put the fixed ten
// questions to a Claude, a GPT and a Perplexity model with web search, then adds one comment to the "AI search
// citations" issue with the score and a forge-citations marker the Monday Ops Digest reads.
//   node citations.mjs <site>

export const MODELS = ["claude", "gpt", "perplexity"];
export const SLICES = [[0, 5], [5, 10]];
export const TITLE = "AI search citations";
export const MARK = /<!-- forge-citations (\{[^}]*\}) -->/;

export function summary(runs) {
  const answered = runs.flatMap((r) => r.rows).filter((x) => x.cited !== null);
  return { cited: answered.filter((x) => x.cited).length, answered: answered.length, asked: runs.reduce((a, r) => a + r.rows.length, 0) };
}

export function comment(date, runs) {
  const s = summary(runs);
  const head = `| # | ${runs.map((r) => r.model).join(" | ")} |\n|--:|${runs.map(() => "---|").join("")}`;
  const lines = Array.from({ length: 10 }, (_, i) => `| ${i + 1} | ${runs.map((r) => { const x = r.rows.find((y) => y.i === i); return !x || x.cited === null ? "error" : x.cited ? "✓ cited" : `– (${x.urls} sources)`; }).join(" | ")} |`);
  const cost = runs.reduce((a, r) => a + r.cost, 0);
  return [
    `AI search citations for ${date}: theagentforge.io cited in **${s.cited} of ${s.answered}** answers (${s.asked - s.answered} failed). Questions are fixed in \`apps/forge/src/ops/citations.ts\`; models with web search through OpenRouter. Cost about $${cost.toFixed(3)}.`,
    "",
    head,
    ...lines,
    "",
    `<!-- forge-citations ${JSON.stringify({ date, ...s })} -->`,
  ].join("\n");
}

async function oidc(audience) {
  const res = await fetch(`${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` } });
  if (!res.ok) throw new Error(`no OIDC token (HTTP ${res.status})`);
  return (await res.json()).value;
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status}`);
  return res.json();
}

async function main(site) {
  const runs = [];
  for (const model of MODELS) {
    const run = { model, rows: [], cost: 0 };
    for (const [from, to] of SLICES) {
      const res = await fetch(`${site}/api/v1/ops/citations`, { method: "POST", headers: { Authorization: `Bearer ${await oidc(site)}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, from, to }) });
      const r = await res.json();
      if (!res.ok) throw new Error(`${model} ${from}-${to}: ${JSON.stringify(r)}`);
      run.rows.push(...r.rows);
      run.cost += r.cost;
    }
    runs.push(run);
  }
  const date = new Date().toISOString().slice(0, 10);
  const found = (await gh("GET", "/issues?state=all&labels=citations&per_page=10")).find((i) => i.title === TITLE && !i.pull_request);
  const issue = found ?? (await gh("POST", "/issues", { title: TITLE, labels: ["citations"], body: "One comment a week: is theagentforge.io cited when AI search answers \"is <skill> safe?\" (docs/launch/agent-channels.md §4.5). Written by .github/workflows/ai-citations.yml." }));
  const body = comment(date, runs);
  await gh("POST", `/issues/${issue.number}/comments`, { body });
  console.log(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const site = process.argv[2] ?? "https://theagentforge.io";
  if (!/^https:\/\/[a-z0-9.-]+$/.test(site)) {
    console.error("site must be https://<host>");
    process.exit(1);
  }
  main(site).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
