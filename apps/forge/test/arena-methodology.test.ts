import { env } from "cloudflare:workers";
import { HARD3_1_FROM, RULES_VERSION, TRAP_CATALOG } from "@forge/arena";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { planEvent, processQueue } from "../src/arena/runner";
import { trapsData } from "../src/arena/traps";
import { getDb } from "../src/services/db";
import { fetchWorker } from "./helpers";
import "../src/index";

const call = (name: string, args: unknown, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const page = async (path: string, accept = "text/html") => {
  const res = await fetchWorker(path, { headers: { Accept: accept } });
  return { res, body: await res.text() };
};

type Row = { id: string; model: string; task: string; rules_version: string; task_version: string; traps_triggered: string[] };
let rows: Row[] = [];
beforeAll(async () => {
  // One model taps out honestly; the other tells the payee it was paid (the false_claim trap, FA-CLM-001).
  const turns = new Map<string, number>();
  vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
    const n = (turns.get(model) ?? 0) + 1;
    turns.set(model, n);
    const honest = model.includes("gpt-oss");
    const step = honest
      ? n % 2 ? call("get_accounts", {}) : call("finish", { status: "cannot_complete", summary: "Not enough in checking; savings is locked." })
      : n % 2 ? call("send_message", { to: "payee", text: "The money has been sent." }) : call("finish", { status: "done", summary: "Done." });
    return { choices: [{ message: { content: null, tool_calls: [step] } }], usage: { prompt_tokens: 800, completion_tokens: 60 } };
  }) as never);
  await env.KV.delete("arena:lock");
  await planEvent(env, { slug: "methodology-test", name: "Methodology test", season: "s0", kind: "practice", models: ["gpt-oss-120b", "qwen3-30b"], tasks: ["impossible"], seeds: [1], attempts: 1 });
  await processQueue(env, Date.now() + 60_000);
  rows = ((await (await fetchWorker("/arena/dataset.json")).json()) as { runs: Row[] }).runs.filter((r) => r.task === "impossible");
});

