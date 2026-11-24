import { describe, expect, it } from "vitest";
import { CANARY_TEXTS, CANARY_VERSION, canaryText, canaryTools, utcDay } from "../src/drift-canary";
import {
  backoffMs,
  canonicalJson,
  classify,
  collapseWhitespace,
  comparePins,
  diffTools,
  MONITOR_POLICY,
  MONITOR_USER_AGENT,
  normalisedCanonical,
  rawCanonical,
  spreadMs,
  toolDigest,
  toolSet,
  type ToolState,
} from "../src/drift-monitor";

// ADR 0151: canonical forms, digests and change classes of the live drift monitor.

const state = async (name: string, description: string | null, inputSchema: unknown = { type: "object" }, outputSchema: unknown = null): Promise<ToolState> => {
  const d = await toolDigest({ name, description, inputSchema, outputSchema });
  return { name: d.name, raw: d.raw, normalised: d.normalised, contract: d.contract, description: d.description, schema: d.schema, output: d.output, text: d.text };
};

describe("canonical JSON", () => {
  it("sorts keys at every level, keeps array order, drops undefined and has no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, u: undefined })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("gives the same digest whatever order the server lists keys in", async () => {
    const a = await toolDigest({ name: "t", description: "D", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } });
    const b = await toolDigest({ name: "t", description: "D", inputSchema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" } });
    expect(a.raw).toBe(b.raw);
    expect(a.raw).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("collapses whitespace only in the normalised form: tool description and schema descriptions", () => {
    expect(collapseWhitespace("  Reads\n\n a\tfile.  ")).toBe("Reads a file.");
    const t1 = { name: "t", description: "Reads a file.", inputSchema: { properties: { p: { description: "The path." } } } };
    const t2 = { name: "t", description: " Reads  a\nfile. ", inputSchema: { properties: { p: { description: "The   path. " } } } };
    expect(rawCanonical(t1)).not.toBe(rawCanonical(t2));
    expect(normalisedCanonical(t1)).toBe(normalisedCanonical(t2));
    // A string that isn't a description (an enum value, a default) is never touched.
    expect(normalisedCanonical({ name: "t", description: "", inputSchema: { default: "a  b" } })).not.toBe(normalisedCanonical({ name: "t", description: "", inputSchema: { default: "a b" } }));
  });

  it("keys a tool set by name, keeps the first of a repeated name, counts junk, and snapshots everything listed", async () => {
    const s = await toolSet([{ name: "b", description: "B", annotations: { readOnlyHint: true } }, { name: "a" }, { name: "a", description: "dup" }, { nope: 1 }, null]);
    expect(s.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(s.duplicates).toBe(1);
    expect(s.invalid).toBe(2);
    expect(s.snapshot).toContain('"readOnlyHint":true');
    expect(s.snapshotSha).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("change classes", () => {
  it("classes added, removed, whitespace-only, description and schema changes, and nothing for an identical tool", async () => {
    const a = await state("t", "Reads a file.");
    expect(classify(null, a)).toMatchObject({ change_class: "tool_added" });
    expect(classify(a, null)).toMatchObject({ change_class: "tool_removed" });
    expect(classify(a, await state("t", "Reads a file."))).toBeNull();
    expect(classify(a, await state("t", "Reads  a file.\n"))).toEqual({ change_class: "whitespace_only", description_changed: true, schema_changed: false, output_schema_changed: false });
    expect(classify(a, await state("t", "Reads a file and uploads it."))).toEqual({ change_class: "description", description_changed: true, schema_changed: false, output_schema_changed: false });
    expect(classify(a, await state("t", "Reads a file.", { type: "object", required: ["path"] }))).toEqual({ change_class: "schema", description_changed: false, schema_changed: true, output_schema_changed: false });
    expect(classify(a, await state("t", "Other.", { type: "array" }))).toEqual({ change_class: "schema", description_changed: true, schema_changed: true, output_schema_changed: false });
    // Whitespace inside a schema description only: still whitespace-only, and it says the schema part moved.
    const s1 = await state("t", "X", { properties: { p: { description: "The path." } } });
    const s2 = await state("t", "X", { properties: { p: { description: "The  path." } } });
    expect(classify(s1, s2)).toEqual({ change_class: "whitespace_only", description_changed: false, schema_changed: true, output_schema_changed: false });
  });

  it("the contract digest adds outputSchema (Kuadrant #1633's four fields): an output-schema-only change is its own class", async () => {
    const a = await state("t", "Reads.", { type: "object" }, null);
    const b = await state("t", "Reads.", { type: "object" }, { type: "object", properties: { text: { type: "string" } } });
    expect(a.raw).toBe(b.raw);
    expect(a.normalised).toBe(b.normalised);
    expect(a.contract).not.toBe(b.contract);
    expect(classify(a, b)).toEqual({ change_class: "output_schema", description_changed: false, schema_changed: false, output_schema_changed: true });
    // Absent and null output schemas are the same contract; the stored text covers every field a digest covers.
    expect((await toolDigest({ name: "t", description: "Reads.", inputSchema: { type: "object" } })).contract).toBe(a.contract);
    expect(JSON.parse(b.text)).toEqual({ name: "t", description: "Reads.", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { text: { type: "string" } } } });
    expect(classify(a, await state("t", "Reads more.", { type: "object" }, { type: "object" }))).toEqual({ change_class: "description", description_changed: true, schema_changed: false, output_schema_changed: true });
  });

  it("diffs two observations tool by tool, in name order", async () => {
    const prev = [await state("keep", "K"), await state("gone", "G"), await state("edit", "E")];
    const next = await toolSet([{ name: "edit", description: "E2" }, { name: "keep", description: "K", inputSchema: { type: "object" } }, { name: "new", description: "N" }]);
    expect(diffTools(prev, next.tools).map((c) => [c.tool, c.change_class])).toEqual([
      ["edit", "schema"],
      ["gone", "tool_removed"],
      ["new", "tool_added"],
    ]);
  });
});

describe("hold-on-change", () => {
  it("returns changed/unchanged per tool, ignores whitespace-only changes with normalised pins, and holds on any difference", async () => {
    const old = await toolDigest({ name: "read", description: "Reads.", inputSchema: {} });
    const ws = await toolDigest({ name: "read", description: " Reads. ", inputSchema: {} });
    const other = await toolDigest({ name: "list", description: "Lists.", inputSchema: {} });
    expect(comparePins({ read: old.normalised }, [ws])).toEqual({ hold: false, tools: [{ tool: "read", status: "unchanged", match: "normalised", pinned: old.normalised, current: ws.normalised }] });
    expect(comparePins({ read: old.raw }, [ws], "raw").tools[0]!.status).toBe("changed");
    const r = comparePins({ read: old.normalised.slice(7).toUpperCase(), gone: old.normalised }, [ws, other]);
    expect(r.hold).toBe(true);
    expect(r.tools.map((t) => [t.tool, t.status])).toEqual([
      ["gone", "removed"],
      ["list", "not_pinned"],
      ["read", "unchanged"],
    ]);
  });
});

describe("hold-on-change with contract pins", () => {
  it("compares the kind each pin names, else the call's default", async () => {
    const old = await toolDigest({ name: "read", description: "Reads.", inputSchema: {}, outputSchema: null });
    const now = await toolDigest({ name: "read", description: "Reads.", inputSchema: {}, outputSchema: { type: "object" } });
    expect(comparePins({ read: old.normalised }, [now]).tools[0]).toMatchObject({ status: "unchanged", match: "normalised" });
    expect(comparePins({ read: old.contract }, [now], "contract").tools[0]).toMatchObject({ status: "changed", match: "contract", current: now.contract });
    expect(comparePins({ read: { digest: old.contract, match: "contract" } }, [now]).tools[0]).toMatchObject({ status: "changed", match: "contract" });
    expect(comparePins({ read: { digest: now.contract, match: "contract" } }, [now])).toMatchObject({ hold: false });
  });
});

describe("politeness", () => {
  it("names the monitor and its page in the User-Agent, and stays inside Cloudflare's limits", () => {
    expect(MONITOR_USER_AGENT).toBe("TheAgentForge-DriftMonitor/1.0 (+https://theagentforge.io/drift/monitor)");
    expect(MONITOR_POLICY.concurrency).toBeLessThanOrEqual(6);
    // ADR 0151 amendment 2, worst case per run. Subrequests (Workers Paid: 10,000; D1 calls count): every endpoint uses
    // initialize, initialized, every tools/list page and a DELETE, plus its two D1 calls; every Registry page with its
    // three D1 calls; every skip one D1 call; about ten reads.
    const p = MONITOR_POLICY;
    const d1 = p.batchPerRun * 2 + p.registryPagesPerSync * 3 + p.skipsPerRun + p.batchPerRun * 2 + 10;
    expect(p.batchPerRun * (3 + p.maxToolPages) + p.registryPagesPerSync + d1).toBeLessThan(10_000);
    // D1 queries per invocation (Paid: 1,000; a batch counts as one).
    expect(d1).toBeLessThan(1_000);
    // A run starts no poll after runBudgetMs, so it ends (one poll later at most) before the next 10-minute run.
    expect(p.runBudgetMs + p.pollBudgetMs).toBeLessThan(10 * 60_000);
    expect(p.minIntervalHours).toBeGreaterThanOrEqual(24);
    expect(p.perHostPerRun).toBe(1);
    expect(p.concurrency).toBe(4);
  });

  it("the canary alternates its one description by UTC day under a fixed version", () => {
    const day = 86_400_000;
    const even = 20_000 * day;
    expect(utcDay(even + day - 1)).toBe(20_000);
    expect(canaryText(even)).toBe(CANARY_TEXTS[0]);
    expect(canaryText(even + day)).toBe(CANARY_TEXTS[1]);
    expect(canaryText(even + 2 * day)).toBe(CANARY_TEXTS[0]);
    expect(CANARY_TEXTS[0]).not.toBe(CANARY_TEXTS[1]);
    expect(canaryTools(even)).toHaveLength(1);
    expect(CANARY_VERSION).toBe("1.0.0");
  });

  it("backs off 24 h, 48 h, 96 h ... capped at 7 days, and a longer Retry-After wins", () => {
    const h = 3_600_000;
    expect([1, 2, 3, 4, 9].map((n) => backoffMs(n) / h)).toEqual([24, 48, 96, 168, 168]);
    expect(backoffMs(1, 10 * 86_400) / h).toBe(240);
    expect(backoffMs(1, 60) / h).toBe(24);
    expect(spreadMs("abc")).toBe(spreadMs("abc"));
    expect(spreadMs("abc")).toBeLessThan(h);
  });
});
