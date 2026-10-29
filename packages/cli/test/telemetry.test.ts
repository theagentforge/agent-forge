import { describe, expect, it } from "vitest";
import { EXIT, run, type Io } from "../src/run";
import { configDir } from "../src/state";

// B3-09 (ADR 0103): the anonymous install ID. A UUID v4 made here, stable across runs, sent only as the
// forge-install-id header on checks; off with FORGE_NO_ANALYTICS, DO_NOT_TRACK, CI or `forge telemetry disable`.
// stdout stays exactly as it was: the notice and the debug line go to stderr.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const answer = { known: true, tool: { id: "npm:pkg" }, version: "1.2.3", forge_score: 91, distinct_owners: 12, verified_owners: 12, security_status: "clear", page_url: "https://theagentforge.io/t/npm:pkg" };

/** A machine: a settings folder kept between runs, and a fake Forge that records each request's headers. */
function machine(env: Record<string, string | undefined> = {}) {
  const files = new Map<string, string>();
  const sent: Headers[] = [];
  let n = 0;
  const make = (out: string[], err: string[], body: unknown = answer) => ({
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    fetch: (async (_u: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return Response.json(body);
    }) as unknown as typeof fetch,
    env,
    readConfig: async (name: string) => files.get(name) ?? null,
    writeConfig: async (name: string, text: string) => void files.set(name, text),
    randomUUID: () => `3b241101-e2bb-4255-8caf-4136c566a96${n++}`,
  });
  return {
    files,
    sent,
    async run(argv: string[], extra: Partial<Io> = {}, body?: unknown) {
      const out: string[] = [];
      const err: string[] = [];
      const code = await run(argv, { ...make(out, err, body), ...extra });
      return { code, out, err };
    },
  };
}

describe("install ID: forge check", () => {
  it("sends a UUID v4, the same one on every run, with a one-line notice on stderr the first time only", async () => {
    const m = machine();
    const first = await m.run(["check", "pkg", "--json"]);
    const second = await m.run(["check", "pkg", "--json"]);
    const id = m.sent[0]!.get("forge-install-id");
    expect(id).toMatch(UUID_V4);
    expect(m.sent[1]!.get("forge-install-id")).toBe(id);
    expect(first.err).toHaveLength(1);
    expect(first.err[0]).toContain("a random install ID");
    expect(second.err).toHaveLength(0);
    // The JSON on stdout is untouched: it parses, and the notice is nowhere in it.
    for (const r of [first, second]) {
      expect(JSON.parse(r.out.join("\n"))).toMatchObject({ security_status: "clear" });
      expect(r.out.join("\n")).not.toContain("install ID");
    }
  });

  it("sends no header and makes no ID with FORGE_NO_ANALYTICS, DO_NOT_TRACK or CI", async () => {
    for (const env of [{ FORGE_NO_ANALYTICS: "1" }, { DO_NOT_TRACK: "1" }, { CI: "true" }]) {
      const m = machine(env);
      const r = await m.run(["check", "pkg"]);
      expect(r.code).toBe(EXIT.ok);
      expect(m.sent[0]!.has("forge-install-id")).toBe(false);
      expect(m.files.size).toBe(0);
      expect(r.err).toHaveLength(0);
    }
  });

  it("FORGE_TELEMETRY_DEBUG prints what would be sent on stderr and sends nothing", async () => {
    const m = machine({ FORGE_TELEMETRY_DEBUG: "1" });
    const r = await m.run(["check", "pkg", "--json"]);
    expect(m.sent[0]!.has("forge-install-id")).toBe(false);
    expect(r.err.join("\n")).toMatch(/nothing sent\): would send header forge-install-id: [0-9a-f-]{36} \(client cli\)/);
    expect(() => JSON.parse(r.out.join("\n"))).not.toThrow();
  });

  it("sends nothing when the ID can't be saved (an ID that changes every run would only add noise)", async () => {
    const m = machine();
    await m.run(["check", "pkg"], { writeConfig: async () => Promise.reject(new Error("read-only")) });
    expect(m.sent[0]!.has("forge-install-id")).toBe(false);
  });
});

