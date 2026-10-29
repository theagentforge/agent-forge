import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { osvTransport } from "../src/services/advisories";
import { toolAnswerLine, toolAsOf } from "../src/web/tool-answer";
import { connectAgent, fetchWorker, fp, postReport, report } from "./helpers";
import { fakeOsv } from "./osv-fake";
import "../src/index";

// Citations issue #234: the tool page opens with one dated sentence an answer engine can quote (field reports on the
// exact version, published advisories that match), shows when its data is from and lists its sources. Data only.

const empty = { worked: 0, partial: 0, failed: 0 };
const osv = (total: number, version: string | null = "1.2.0") => ({ source: "osv" as const, ecosystem: "npm" as const, package: "x", version, checked_at: "2026-10-24T08:00:00.000Z", total, advisories: [] });

describe("the tool page's answer line", () => {
  it("says the date, the reports on the version and the advisories that match", () => {
    const at = Date.UTC(2026, 9, 25, 12);
    expect(toolAnswerLine("npm:x", { version: "1.2.0", outcome_breakdown: { worked: 2, partial: 0, failed: 1 }, public_signals_summary: osv(1) }, at)).toBe(
      "As of 25 Oct 2026, 3 field reports on npm:x@1.2.0: 2 worked, 1 failed. 1 published advisory matches.",
    );
    expect(toolAnswerLine("npm:x", { version: "1.2.0", outcome_breakdown: { worked: 1, partial: 0, failed: 0 }, public_signals_summary: osv(0) }, at)).toBe(
      "As of 25 Oct 2026, 1 field report on npm:x@1.2.0: 1 worked. No published advisory matches.",
    );
    expect(toolAnswerLine("npm:x", { version: "1.2.0", outcome_breakdown: { worked: 0, partial: 2, failed: 0 }, public_signals_summary: osv(3, null) }, at)).toBe(
      "As of 25 Oct 2026, 2 field reports on npm:x@1.2.0: 2 partial. 3 published advisories match (any version).",
    );
    expect(toolAnswerLine("github.com/o/r", { version: null, outcome_breakdown: empty, public_signals_summary: null }, at)).toBe(
      "As of 25 Oct 2026, no field reports on github.com/o/r yet. No advisory lookup for this kind of tool (npm and PyPI packages only).",
    );
  });

  it("dates the data by its newest report, status change or advisory check", () => {
    const report = Date.UTC(2026, 9, 20);
    expect(toolAsOf({ version: "1", outcome_breakdown: empty, public_signals_summary: osv(0) }, [report])).toBe(Date.parse("2026-10-24T08:00:00.000Z"));
    expect(toolAsOf({ version: "1", outcome_breakdown: empty, public_signals_summary: null }, [report, 0])).toBe(report);
  });
});

describe("GET /t/<tool>", () => {
  beforeEach(() => {
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
  });
  beforeAll(() => {
    osvTransport.fetch = fakeOsv();
  });

  it("opens with the dated answer, shows dateModified and lists its sources, without changing the verdict", async () => {
    const { token } = await connectAgent();
    vi.spyOn(env.AI, "run").mockImplementation((async () => ({ response: "safe" })) as never);
    const res = await postReport(token, report({ tool: { kind: "mcp_server", id: "npm:lodash", version: "4.17.20", fingerprint: fp("7") } }));
    expect(res.status).toBe(201);
    const body = await (await fetchWorker(`/t/${encodeURIComponent("npm:lodash")}`, { headers: { Accept: "text/html" } })).text();
    expect(body).toMatch(/<p class="lead" id="answer">As of \d{1,2} [A-Z][a-z]{2} \d{4}, 1 field report on npm:lodash@4\.17\.20: 1 worked\. 1 published advisory matches\.<\/p>/);
    expect(body).toMatch(/updated <time datetime="\d{4}-\d{2}-\d{2}T[^"]+">\d{4}-\d{2}-\d{2}<\/time>/);
    const ld = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!)).find((x) => x["@type"] === "WebPage");
    expect(ld.dateModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(ld.abstract).toContain("1 published advisory matches");
    const sources = /<section aria-labelledby="sources">([\s\S]*?)<\/section>/.exec(body)![1]!;
    expect(sources).toContain('href="https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm"');
    expect(sources).toContain("OSV query for npm lodash@4.17.20");
    expect(sources).toContain("1 on v4.17.20, 1 on this page in all");
    // Site audit 29 Oct (§3.12): the verdict once above the fold (the badge and a plain line, no machine verdict box,
    // no "1·0·0"), one primary action, and the API line and confirm/dispute mechanics one click down.
    const top = body.slice(body.indexOf("<main"), body.indexOf('<section aria-labelledby="reports"'));
    expect(top.match(/class="verdict v-/g)).toHaveLength(1);
    expect(top).not.toContain('<pre class="verdict-line">');
    expect(top).not.toMatch(/\d·\d·\d/);
    expect(top).toContain("Used it? File a report</a>");
    expect(top).toMatch(/<div class="verdict-row">.*<span class="small">(\d of 5 people needed for a score, at least 2 of them verified|From \d+ (person|people), \d+ verified)/);
    expect(body).toMatch(/<details class="more" id="for-agents"><summary><span class="more-title">For agents<\/span>/);
    const forAgents = body.slice(body.indexOf('id="for-agents"'));
    expect(forAgents).toContain("/api/v1/check?id=");
    expect(forAgents).toContain("on_report");
    // Data only: the answer line never judges the tool.
    expect(sources + body.match(/id="answer">[^<]*/)![0]).not.toMatch(/\bsafe\b|\bguarantee/i);
  });
});
