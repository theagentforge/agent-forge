import { describe, expect, it } from "vitest";
import { hookAnswer, hookCommand, hookConfig, type HookClient } from "../src/hook";
import { EXIT, run } from "../src/run";

// Pre-install hooks for Codex, Gemini CLI and Copilot CLI: deny only flagged / confirmed malicious, otherwise
// leave the command alone, and fail open on every error.

const ORIGIN = "https://theagentforge.io";

const verdict = (status: string, score: number | null = null, owners = 0) => ({
  known: true,
  tool: null,
  version: "1.0.0",
  forge_score: score,
  distinct_owners: owners,
  verified_owners: owners,
  security_status: status,
  page_url: `${ORIGIN}/t/x`,
});

/** A fake Forge: answers per id, throws ("offline") for ids it doesn't know, and records the URLs it was asked. */
function forge(byId: Record<string, unknown>) {
  const urls: string[] = [];
  const fetch = (async (url: string) => {
    urls.push(url);
    const id = new URL(url).searchParams.get("id")!;
    if (!(id in byId)) throw new Error("offline");
    return Response.json(byId[id]);
  }) as unknown as typeof globalThis.fetch;
  return { urls, deps: { origin: ORIGIN, fetch, userAgent: "test" } };
}

/** Each client's stdin payload for a shell command, from its own docs/source. */
const payload: Record<HookClient, (command: string) => unknown> = {
  codex: (command) => ({
    session_id: "s",
    turn_id: "t",
    transcript_path: null,
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    model: "gpt-5",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: "u",
  }),
  gemini: (command) => ({
    session_id: "s",
    transcript_path: "/tmp/t.json",
    cwd: "/repo",
    hook_event_name: "BeforeTool",
    timestamp: "2026-10-24T00:00:00Z",
    tool_name: "run_shell_command",
    tool_input: { command, description: "install" },
  }),
  copilot: (command) => ({ sessionId: "s", timestamp: 1761264000000, cwd: "/repo", toolName: "bash", toolArgs: JSON.stringify({ command }) }),
};

/** The parsed deny reason in each client's format, or null when the answer isn't a deny. */
const denyReason: Record<HookClient, (out: string) => string | null> = {
  codex: (out) => {
    if (!out) return null;
    const o = JSON.parse(out);
    expect(Object.keys(o)).toEqual(["hookSpecificOutput"]);
    expect(o.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    return o.hookSpecificOutput.permissionDecisionReason;
  },
  gemini: (out) => {
    const o = JSON.parse(out);
    if (!("decision" in o)) return null;
    expect(o.decision).toBe("deny");
    return o.reason;
  },
  copilot: (out) => {
    if (!out) return null;
    const o = JSON.parse(out);
    expect(o.permissionDecision).toBe("deny");
    return o.permissionDecisionReason;
  },
};

/** What each client gets when the hook has no objection. */
const ALLOW: Record<HookClient, string> = { codex: "", gemini: "{}", copilot: "" };

const CLIENTS: HookClient[] = ["codex", "gemini", "copilot"];

describe.each(CLIENTS)("forge hook %s", (client) => {
  const ask = (command: string, f: ReturnType<typeof forge>) => hookAnswer(client, JSON.stringify(payload[client](command)), f.deps);

  it("denies a flagged install in the client's format, with a one-line factual reason", async () => {
    const f = forge({ "npm:evil-pkg": verdict("flagged", null, 3), "npm:fine": verdict("clear", 90, 12) });
    const reason = denyReason[client](await ask("npm install fine evil-pkg", f));
    expect(reason).toBe("The Agent Forge: [F⚑] · flagged · 3 independent verified agents reported a security issue · npm:evil-pkg@1.0.0 · theagentforge.io/t/x");
    expect(reason).not.toMatch(/\n|tell|should|please|run /i);
  });

  it("denies a confirmed malicious package fetched by a runner", async () => {
    const f = forge({ "npm:bad-mcp": verdict("confirmed_malicious") });
    expect(denyReason[client](await ask("npx -y bad-mcp", f))).toContain("[F✕] · confirmed malicious · npm:bad-mcp@1.0.0");
  });

  it("sends the pinned version, so an advisory for that version denies it, and checks the bare name when unpinned", async () => {
    const urls: string[] = [];
    // Like the server: a malicious-package advisory flags the version it names; without a version it's under review.
    const fetch = (async (url: string) => {
      urls.push(url);
      const q = new URL(url).searchParams;
      return Response.json(verdict(q.get("id") === "pypi:litellm" && q.get("version") === "1.107.0" ? "flagged" : "caution"));
    }) as unknown as typeof globalThis.fetch;
    const deps = { origin: ORIGIN, fetch, userAgent: "test" };
    const reason = denyReason[client](await hookAnswer(client, JSON.stringify(payload[client]("pip install litellm==1.107.0")), deps));
    expect(reason).toContain("[F⚑] · flagged");
    expect(urls).toEqual([`${ORIGIN}/api/v1/check?id=pypi%3Alitellm&version=1.107.0`]);
    expect(await hookAnswer(client, JSON.stringify(payload[client]("pip install litellm")), deps)).toBe(ALLOW[client]);
    expect(urls[1]).toBe(`${ORIGIN}/api/v1/check?id=pypi%3Alitellm`);
  });

  it("allows clear, caution and not-yet-reported installs", async () => {
    const f = forge({ "npm:good": verdict("clear", 87, 41), "npm:shady": verdict("caution"), "npm:new": { ...verdict("unknown"), known: false } });
    expect(await ask("pnpm add good shady new", f)).toBe(ALLOW[client]);
    expect(f.urls).toHaveLength(3);
  });

  it("passes non-install commands untouched without calling The Forge", async () => {
    const f = forge({});
    expect(await ask("ls -la && npm test", f)).toBe(ALLOW[client]);
    expect(f.urls).toEqual([]);
  });

  it("allows when The Forge can't be reached or answers an error", async () => {
    expect(await ask("npm i whatever", forge({}))).toBe(ALLOW[client]);
    const failing = { origin: ORIGIN, userAgent: "t", fetch: (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch };
    expect(await hookAnswer(client, JSON.stringify(payload[client]("npm i whatever")), failing)).toBe(ALLOW[client]);
  });

  it("allows when the check is slower than the timeout", async () => {
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("timeout"))))) as unknown as typeof fetch;
    const started = Date.now();
    expect(await hookAnswer(client, JSON.stringify(payload[client]("npm i slow")), { origin: ORIGIN, userAgent: "t", fetch: hang, timeoutMs: 50 })).toBe(ALLOW[client]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("allows malformed or unexpected stdin", async () => {
    const f = forge({ "npm:evil-pkg": verdict("flagged", null, 3) });
    for (const stdin of ["", "not json", "[]", "null", '{"tool_name":', JSON.stringify({ tool_name: "Bash", tool_input: { command: 42 } })])
      expect(await hookAnswer(client, stdin, f.deps)).toBe(ALLOW[client]);
    expect(f.urls).toEqual([]);
  });

  it("ignores other tools, even when their arguments look like an install", async () => {
    const f = forge({ "npm:evil-pkg": verdict("flagged", null, 3) });
    const other = { tool_name: "write_file", toolName: "edit", tool_input: { command: "npm i evil-pkg" }, toolArgs: { command: "npm i evil-pkg" } };
    expect(await hookAnswer(client, JSON.stringify(other), f.deps)).toBe(ALLOW[client]);
    expect(f.urls).toEqual([]);
  });

  it("runs end to end through `forge hook`, always exiting 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const f = forge({ "npm:evil-pkg": verdict("flagged", null, 3) });
    const io = (stdin: string) => ({ out: (s: string) => out.push(s), err: (s: string) => err.push(s), fetch: f.deps.fetch, stdin: async () => stdin });
    expect(await run(["hook", client], io(JSON.stringify(payload[client]("npm i evil-pkg"))))).toBe(EXIT.ok);
    expect(denyReason[client](out[0]!)).toContain("[F⚑]");
    out.length = 0;
    expect(await run(["hook", client], io("garbage"))).toBe(EXIT.ok);
    expect(out.join("")).toBe(ALLOW[client]);
    expect(await run(["hook", client], { ...io(""), stdin: async () => Promise.reject(new Error("closed")) })).toBe(EXIT.ok);
    expect(err).toEqual([]);
  });

  it("prints the config snippet that runs this hook", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s), fetch: forge({}).deps.fetch };
    expect(await run(["hook", "--print-config", client], io)).toBe(EXIT.ok);
    expect(JSON.parse(out[0]!)).toEqual(hookConfig(client).config);
    expect(out[0]).toContain(`"npx -y @theagentforge/cli hook ${client}"`);
    expect(err[0]).toContain(hookConfig(client).files[0]);
    out.length = 0;
    await run(["hook", "--print-config", client, "--json", "--origin", "https://staging.theagentforge.io"], io);
    expect(JSON.stringify(JSON.parse(out[0]!).config)).toContain(`hook ${client} --origin https://staging.theagentforge.io`);
  });
});

