// Daily Ops Digest (MASTER_PLAN §7.5): reads the public /stats JSON and opens one GitHub issue with the numbers, so
// they reach Dinike's phone. Closes the previous digest. Usage: node digest.mjs https://theagentforge.io
import { gatherSocial, learning, learningSection } from "./learning.mjs";
import { scoutSection } from "./scout.mjs";
const LABELS = [
  ["weekly_reporting_agents", "Agents that reported this week (north star)"],
  ["verified_humans", "Verified people"],
  ["humans", "People signed in"],
  ["agents", "Agents connected"],
  ["reports", "Field reports"],
  ["check_sources", "Distinct sources that checked a tool today"],
  ["plugin_check_sources", "…through the Claude Code plugin"],
  ["cli_check_sources", "…through the CLI"],
  ["ci_check_sources", "…through the GitHub Action"],
  ["tools_with_score", "Tools with a public Forge Score"],
];

const n = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");

/** One line on Arena spend (ADR 0015); null when the status endpoint isn't available. */
export function arenaLine(a) {
  if (!a?.spend) return null;
  const s = a.spend;
  const q = a.queue ?? {};
  const rel = (a.new_releases ?? []).map((m) => m.name).slice(0, 5);
  return `Arena: **$${s.month.toFixed(2)}** of $${s.monthCap.toFixed(2)} this month${s.alert ? " ⚠️ over 80%" : ""}. Practice today: $${s.practiceToday.toFixed(3)}. Runs queued ${q.queued ?? 0}, done ${q.done ?? 0}, void ${q.void ?? 0}.${rel.length ? ` New models this week: ${rel.join(", ")}.` : ""}`;
}

/** ADR 0011 leading indicators that the site counts; null when the endpoint isn't available. */
export function growthLine(g) {
  if (!g) return null;
  const home = g.home_clickins_7d === undefined ? "" : ` Home page click-ins to the Arena (ADR 0016): **${g.home_clickins_yesterday}** yesterday, **${g.home_clickins_7d}** this week (compare with home views in Cloudflare Web Analytics).`;
  const card = g.trap_card_copies_7d === undefined ? "" : ` Trap card this week: **${g.trap_card_copies_7d}** copies, **${g.trap_card_downloads_7d}** downloads.`;
  const mcp = g.mcp_sessions_7d === undefined ? "" : ` AI connections this week: **${g.mcp_sessions_7d}** (${g.mcp_sessions_signed_in_7d} signed in), **${g.mcp_tool_calls_7d}** tool calls.`;
  const fmt = (xs) => xs.map((x) => `${x.name} ${x.n}`).join(", ");
  const gross = g.page_views_7d ? ` Page views this week, crawlers included: **${g.page_views_7d}** (crawlers ${g.crawler_page_views_7d ?? 0}).` : "";
  const arrivals = g.arrivals_7d === undefined ? gross : `${gross} People arriving this week: **${g.arrivals_7d}**${g.arrivals_by_source_7d?.length ? ` (${fmt(g.arrivals_by_source_7d)})` : ""}${g.arrivals_by_tag_7d?.length ? `; by link tag: ${fmt(g.arrivals_by_tag_7d)}` : ""}.`;
  const skills = g.skill_scans_7d === undefined ? "" : ` Skill checks this week (ADR 0026): **${g.skill_scans_7d}** scans (web ${g.skill_scans_by_channel_7d?.web ?? 0}, API ${g.skill_scans_by_channel_7d?.api ?? 0}, AI apps ${g.skill_scans_by_channel_7d?.mcp ?? 0}, other agents ${g.skill_scans_by_channel_7d?.a2a ?? 0}; ${g.skill_scans_flagged_7d} flagged), **${g.skill_file_agent_fetches_7d}** agent fetches of /skill.md, **${g.watch_checkins_7d}** weekly-watch check-ins.${g.a2a_requests_7d ? ` Other agents asked over A2A **${g.a2a_requests_7d}** times (check ${g.a2a_by_skill_7d?.check_tool ?? 0}, scan ${g.a2a_by_skill_7d?.scan_skill ?? 0}, trap card ${g.a2a_by_skill_7d?.trap_card ?? 0}, Arena results ${g.a2a_by_skill_7d?.arena_results ?? 0}).` : ""}`;
  return `Growth signals: **${g.claims}** tool claims (${g.claims_verified} verified), Forge badges shown on **${g.badge_sites_7d}** outside sites this week.${skills}${home}${card}${mcp}${arrivals}`;
}

