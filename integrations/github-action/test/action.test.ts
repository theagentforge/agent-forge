import { describe, expect, it } from "vitest";
import { dedupe, parseJsonc, serversIn, serverTarget, toolTarget } from "../src/discover";
import { checkHeaders, readInputs, run, type Inputs, type Io } from "../src/run";
import { AGENT_DIRECTED } from "../../../apps/forge/test/wording";

describe("discover", () => {
  it("reads JSON with comments and trailing commas, leaving strings alone", () => {
    expect(parseJsonc(`{ // hi\n "a": "http://x//y", /* c */ "b": [1,2,], }`)).toEqual({ a: "http://x//y", b: [1, 2] });
  });

  it("maps npx, pnpm dlx and Windows cmd wrappers to npm ids", () => {
    expect(serverTarget({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github@1.2.3"] })).toEqual({ query: { id: "npm:@modelcontextprotocol/server-github" } });
    expect(serverTarget({ command: "pnpm", args: ["dlx", "some-mcp"] })).toEqual({ query: { id: "npm:some-mcp" } });
    expect(serverTarget({ command: "cmd", args: ["/c", "npx", "-y", "win-mcp"] })).toEqual({ query: { id: "npm:win-mcp" } });
    expect(serverTarget({ command: "/usr/local/bin/npx", args: ["abs-mcp"] })).toEqual({ query: { id: "npm:abs-mcp" } });
  });

  it("maps remote servers to a url query and skips local or unknown ones with a reason", () => {
    expect(serverTarget({ type: "http", url: "https://mcp.example.com/mcp/?x=1" })).toEqual({ query: { url: "https://mcp.example.com/mcp" } });
    expect(serverTarget({ url: "http://localhost:3000/mcp" })).toEqual({ reason: "local server" });
    expect(serverTarget({ url: "${env:URL}" })).toEqual({ reason: "URL uses a variable or isn't valid" });
    expect(serverTarget({ command: "uvx", args: ["mcp-server-git"] })).toMatchObject({ reason: expect.stringContaining("Python") });
    expect(serverTarget({ command: "docker", args: ["run", "x"] })).toMatchObject({ reason: expect.stringContaining("container") });
    expect(serverTarget({ command: "node", args: ["./server.js"] })).toEqual({ reason: "local command" });
  });

  it("reads mcpServers and VS Code's servers block", () => {
    const r = serversIn(".vscode/mcp.json", { servers: { gh: { command: "npx", args: ["gh-mcp"] }, local: { command: "node", args: ["s.js"] } } });
    expect(r.found).toEqual([{ query: { id: "npm:gh-mcp" }, source: ".vscode/mcp.json › gh" }]);
    expect(r.skipped).toEqual([{ source: ".vscode/mcp.json › local", reason: "local command" }]);
  });

  it("parses hand-listed tools like the CLI and dedupes across files", () => {
    expect(toolTarget("Left-Pad")).toEqual({ id: "npm:left-pad" });
    expect(toolTarget("github.com/a/b")).toEqual({ id: "github.com/a/b" });
    expect(toolTarget("# comment")).toBeNull();
    const d = dedupe([
      { query: { id: "npm:x" }, source: "a" },
      { query: { id: "npm:x" }, source: "b" },
    ]);
    expect(d).toEqual([{ query: { id: "npm:x" }, source: "a; b" }]);
  });
});

describe("inputs", () => {
  it("uses defaults and validates fail-on and origin", () => {
    const i = readInputs({ "INPUT_TOOLS": "npm:a\nnpm:b, npm:c" }) as Inputs;
    expect(i.tools).toEqual(["npm:a", "npm:b", "npm:c"]);
    expect(i.failOn).toBe("flagged");
    expect(i.configs).toContain(".mcp.json");
    expect(readInputs({ "INPUT_FAIL-ON": "sometimes" })).toMatch(/fail-on/);
    expect(readInputs({ INPUT_ORIGIN: "http://evil.example" })).toMatch(/https/);
  });

  it("tags checks as internal only in our own repositories (K7)", () => {
    expect((readInputs({ GITHUB_REPOSITORY: "someone/app" }) as Inputs).internal).toBe(false);
    expect((readInputs({}) as Inputs).internal).toBe(false);
    expect((readInputs({ GITHUB_REPOSITORY_OWNER: "theagentforge", GITHUB_REPOSITORY: "theagentforge/forge" }) as Inputs).internal).toBe(true);
    expect((readInputs({ GITHUB_REPOSITORY: "TheAgentForge/agent-forge" }) as Inputs).internal).toBe(true);
    expect(checkHeaders(false)).toEqual({ Accept: "application/json", "User-Agent": "theagentforge-action/1" });
    expect(checkHeaders(true)).toMatchObject({ "X-Forge-Internal": "action", "User-Agent": expect.stringMatching(/^theagentforge-action\/1 theagentforge-internal\/action$/) });
  });
});

const result = (over: Record<string, unknown>) => ({
  known: true,
  tool: { id: "npm:x" },
  version: "1.0.0",
  forge_score: 80,
  distinct_owners: 6,
  verified_owners: 6,
  security_status: "clear",
  page_url: "https://theagentforge.io/tools/npm%3Ax",
  ...over,
});

function harness(files: Record<string, string>, answers: Record<string, unknown | number>) {
  const log: string[] = [];
  const commands: string[] = [];
  const outputs: Record<string, string> = {};
  const urls: string[] = [];
  let summary = "";
  const io: Io = {
    readFile: (p) => files[p] ?? null,
    fetch: (async (u: string, init?: RequestInit) => {
      urls.push(u);
      expect((init?.headers as Record<string, string>)["User-Agent"]).toMatch(/^theagentforge-action/);
      const q = new URL(u).searchParams;
      const a = answers[q.get("id") ?? q.get("url") ?? ""];
      if (typeof a === "number") return new Response("{}", { status: a });
      return Response.json(a ?? { ...result({}), known: false, forge_score: null, distinct_owners: 0 });
    }) as typeof fetch,
    sleep: async () => {},
    log: (s) => log.push(s),
    command: (s) => commands.push(s),
    summary: (md) => (summary += md),
    output: (n, v) => (outputs[n] = v),
  };
  return { io, log, commands, outputs, urls, get summary() { return summary; } };
}

const base: Inputs = { tools: [], configs: [".mcp.json", ".cursor/mcp.json"], failOn: "flagged", failOnError: false, origin: "https://theagentforge.io" };

describe("run", () => {
  const mcp = JSON.stringify({ mcpServers: { good: { command: "npx", args: ["-y", "good-mcp"] }, bad: { command: "npx", args: ["bad-mcp@2.0.0"] } } });

  it("fails the job on a flagged server, with an error annotation and a summary", async () => {
    const h = harness({ ".mcp.json": mcp }, { "npm:good-mcp": result({ tool: { id: "npm:good-mcp" } }), "npm:bad-mcp": result({ tool: { id: "npm:bad-mcp" }, security_status: "flagged", verified_owners: 2 }) });
    expect(await run(base, h.io)).toBe(1);
    expect(h.commands.some((c) => c.startsWith("::error title=Forge: flagged::") && c.includes(".mcp.json › bad"))).toBe(true);
    expect(h.summary).toContain("| [F⚑] | [npm:bad-mcp](https://theagentforge.io/tools/npm%3Ax) | flagged | .mcp.json › bad |");
    expect(h.outputs).toEqual({ checked: "2", blocked: "npm:bad-mcp" });
  });

  it("passes on clear and unknown tools; caution only fails with fail-on: caution", async () => {
    const answers = { "npm:good-mcp": result({}), "npm:bad-mcp": result({ security_status: "caution" }) };
    expect(await run(base, harness({ ".mcp.json": mcp }, answers).io)).toBe(0);
    expect(await run({ ...base, failOn: "caution" }, harness({ ".mcp.json": mcp }, answers).io)).toBe(1);
    expect(await run({ ...base, failOn: "never" }, harness({ ".mcp.json": mcp }, { "npm:bad-mcp": result({ security_status: "confirmed_malicious" }) }).io)).toBe(0);
  });

  it("never blocks CI when the Forge is down, unless fail-on-error is set", async () => {
    const h = harness({}, { "npm:x": 503 });
    expect(await run({ ...base, tools: ["npm:x"] }, h.io)).toBe(0);
    expect(h.commands[0]).toMatch(/^::warning/);
    // No claim line when no check answered.
    expect(h.summary).not.toContain("gauntlet/claim");
    expect(await run({ ...base, tools: ["npm:x"], failOnError: true }, harness({}, { "npm:x": 503 }).io)).toBe(1);
  });

  it("retries once after a rate limit, and checks a tool listed twice only once", async () => {
    let calls = 0;
    const h = harness({ ".mcp.json": mcp, ".cursor/mcp.json": mcp }, {});
    const inner = h.io.fetch;
    h.io.fetch = (async (u: string, init?: RequestInit) => (calls++ === 0 ? new Response("", { status: 429, headers: { "Retry-After": "1" } }) : inner(u, init))) as typeof fetch;
    expect(await run(base, h.io)).toBe(0);
    expect(h.urls.length).toBe(2);
    expect(h.summary).toContain(".mcp.json › good; .cursor/mcp.json › good");
  });

  it("with a state file, says what changed since the last run, and lists each answer's receipt", async () => {
    const state = new Map<string, string>();
    const withState = (h: ReturnType<typeof harness>, day: string) => {
      h.io.readState = (p) => state.get(p) ?? null;
      h.io.writeState = (p, text) => void state.set(p, text);
      h.io.now = () => Date.parse(day);
      return h;
    };
    const inputs = { ...base, tools: ["npm:x"], stateFile: "/runner/temp/forge-check-state.json" };
    const receipt = "https://theagentforge.io/r/tok.sig";
    const first = withState(harness({}, { "npm:x": result({ reports_for_this_version: 6, outcome_breakdown: { worked: 6, partial: 0, failed: 0 }, share: { receipt_url: receipt } }) }), "2026-10-19T00:00:00Z");
    await run(inputs, first.io);
    expect(first.log).toEqual([expect.stringContaining("[F✓]"), "  since last check: first check of this version from here", `  receipt: ${receipt}`]);
    expect(first.outputs.changed).toBe("0");
    expect(first.summary).toContain("### Receipts");
    expect(first.summary.trimEnd().split("\n").at(-3)).toBe(`- \`npm:x\`: ${receipt}`);
    // ADR 0055: the summary ends with one plain claim line for the person.
    expect(first.summary.trimEnd().split("\n").at(-1)).toBe("Claim your agent's Forge profile: https://theagentforge.io/gauntlet/claim?from=action");

    const second = withState(harness({}, { "npm:x": result({ reports_for_this_version: 8, outcome_breakdown: { worked: 6, partial: 0, failed: 2 }, public_signals_summary: { advisories: [{ id: "GHSA-9999-8888-7777", kind: "vulnerability" }] } }) }), "2026-10-26T00:00:00Z");
    await run(inputs, second.io);
    const since = "since last check (2026-10-19): 2 new field reports (2 failed); new published advisory GHSA-9999-8888-7777";
    expect(second.log[1]).toBe(`  ${since}`);
    expect(second.summary).toContain(`- **\`npm:x\`**: ${since}`);
    expect(second.outputs.changed).toBe("1");
    expect(second.log.join("\n")).not.toMatch(AGENT_DIRECTED);
    // The state stays in the file; nothing about it is sent.
    expect(second.urls).toEqual(["https://theagentforge.io/api/v1/check?id=npm%3Ax"]);
  });

  it("reads the state-file input", () => {
    const i = readInputs({ "INPUT_STATE-FILE": "/tmp/s.json" }) as Inputs;
    expect(i.stateFile).toBe("/tmp/s.json");
    expect((readInputs({}) as Inputs).stateFile).toBe("");
  });

  it("says so when there's nothing to check, and reports bad JSON as not checked", async () => {
    const h = harness({ ".mcp.json": "{ nope" }, {});
    expect(await run(base, h.io)).toBe(0);
    expect(h.summary).toContain("No MCP servers or tools found");
    expect(h.summary).toContain(".mcp.json: not valid JSON");
  });
});
