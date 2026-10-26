import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXIT, run, type Io } from "../src/run";
import { cacheDir, DRAFTS_FILE, MEMORY_FILE, noteTools, parseNoted } from "../src/state";
import { AGENT_DIRECTED } from "../../../apps/forge/test/wording";

// Retention plan (26 Oct 2026): "since your last check" from a local cache, a one-step field report draft, and the
// weekly watch. Nothing about earlier answers is sent; nothing is filed without the owner's yes.

const ORIGIN = "https://theagentforge.io";
const FP = `sha256:${"c".repeat(64)}`;
const RECEIPT = `${ORIGIN}/r/abc.0123`;
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

const answer = (o: Record<string, unknown> = {}) => ({
  known: true,
  tool: { id: "npm:pkg", kind: "mcp_server" },
  version: "1.2.3",
  fingerprint: FP,
  forge_score: null,
  distinct_owners: 2,
  verified_owners: 2,
  security_status: "clear",
  page_url: `${ORIGIN}/t/npm:pkg`,
  reports_for_this_version: 2,
  outcome_breakdown: { worked: 2, partial: 0, failed: 0 },
  public_signals_summary: { advisories: [] },
  share: { receipt_url: RECEIPT },
  ...o,
});

/** A fake machine: an in-memory cache, a clock, and a Forge that answers with `reply(url, init)`. */
function machine(reply: (url: string, init?: RequestInit) => Response, opts: { confirm?: boolean | null; token?: string } = {}) {
  const cache = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  let now = Date.parse("2026-10-19T10:00:00Z");
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return reply(url, init);
    }) as unknown as typeof fetch,
    readFile: async () => null,
    readCache: async (name) => cache.get(name) ?? null,
    writeCache: async (name, text) => void cache.set(name, text),
    confirm: async () => opts.confirm ?? null,
    env: opts.token ? { FORGE_TOKEN: opts.token } : {},
    sha256Hex,
    skillFiles: async () => [],
    now: () => now,
  };
  return { io, cache, out, err, calls, later: (days: number) => (now += days * 86_400_000) };
}