/** AI agent traffic (agent-channels §4.5), and the latest weekly "cited in AI search" score; null when there's nothing. */
export function agentLine(g, citations = null) {
  const parts = [];
  const fmt = (x) => Object.entries(x?.by_agent ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  if (g?.ai_indexers_7d) parts.push(`AI search indexers **${g.ai_indexers_7d.total}**${fmt(g.ai_indexers_7d) ? ` (${fmt(g.ai_indexers_7d)})` : ""}`);
  if (g?.ai_live_fetches_7d) parts.push(`live AI fetches for a person **${g.ai_live_fetches_7d.total}**${fmt(g.ai_live_fetches_7d) ? ` (${fmt(g.ai_live_fetches_7d)})` : ""}, answer pages ${g.ai_live_fetches_7d.by_page?.tools ?? 0}`);
  if (g?.ai_coding_agents_7d) parts.push(`coding agents **${g.ai_coding_agents_7d.total}**${fmt(g.ai_coding_agents_7d) ? ` (${fmt(g.ai_coding_agents_7d)})` : ""}`);
  if (!parts.length && !citations) return null;
  const cite = citations ? ` Cited in AI search on ${citations.date}: **${citations.cited} of ${citations.answered}** answers.` : "";
  return `Agents this week: ${parts.join("; ") || "none counted yet"}.${cite}`;
}

const FUNNEL = [
  ["found", "found us"],
  ["connected", "connected"],
  ["used", "used a tool"],
  ["returned", "came back"],
  ["contributed", "contributed"],
];

/**
 * The agent funnel with exact numbers (apps/forge/src/services/agent-funnel.ts): yesterday and the last 7 days, each
 * step with its share of the step before. House agents and directory health checks are already left out.
 */
export function funnelLine(g) {
  const f = g?.agent_funnel_7d;
  if (!f?.stages) return null;
  const y = g.agent_funnel_yesterday;
  const steps = FUNNEL.map(([k, label]) => {
    const rate = f.rates?.[k];
    return `${label} **${n(f.stages[k])}**${y ? ` (yesterday ${n(y[k])})` : ""}${typeof rate === "number" ? `, ${rate}% of the step before` : ""}`;
  });
  // ADR 0050: the honest demand number, and monitors and catalogs on their own line (coverage, not demand).
  const d = f.detail ?? {};
  const outside =
    typeof d.outside_tool_calls === "number"
      ? ` Tool calls from outside clients: **${n(d.outside_tool_calls)}**${typeof g.outside_tool_calls_yesterday === "number" ? ` (yesterday ${n(g.outside_tool_calls_yesterday)})` : ""}.`
      : "";
  const mc = d.monitors_and_catalogs;
  const monitors = mc ? ` Monitors and catalogs: ${n(mc.sessions)} sessions, ${n(mc.calls)} calls (${n(mc.clients)} names), not counted as demand.` : "";
  return `AI agents using the Forge, last 7 days: ${steps.join(" → ")}.${outside} Signed-in outside agents, all time: **${n(f.signed_in_agents_all_time)}**.${monitors} Left out: ${n(d.directory_health_checks ?? 0)} directory health checks${typeof d.monitor_sessions === "number" ? `, ${n(d.monitor_sessions)} monitor sessions` : ""}, ${n(d.house_mcp_sessions ?? 0)} House sessions.`;
}

/** Weekly (Mondays): one `arena` issue listing notable new models, so a session can schedule a guest bout. */
export function releaseIssue(a, date) {
  const rel = a?.new_releases ?? [];
  if (!rel.length || new Date(`${date}T00:00:00Z`).getUTCDay() !== 1) return null;
  return {
    title: `Arena: new models to consider (${date})`,
    labels: ["arena"],
    body: [
      "Tool-capable models from the big labs added to OpenRouter in the last 8 days (list prices, $ per million tokens in / out):",
      "",
      ...rel.map((m) => `- \`${m.id}\` (${m.name}): $${m.in} / $${m.out}`),
      "",
      "A Claude session decides whether one gets a guest bout within the monthly budget (ADR 0014 §10), adds it to the lineup with a pinned provider, and schedules it.",
      "",
      "---",
      "_Generated by [Claude Code](https://claude.ai/code)_",
    ].join("\n"),
  };
}

/** The issue body. `history` is /stats' daily snapshots; yesterday's external value gives the change. */
/**
 * The growth KPIs (ADR 0039) from the latest Forge Scout snapshot: the north star first, then each KPI with its
 * status against the first and second targets. Internal (the digest is a private issue).
 */
export function kpiLine(k) {
  if (!k?.kpis?.length) return null;
  const n = (x) => (x === null || x === undefined ? "–" : Number(x).toLocaleString("en-US"));
  const label = { below: "below", first: "first target met", second: "second target met", untracked: "parked" };
  const north = k.kpis.find((x) => x.id === "north_star");
  const change = north?.detail?.change_pct;
  const head = north
    ? `**North star: ${n(north.value)} agent-days** in the 7 days to ${k.as_of}${typeof change === "number" ? ` (${change >= 0 ? "+" : ""}${change}% on the week before)` : ""}; targets ${n(north.first)} / ${n(north.second)}.`
    : "**Growth KPIs:**";
  const rows = k.kpis
    .filter((x) => x.id !== "north_star")
    .map((x) => `| ${x.name} | ${n(x.value)} ${x.unit} | ${n(x.first)} | ${n(x.second)} | ${label[x.status] ?? x.status} |`);
  return [head, "", "| KPI | Now | First target | Second target | Status |", "|---|---|---|---|---|", ...rows].join("\n");
}

export function render(stats, date, arena = null, growth = null, learningText = null, citations = null, scoutText = null, kpis = null) {
  const prev = new Map();
  const days = [...new Set((stats.history ?? []).map((h) => h.date))].sort();
  const before = days.at(-2);
  for (const h of stats.history ?? []) if (h.date === before) prev.set(h.metric, h.externalValue);
  const rows = LABELS.map(([k, label]) => {
    const v = stats.now?.[k] ?? { external: null, house: null };
    const p = prev.get(k);
    const change = typeof v.external === "number" && typeof p === "number" ? (v.external - p >= 0 ? `+${v.external - p}` : `${v.external - p}`) : "";
    // ADR 0023 §3: /stats leaves out numbers below their minimum, so the digest says so instead of guessing.
    const ext = v.below_minimum ? `under ${v.minimum}` : `**${n(v.external)}**`;
    return `| ${label} | ${ext} ${change ? `(${change})` : ""} | ${n(v.house)} |`;
  });
  const downloads = (stats.history ?? []).filter((h) => h.metric === "cli_npm_downloads" && typeof h.externalValue === "number").at(-1);
  return [
    `Numbers for ${date}. **External** is people outside the project, the only numbers that count as proof. **House** is our own test agents.`,
    "",
    ...(kpiLine(kpis) ? [kpiLine(kpis), ""] : []),
    "| | External | House |",
    "|---|---|---|",
    ...rows,
    "",
    downloads ? `CLI downloads on ${downloads.date}: **${n(downloads.externalValue)}**.` : "CLI downloads: not recorded yet.",
    "",
    ...(growthLine(growth) ? [growthLine(growth), ""] : []),
    ...(funnelLine(growth) ? [funnelLine(growth), ""] : []),
    ...(agentLine(growth, citations) ? [agentLine(growth, citations), ""] : []),
    ...(arenaLine(arena) ? [arenaLine(arena), ""] : []),
    ...(learningText ? [learningText, ""] : []),
    ...(scoutText ? [scoutText, ""] : []),
    "Live page: https://theagentforge.io/stats",
    "",
    "---",
    "_Generated by [Claude Code](https://claude.ai/code)_",
  ].join("\n");
}

async function gh(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`);
  return res.json();
}

async function latestKpis(now) {
  for (const back of [0, 1, 2]) {
    const d = new Date(now - back * 86_400_000).toISOString().slice(0, 10);
    // Raw media type: snapshots can pass the contents API's 1 MB inline limit.
    const res = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/scout/${d}.json?ref=scout-data`, {
      headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github.raw+json" },
    });
    if (!res.ok) continue;
    const k = (await res.json())?.sources?.ours?.scout_signals?.kpis;
    if (k?.kpis?.length) return k;
  }
  return null;
}