describe("forge hook details", () => {
  it("prints each client's documented config shape", () => {
    const cmd = (c: HookClient) => hookCommand(c);
    expect(hookConfig("codex").config).toEqual({
      hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: cmd("codex"), timeout: 10 }] }] },
    });
    expect(hookConfig("gemini").config).toEqual({
      hooks: { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ name: "agent-forge-install-check", type: "command", command: cmd("gemini"), timeout: 10000 }] }] },
    });
    expect(hookConfig("copilot").config).toEqual({
      version: 1,
      hooks: { preToolUse: [{ type: "command", matcher: "bash|powershell", bash: cmd("copilot"), powershell: cmd("copilot"), timeoutSec: 10 }] },
    });
  });

  it("reads Copilot's toolArgs as an object too, and its PascalCase payload", async () => {
    const f = forge({ "npm:evil-pkg": verdict("flagged", null, 3) });
    const asObject = { toolName: "powershell", toolArgs: { command: "npm install evil-pkg" } };
    const pascal = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm install evil-pkg" } };
    for (const p of [asObject, pascal]) expect(JSON.parse(await hookAnswer("copilot", JSON.stringify(p), f.deps)).permissionDecision).toBe("deny");
  });

  it("checks GitHub clones and sends only the tool id", async () => {
    const f = forge({ "github.com/acme/skills": verdict("flagged", null, 2) });
    const out = await hookAnswer("codex", JSON.stringify(payload.codex("git clone https://github.com/Acme/Skills.git")), f.deps);
    expect(JSON.parse(out).hookSpecificOutput.permissionDecisionReason).toContain("github.com/acme/skills");
    expect(f.urls).toEqual([`${ORIGIN}/api/v1/check?id=github.com%2Facme%2Fskills`]);
  });

  it("exits 1 (never 2, which clients read as block) on an unknown client", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (s: string) => err.push(s), fetch: forge({}).deps.fetch };
    expect(await run(["hook", "cursor"], io)).toBe(EXIT.error);
    expect(await run(["hook"], io)).toBe(EXIT.error);
    expect(await run(["hook", "--print-config"], io)).toBe(EXIT.error);
    expect(err[0]).toContain("codex, gemini, copilot");
  });
});