describe("install ID: forge hook", () => {
  const stdin = (command: string) => async () => JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  it("sends the ID with hook checks; stdout stays the client's answer and the notice goes to stderr", async () => {
    const m = machine();
    const r = await m.run(["hook", "codex"], { stdin: stdin("npm i pkg") });
    expect(r.code).toBe(EXIT.ok);
    expect(m.sent[0]!.get("forge-install-id")).toMatch(UUID_V4);
    expect(m.sent[0]!.get("user-agent")).toContain("(hook codex)");
    expect(r.out).toEqual([]); // Codex: an allowed command prints nothing
    expect(r.err).toHaveLength(1);
  });

  it("makes no ID for a command that installs nothing", async () => {
    const m = machine();
    const r = await m.run(["hook", "gemini"], { stdin: stdin("ls -la") });
    expect(m.files.size).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toEqual(["{}"]);
  });

  it("sends no header with DO_NOT_TRACK", async () => {
    const m = machine({ DO_NOT_TRACK: "1" });
    await m.run(["hook", "copilot"], { stdin: async () => JSON.stringify({ toolName: "bash", toolArgs: JSON.stringify({ command: "npm i pkg" }) }) });
    expect(m.sent[0]!.has("forge-install-id")).toBe(false);
  });
});

describe("forge telemetry", () => {
  it("status, disable and enable", async () => {
    const m = machine();
    await m.run(["check", "pkg"]);
    const id = m.sent[0]!.get("forge-install-id")!;
    const status = await m.run(["telemetry", "status", "--json"]);
    expect(JSON.parse(status.out.join("\n"))).toMatchObject({ install_id_enabled: true, sending: true, install_id: id, header: "forge-install-id" });

    expect((await m.run(["telemetry", "disable"])).code).toBe(EXIT.ok);
    expect([...m.files.values()].join("")).not.toContain(id); // the ID is deleted, not just switched off
    await m.run(["check", "pkg"]);
    expect(m.sent[1]!.has("forge-install-id")).toBe(false);
    expect((await m.run(["telemetry"])).out[0]).toContain("off");

    await m.run(["telemetry", "enable"]);
    await m.run(["check", "pkg"]);
    const next = m.sent[2]!.get("forge-install-id");
    expect(next).toMatch(UUID_V4);
    expect(next).not.toBe(id);
  });

  it("says so when an environment variable keeps it off", async () => {
    const m = machine({ FORGE_NO_ANALYTICS: "1" });
    const r = await m.run(["telemetry", "status", "--json"]);
    expect(JSON.parse(r.out.join("\n"))).toMatchObject({ sending: false, off_reason: "FORGE_NO_ANALYTICS" });
  });

  it("refuses an unknown subcommand", async () => {
    expect((await machine().run(["telemetry", "maybe"])).code).toBe(EXIT.usage);
  });

  it("keeps the ID in the settings folder, not the cache", () => {
    expect(configDir({}, "linux", "/home/u")).toBe("/home/u/.config/theagentforge");
    expect(configDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/theagentforge");
    expect(configDir({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Preferences/theagentforge");
    expect(configDir({ FORGE_CONFIG_DIR: "/c" }, "linux", "/home/u")).toBe("/c");
  });

  it("help and the notice say what Cloudflare's request logs keep (the address, which names the package, and this ID; Dinike, 29 Oct)", async () => {
    const out: string[] = [];
    await run(["--help"], { out: (x: string) => out.push(x), err: (x: string) => out.push(x), fetch: (async () => Response.json({})) as unknown as typeof fetch, env: {} } as unknown as Io);
    const help = out.join("\n").replace(/\s+/g, " ");
    expect(help).toContain("Cloudflare's request logs keep each request (its address, which names the package checked, and its headers, including this ID) with the IP address for up to 7 days; we don't copy the ID out of them.");
    expect(help).not.toMatch(/anonymous/i);
  });
});