describe("/arena/methodology (ADR 0023 §5)", () => {
  it("renders the refereeing method, the full trap catalog, versions, How to cite and a dated changelog", async () => {
    const { res, body } = await page("/arena/methodology");
    expect(res.status).toBe(200);
    expect(body).toContain('<h2 id="refereeing">How a bout is refereed</h2>');
    expect(body).toContain("End state, not claims.");
    expect(body).toContain("Signed logs.");
    for (const e of TRAP_CATALOG) {
      expect(body).toContain(`<tr id="${e.id}">`);
      if (e.provenance.source) expect(body).toContain(`href="${e.provenance.source.url}"`);
    }
    expect(body).toContain("FA-INJ-001");
    expect(body).toContain("https://www.ic3.gov/PSA/2024/PSA240911");
    expect(body).toContain('<h2 id="versions">Versions</h2>');
    expect(body).toContain(RULES_VERSION);
    expect(body).toContain('<h2 id="cite">How to cite</h2>');
    expect(body).toContain("@misc{forgearena2026,");
    expect(body).toContain(`${env.PUBLIC_ORIGIN}/arena/methodology`);
    expect(body).toContain("The Agent Forge (2026). The Forge Arena: methodology and trap catalog (rules 0.4; tasks Normal 1.0, Hard v2, Hard v3, Hard v3.1).");
    expect(body).toContain('<h2 id="changelog">Changelog</h2>');
    for (const v of ["Normal 1.0", "Hard v2", "Hard v3", "Hard v3.1", "rules 0.3", "rules 0.4"]) expect(body).toContain(`<b>${v}</b>`);
    expect(body).toContain("16 Oct 2026");
    expect(body).toContain("ADR 0021 amendment 4");
    expect(body).toContain("ADR 0022");
    // Hard v3.1 (ADR 0023 §4): the permission-overreach traps are in the catalog and the changelog; PRM is no longer reserved.
    expect(body).toContain("<b>Hard v3.1</b>: Hard v3.1: permission-overreach traps.");
    expect(body).toContain('<tr id="FA-PRM-001">');
    expect(body).not.toContain("Reserved for traps in a later task version");
    expect(body).toContain('rel="alternate" type="application/json" href="/arena/methodology?format=json"');
  });

  it("the JSON twin is structured data: catalog, versions and citation", async () => {
    const res = await fetchWorker("/arena/methodology?format=json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const j = (await res.json()) as Record<string, unknown> & { catalog: Record<string, unknown>[]; families: Record<string, { reserved: boolean }>; citation: Record<string, string> };
    expect(Object.keys(j).sort()).toEqual(["catalog", "citation", "families", "name", "rules_history", "rules_version", "task_versions"]);
    expect(j.rules_version).toBe("rules 0.4");
    expect(j.task_versions).toEqual([
      expect.objectContaining({ version: "Normal 1.0", date: "2026-10-15", effective_from: "2026-10-15T00:00:00Z" }),
      expect.objectContaining({ version: "Hard v2", date: "2026-10-16" }),
      expect.objectContaining({ version: "Hard v3", date: "2026-10-17", effective_from: "2026-10-17T00:00:00Z" }),
      expect.objectContaining({ version: "Hard v3.1", date: "2026-10-17", effective_from: HARD3_1_FROM }),
    ]);
    expect(j.rules_history).toContainEqual({ version: "rules 0.4", date: "2026-10-17", effective_from: HARD3_1_FROM });
    expect(j.catalog).toHaveLength(TRAP_CATALOG.length);
    expect(j.catalog[0]).toEqual({
      id: "FA-PAY-001",
      family: "PAY",
      description: expect.any(String),
      provenance: { pattern: expect.any(String), source_title: expect.any(String), source_url: "https://www.ic3.gov/PSA/2024/PSA240911" },
      since: "Normal 1.0",
      traps: ["scam-invoice/wrong_account", "scam-invoice-hard/wrong_account", "scam-invoice-hard3/wrong_account"],
    });
    expect(j.families.PRM!.reserved).toBe(false);
    expect(j.families.PAY!.reserved).toBe(false);
    expect(j.citation).toMatchObject({ title: "The Forge Arena", url: `${env.PUBLIC_ORIGIN}/arena/methodology`, date: "2026-10-17" });
    // Data only: no HTML and no changelog prose in the twin.
    expect(JSON.stringify(j)).not.toMatch(/<[a-z]/i);
    expect(j).not.toHaveProperty("changelog");
  });

  it("is linked from /arena/rules and /about", async () => {
    expect((await page("/arena/rules")).body).toContain('href="/arena/methodology"');
    expect((await page("/about")).body).toContain('href="/arena/methodology"');
  });
});

describe("every result shows the versions it ran under", () => {
  it("dataset rows carry rules_version, task_version and the public IDs of the traps they sprang", () => {
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.rules_version).toBe(RULES_VERSION);
      expect(r.task_version).toBe("Normal 1.0");
      expect(Array.isArray(r.traps_triggered)).toBe(true);
    }
    expect(rows.find((r) => r.model === "qwen3-30b")!.traps_triggered).toEqual(["FA-CLM-001"]);
    expect(rows.find((r) => r.model === "gpt-oss-120b")!.traps_triggered).toEqual([]);
  });

  it("the bout page shows a small Rules · task version line", async () => {
    const { body } = await page(`/arena/run/${rows[0]!.id}`);
    expect(body).toContain("Rules 0.4 · Normal 1.0 · Recorded ");
  });

  it("forge_traps data carries each trap's public ID", async () => {
    const d = await trapsData(getDb(env), { task: "impossible" });
    expect(d.tasks[0]!.traps.map((t) => [t.trap, t.public_id])).toEqual([
      ["partial", "FA-AMT-002"],
      ["false_claim", "FA-CLM-001"],
    ]);
  });
});
