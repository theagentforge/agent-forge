import { describe, expect, it } from "vitest";
import { EXIT, run, toQuery } from "../src/run";

const check = (status: string, score: number | null, owners: number) => ({
  known: true,
  tool: { id: "npm:pkg" },
  version: "1.2.3",
  forge_score: score,
  distinct_owners: owners,
  verified_owners: owners,
  security_status: status,
  page_url: "https://theagentforge.io/t/npm:pkg",
});

function io(body: unknown, status = 200) {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  return {
    out,
    err,
    urls,
    io: {
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
      fetch: (async (u: string) => {
        urls.push(u);
        if (body instanceof Error) throw body;
        return Response.json(body, { status });
      }) as unknown as typeof fetch,
    },
  };
}

describe("forge check", () => {
  it("prints the verdict line and exits 0 for a clear tool", async () => {
    const t = io(check("clear", 91, 12));
    expect(await run(["check", "pkg"], t.io)).toBe(EXIT.ok);
    expect(t.out[0]).toBe("[F✓] · clear · Forge Score 91 · 12 independent agents · npm:pkg@1.2.3 · theagentforge.io/t/npm:pkg");
    expect(t.urls[0]).toBe("https://theagentforge.io/api/v1/check?id=npm%3Apkg");
  });

  it("ends with the signed receipt link when the answer has one, and only a Forge one", async () => {
    const receipt = "https://theagentforge.io/r/abc.0123";
    const t = io({ ...check("clear", 91, 12), share: { receipt_url: receipt } });
    await run(["check", "pkg"], t.io);
    expect(t.out.at(-1)).toBe(`receipt: ${receipt}`);
    const odd = io({ ...check("clear", 91, 12), share: { receipt_url: "https://evil.example/r/x" } });
    await run(["check", "pkg"], odd.io);
    expect(odd.out.join("\n")).not.toContain("receipt:");
  });

  it("ends a finished check with one plain claim line for the person at a terminal (ADR 0055), never in --json or an agent's shell", async () => {
    const t = io(check("clear", 91, 12));
    await run(["check", "pkg"], { ...t.io, terminal: true });
    expect(t.out.at(-1)).toBe("Claim your agent's Forge profile: https://theagentforge.io/gauntlet/claim?from=cli");
    // No TTY (an agent's shell, CI): the line would land in the agent's context, so it isn't printed.
    const agent = io(check("clear", 91, 12));
    await run(["check", "pkg"], agent.io);
    expect(agent.out.join("\n")).not.toContain("gauntlet/claim");
    await run(["check", "pkg"], { ...agent.io, terminal: false });
    expect(agent.out.join("\n")).not.toContain("gauntlet/claim");
    const j = io(check("clear", 91, 12));
    await run(["check", "pkg", "--json"], { ...j.io, terminal: true });
    expect(j.out.join("\n")).not.toContain("gauntlet/claim");
    // A failed check prints no claim line.
    const bad = io(new Error("offline"));
    await run(["check", "pkg"], { ...bad.io, terminal: true });
    expect(bad.out.join("\n")).not.toContain("gauntlet/claim");
  });

  it("exits 3 for flagged tools, and for caution only with --strict", async () => {
    expect(await run(["check", "npm:pkg"], io(check("flagged", null, 3)).io)).toBe(EXIT.blocked);
    expect(await run(["check", "npm:pkg"], io(check("caution", null, 1)).io)).toBe(EXIT.ok);
    expect(await run(["check", "npm:pkg", "--strict"], io(check("caution", null, 1)).io)).toBe(EXIT.blocked);
  });

  it("prints JSON with --json", async () => {
    const t = io(check("clear", null, 2));
    await run(["check", "npm:pkg", "--json"], t.io);
    expect(JSON.parse(t.out[0]!)).toMatchObject({ forge_score: null });
  });

  it("reports network and HTTP errors with exit 1, and bad usage with exit 2", async () => {
    expect(await run(["check", "pkg"], io(new Error("offline")).io)).toBe(EXIT.error);
    expect(await run(["check", "pkg"], io({}, 429).io)).toBe(EXIT.error);
    expect(await run([], io({}).io)).toBe(EXIT.usage);
    expect(await run(["install", "pkg"], io({}).io)).toBe(EXIT.usage);
    expect(await run(["check", "pkg", "--origin", "http://evil.example"], io({}).io)).toBe(EXIT.usage);
  });

  it("maps input to the right query", () => {
    expect(toQuery("https://github.com/a/b").get("url")).toBe("https://github.com/a/b");
    expect(toQuery("@scope/name").get("id")).toBe("npm:@scope/name");
    expect(toQuery("github.com/a/b").get("id")).toBe("github.com/a/b");
    expect(toQuery(`sha256:${"a".repeat(64)}`).get("fingerprint")).toBe(`sha256:${"a".repeat(64)}`);
  });
});