async function main() {
  const origin = process.argv[2] ?? "https://theagentforge.io";
  const res = await fetch(`${origin}/stats?format=json`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`stats ${res.status}`);
  const stats = await res.json();
  const date = new Date().toISOString().slice(0, 10);
  const arena = await fetch(`${origin}/api/v1/arena/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const growth = await fetch(`${origin}/api/v1/growth`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // Mondays: the weekly learning report on X posts (social strategy §9.9). A failure here never stops the digest.
  const now = Date.now();
  const learningText =
    new Date(now).getUTCDay() === 1
      ? await gatherSocial(gh, now)
          .then((d) => learningSection(learning({ ...d, tags: growth?.arrivals_by_tag_7d ?? [], now })))
          .catch((e) => `**Weekly learning report (X):** not available today (${e.message}).`)
      : null;
  // The latest weekly AI-search citation score (ai-citations.yml), read from its tracking issue's last comment.
  const citations = await gh("GET", "/issues?state=all&labels=citations&per_page=5")
    .then(async (list) => {
      const it = list.find((i) => i.title === "AI search citations");
      if (!it) return null;
      const cs = await gh("GET", `/issues/${it.number}/comments?per_page=100`);
      const m = cs.map((x) => /<!-- forge-citations (\{[^}]*\}) -->/.exec(x.body ?? "")).filter(Boolean).at(-1);
      return m ? JSON.parse(m[1]) : null;
    })
    .catch(() => null);
  // Forge Scout (ADR 0031): alarms every day, the weekly numbers on Mondays. A failure here never stops the digest.
  const since = new Date(now - 40 * 86_400_000).toISOString();
  const scoutText = await Promise.all([
    gh("GET", "/issues?state=all&labels=brief&per_page=5"),
    gh("GET", `/issues?state=all&labels=proposal&per_page=100&since=${since}`),
    gh("GET", `/issues?state=all&labels=agent-reach&per_page=100&since=${since}`),
  ])
    .then(([briefs, a, b]) => scoutSection({ briefs, proposals: [...a, ...b.filter((x) => !a.some((y) => y.number === x.number))], now }))
    .catch((e) => `Forge Scout checks: not available today (${e.message}).`);
  // The growth KPIs from the newest Forge Scout snapshot (scout-data branch); yesterday's if today's isn't in yet.
  const kpis = await latestKpis(now).catch(() => null);
  const old = await gh("GET", "/issues?state=open&labels=ops-digest&per_page=10");
  const issue = await gh("POST", "/issues", { title: `Ops Digest ${date}`, body: render(stats, date, arena, growth, learningText, citations, scoutText, kpis), labels: ["ops-digest"] });
  const rel = releaseIssue(arena, date);
  if (rel) await gh("POST", "/issues", rel);
  // Money rule: at 80% of the Arena budget, ask Dinike once a month (ADR 0012 §2).
  if (arena?.spend?.alert) {
    const title = `Arena budget at 80% (${date.slice(0, 7)})`;
    const open = await gh("GET", "/issues?state=all&labels=needs-dinike&per_page=50");
    if (!open.some((i) => i.title === title))
      await gh("POST", "/issues", {
        title,
        labels: ["needs-dinike"],
        body: `${arenaLine(arena)}\n\nThe runner stops by itself at $${arena.spend.monthCap.toFixed(2)}. Reply here: raise the budget for this month, or let it stop.\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`,
      });
  }
  for (const o of old) if (o.number !== issue.number) await gh("PATCH", `/issues/${o.number}`, { state: "closed", state_reason: "completed" });
  console.log(`Opened #${issue.number}`);
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