describe("cache location", () => {
  it("follows each platform's convention, with an override", () => {
    expect(cacheDir({}, "linux", "/home/a")).toBe("/home/a/.cache/theagentforge");
    expect(cacheDir({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/a")).toBe("/xdg/theagentforge");
    expect(cacheDir({ XDG_CACHE_HOME: "relative" }, "linux", "/home/a")).toBe("/home/a/.cache/theagentforge");
    expect(cacheDir({}, "darwin", "/Users/a")).toBe("/Users/a/Library/Caches/theagentforge");
    expect(cacheDir({ LOCALAPPDATA: "C:/Users/a/AppData/Local" }, "win32", "C:/Users/a")).toContain("theagentforge");
    expect(cacheDir({ FORGE_CACHE_DIR: "/tmp/x" }, "linux", "/home/a")).toBe("/tmp/x");
  });

  it("keeps noted tools for two weeks, one per id and version", () => {
    const now = Date.parse("2026-10-26T00:00:00Z");
    const t = (id: string, at: string) => ({ id, kind: null, pinned: null, check_version: null, check_fp: null, via: "check", at });
    const text = noteTools([t("npm:a", "2026-10-01T00:00:00Z"), t("npm:b", "2026-10-25T00:00:00Z")], [t("npm:b", "2026-10-26T00:00:00Z")], now);
    expect(parseNoted(text).map((x) => [x.id, x.at])).toEqual([["npm:b", "2026-10-26T00:00:00Z"]]);
  });
});

describe("forge check: since your last check", () => {
  it("says it's the first check, then what changed, and ends with the receipt", async () => {
    let body = answer();
    const m = machine(() => Response.json(body));
    expect(await run(["check", "pkg"], m.io)).toBe(EXIT.ok);
    expect(m.out).toEqual([
      expect.stringContaining("[F–]"),
      "since last check: first check of this version from here",
      "report draft after use: forge report npm:pkg (nothing is filed without the owner's confirmation)",
      `receipt: ${RECEIPT}`,
      `Claim your agent's Forge profile: ${ORIGIN}/gauntlet/claim?from=cli`,
    ]);
    expect(Object.keys(JSON.parse(m.cache.get(MEMORY_FILE)!).checks)).toEqual(["npm:pkg@*"]);

    body = answer({ reports_for_this_version: 3, outcome_breakdown: { worked: 2, partial: 1, failed: 0 }, security_status: "caution", public_signals_summary: { advisories: [{ id: "GHSA-1111-2222-3333", kind: "vulnerability" }] } });
    m.out.length = 0;
    m.later(7);
    await run(["check", "npm:pkg"], m.io);
    expect(m.out[1]).toBe("since last check (2026-10-19): 1 new field report (1 partial); new published advisory GHSA-1111-2222-3333; verdict not enough reports yet → caution");
    expect(m.out[1]).not.toMatch(AGENT_DIRECTED);
    expect(m.out.at(-2)).toBe(`receipt: ${RECEIPT}`);
    // Nothing about the earlier answer is sent.
    expect(m.calls.map((c) => c.url)).toEqual([`${ORIGIN}/api/v1/check?id=npm%3Apkg`, `${ORIGIN}/api/v1/check?id=npm%3Apkg`]);
  });

  it("keys a version written into the id by that version, puts since_last in JSON, and skips memory with --no-memory", async () => {
    const m = machine(() => Response.json(answer({ asked_version: "1.2.3" })));
    await run(["check", "npm:pkg@1.2.3", "--json"], m.io);
    expect(JSON.parse(m.out[0]!)).toMatchObject({ since_last: null });
    expect(Object.keys(JSON.parse(m.cache.get(MEMORY_FILE)!).checks)).toEqual(["npm:pkg@1.2.3"]);
    const n = machine(() => Response.json(answer()));
    await run(["check", "pkg", "--no-memory"], n.io);
    expect(n.cache.size).toBe(0);
    expect(n.out.join("\n")).not.toContain("since last check");
  });
});

describe("forge report: one-step field report draft", () => {
  const forge = (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/report")) return Response.json({ ok: true, report_id: "r-1", counted: true, page_url: `${ORIGIN}/t/npm:pkg` }, { status: 201 });
    return Response.json(answer({ asked_version: new URL(url).searchParams.get("version") ?? undefined }));
  };

  it("prints the draft and its one-step owner link, and files nothing", async () => {
    const m = machine(forge);
    expect(await run(["report", "npm:pkg", "--version", "1.2.3", "--outcome", "partial", "--issues", "slow,docs_wrong", "--note", "Slow first call"], m.io)).toBe(EXIT.ok);
    expect(m.out[0]).toBe('Field report draft for npm:pkg@1.2.3: outcome partial; issues slow, docs_wrong; note "Slow first call"; not filed; filing needs owner confirmation');
    const link = new URL(m.out[1]!.replace("one-step owner link: ", ""));
    expect(Object.fromEntries(link.searchParams)).toEqual({ tool: "npm:pkg", kind: "mcp_server", version: "1.2.3", fp: FP, outcome: "partial", issues: "slow,docs_wrong", note: "Slow first call" });
    expect(m.out[2]).toContain("filing: not filed");
    expect(m.out.join("\n")).not.toMatch(AGENT_DIRECTED);
    expect(m.calls.some((c) => c.url.endsWith("/api/v1/report"))).toBe(false);
  });

  it("with --file and no token, says how to connect; without a terminal, doesn't file", async () => {
    const noToken = machine(forge);
    expect(await run(["report", "npm:pkg", "--version", "1.2.3", "--outcome", "worked", "--file"], noToken.io)).toBe(EXIT.error);
    expect(noToken.out.at(-1)).toBe(`filing: not filed; needs a signed-in owner (FORGE_TOKEN isn't set). Connect: ${ORIGIN}/connect`);
    const noTty = machine(forge, { token: "t0k", confirm: null });
    expect(await run(["report", "npm:pkg", "--version", "1.2.3", "--outcome", "worked", "--file"], noTty.io)).toBe(EXIT.error);
    expect(noTty.out.at(-1)).toContain("owner confirmation needs a terminal");
    const no = machine(forge, { token: "t0k", confirm: false });
    expect(await run(["report", "npm:pkg", "--version", "1.2.3", "--outcome", "worked", "--file"], no.io)).toBe(EXIT.ok);
    expect(no.out).toEqual(["Not filed."]);
    for (const x of [noToken, noTty, no]) expect(x.calls.some((c) => c.url.endsWith("/api/v1/report"))).toBe(false);
  });

  it("files through the signed-in REST twin after a yes at the terminal", async () => {
    const m = machine(forge, { token: "t0k", confirm: true });
    expect(await run(["report", "npm:pkg", "--version", "1.2.3", "--outcome", "worked", "--file", "--framework", "codex"], m.io)).toBe(EXIT.ok);
    const post = m.calls.find((c) => c.url === `${ORIGIN}/api/v1/report`)!;
    expect((post.init!.headers as Record<string, string>).Authorization).toBe("Bearer t0k");
    expect(JSON.parse(post.init!.body as string)).toEqual({ tool: { kind: "mcp_server", id: "npm:pkg", version: "1.2.3", fingerprint: FP }, task: { category: "general", framework: "codex" }, outcome: "worked", issues: [] });
    expect(m.out.at(-1)).toBe(`filed: report r-1 (counts now) · ${ORIGIN}/t/npm:pkg`);
  });

  it("needs an outcome and a pinned version to file, and refuses unknown issues and outcomes", async () => {
    const m = machine((url) => (url.includes("registry.npmjs.org") ? new Response("no", { status: 404 }) : Response.json(answer())), { token: "t", confirm: true });
    expect(await run(["report", "npm:pkg", "--file"], m.io)).toBe(EXIT.usage);
    expect(m.err.at(-1)).toContain("needs --outcome and the exact version");
    expect(await run(["report", "npm:pkg", "--outcome", "great"], m.io)).toBe(EXIT.usage);
    expect(await run(["report", "npm:pkg", "--issues", "made_up"], m.io)).toBe(EXIT.usage);
    expect(await run(["report", "npm:pkg", "--outcome"], m.io)).toBe(EXIT.usage);
  });

  it("without a tool, lists drafts for tools checked here recently (by check or an install hook)", async () => {
    // Like the server: a version written into the id is the version asked about.
    const m = machine((url) => Response.json(answer({ asked_version: /@(\d[^@]*)$/.exec(new URL(url).searchParams.get("id") ?? "")?.[1] })));
    await run(["check", "npm:pkg@1.2.3"], m.io);
    m.out.length = 0;
    expect(await run(["report"], m.io)).toBe(EXIT.ok);
    expect(m.out[0]).toContain("Field report draft for npm:pkg@1.2.3: outcome not set; issues none");
    expect(m.out[0]).toContain(`one-step owner link: ${ORIGIN}/report?tool=npm%3Apkg&kind=mcp_server&version=1.2.3&fp=`);
    const empty = machine(() => Response.json({}));
    await run(["report"], empty.io);
    expect(empty.out[0]).toContain("No field report drafts");
  });
});

describe("forge hook: memory and drafts", () => {
  it("remembers the answer and notes the tool; a deny says what changed since the last check", async () => {
    let status = "clear";
    const m = machine(() => Response.json(answer({ security_status: status })));
    const stdin = JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm i pkg@1.2.3" } });
    m.io.stdin = async () => stdin;
    expect(await run(["hook", "codex"], m.io)).toBe(EXIT.ok);
    expect(m.out).toEqual([]);
    expect(parseNoted(m.cache.get(DRAFTS_FILE)!)).toMatchObject([{ id: "npm:pkg", pinned: "1.2.3", via: "codex", check_fp: FP }]);
    status = "flagged";
    m.later(2);
    await run(["hook", "codex"], m.io);
    const reason = JSON.parse(m.out[0]!).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain("(since last check (2026-10-19): verdict not enough reports yet → flagged)");
    expect(reason).not.toMatch(AGENT_DIRECTED);
  });
});

describe("forge watch: the weekly pass", () => {
  const SKILL = "---\nname: pdf\n---\nRead PDFs.\n";
  const fp = `sha256:${sha256Hex(SKILL)}`;

  it("sends only fingerprints, lists what needs attention and exits 3 on a flagged skill", async () => {
    const m = machine((url) =>
      url.endsWith("/api/v1/watch")
        ? Response.json({ rules_version: "2026-10-23.1", items: [{ fingerprint: fp, known: true, verdict: "flagged", rules_version: "2026-10-23.1", rescan_needed: false, versions_with_reports: 0 }] })
        : Response.json(answer()),
    );
    m.io.skillFiles = async () => [{ label: "pdf", text: SKILL }];
    expect(await run(["watch"], m.io)).toBe(EXIT.blocked);
    expect(m.calls[0]!.init!.body).toBe(JSON.stringify({ fingerprints: [fp] }));
    expect(m.out[0]).toBe("Forge weekly check: 1 skill, 1 flagged, 0 caution, 0 changed, 0 need a fresh scan; scan rules 2026-10-23.1");
    expect(m.out[1]).toContain("pdf (sha256:");
    expect(JSON.parse(m.cache.get(MEMORY_FILE)!).rules).toBe("2026-10-23.1");
  });

  it("says so when there is nothing to watch, and fails when the Forge is down", async () => {
    const m = machine(() => Response.json({}));
    expect(await run(["watch"], m.io)).toBe(EXIT.ok);
    expect(m.out[0]).toContain("Nothing to watch");
    const down = machine(() => {
      throw new Error("offline");
    });
    down.io.skillFiles = async () => [{ label: "pdf", text: SKILL }];
    expect(await run(["watch"], down.io)).toBe(EXIT.error);
  });
});
