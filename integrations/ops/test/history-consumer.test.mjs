import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT, contractProblem, fetchHistory, formatChange, formatFamilies, main, report } from "../../../scripts/examples/history-consumer.mjs";

// ADR 0141: the sample consumer of GET /api/v1/history/{server}, against its contract fixture (which
// apps/forge/test/server-history.test.ts checks field for field against a live answer). No network.

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const script = join(root, "scripts/examples/history-consumer.mjs");
const fixture = JSON.parse(readFileSync(join(root, "scripts/examples/history-fixture.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A local stand-in for the site: page 1 links to page 2 of the changes, a v2 server, a 500. */
let server;
let origin;
const hits = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    hits.push(u.pathname + u.search);
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const id = decodeURIComponent(u.pathname.slice("/api/v1/history/".length));
    if (id === "npm:@example/notes-mcp" && u.searchParams.get("section") === "changes") {
      const p2 = clone(fixture);
      delete p2.install_outcomes;
      delete p2.definitions;
      p2.changes.offset = 1;
      p2.changes.items = [{ ...fixture.changes.items[0], seq: 0, from_version: "0.9.0", to_version: "1.0.0", change_classes: ["schema_changed"], tools_added: 0, descriptions_changed: 0, schemas_changed: 1, major_bump: true, new_rule_ids: [] }];
      p2.changes.next = null;
      return send(200, p2);
    }
    if (id === "npm:@example/notes-mcp") {
      const p1 = clone(fixture);
      p1.changes.next = `${origin}/api/v1/history/${encodeURIComponent(id)}?section=changes&offset=1`;
      return send(200, p1);
    }
    if (id === "npm:v2-server") return send(200, { ...fixture, contract: "forge.server-history/v2", contract_version: "2.0.0" });
    if (id === "npm:offsite") return send(200, { ...clone(fixture), changes: { ...fixture.changes, next: "https://elsewhere.example/api/v1/history/x?section=changes&offset=1" } });
    if (id === "npm:broken") return send(500, { error: "internal" });
    return send(200, { ...clone(fixture), server: id, status: "not_yet_measured", data_as_of: null, changes: { ...fixture.changes, status: "not_yet_measured", items: [], next: null } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

const collect = () => {
  const out = [];
  const err = [];
  return { out, err, io: { out: (l) => out.push(l), errOut: (l) => err.push(l) } };
};

describe("contract checks (pure)", () => {
  it("accepts the v1 fixture and names what is wrong with anything else", () => {
    expect(fixture.contract).toBe(CONTRACT);
    expect(contractProblem(fixture)).toBeNull();
    expect(contractProblem({ ...fixture, contract_version: "1.4.0" })).toBeNull();
    expect(contractProblem({ ...fixture, contract_version: "2.0.0" })).toMatch(/not 1\.x/);
    expect(contractProblem({ ...fixture, contract: "other" })).toMatch(/expected forge\.server-history\/v1/);
    expect(contractProblem(null)).toBe("not a JSON object");
    const { data_as_of, ...noDate } = fixture;
    expect(contractProblem(noDate)).toBe("missing field data_as_of");
  });

  it("prints one line per change event and keeps families apart", () => {
    expect(formatChange(fixture.changes.items[0])).toBe(
      "1.0.0 (2025-10-01) -> 2.0.0 (2026-03-01): tool_added+description_changed [+1 -0 ~1 desc ~0 schema] (major bump, 1 untested between) new rule ids: FS-HID-001",
    );
    expect(formatFamilies(fixture.install_outcomes.families)).toEqual([
      "top500_nightly: 1 of 2 tests installed, 2026-11-04 to 2026-11-05",
      "weekly_sweep: not yet measured",
      "backfill: 2 of 3 tests installed, 2026-11-05 to 2026-11-05",
    ]);
  });
});

describe("against a local stand-in", () => {
  it("fetches the record, follows the changes section's next link and prints every change event", async () => {
    const r = await fetchHistory("npm:@example/notes-mcp", { origin });
    expect(r.changes.map((e) => e.to_version)).toEqual(["2.0.0", "1.0.0"]);
    const text = report(r);
    expect(text).toContain("npm:@example/notes-mcp: measured (contract forge.server-history/v1 1.0.0, data as of 2026-11-06T05:12:00.000Z)");
    expect(text).toContain("Change events: 2 of 2 consecutive pairs");
    expect(text).toContain("0.9.0 (2025-10-01) -> 1.0.0 (2026-03-01): schema_changed");
    expect(text).toContain("Tool-definition sets: 3 across 2 versions");
    expect(hits).toContain(`/api/v1/history/${encodeURIComponent("npm:@example/notes-mcp")}`);
  });

  it("exits 2 on another contract, 1 on an HTTP error, 64 without a server, and never follows off-site links", async () => {
    let c = collect();
    expect(await main(["npm:v2-server", "--origin", origin], c.io)).toBe(2);
    expect(c.err.join("\n")).toContain("unexpected contract");
    c = collect();
    expect(await main(["npm:broken", "--origin", origin], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("HTTP 500");
    c = collect();
    expect(await main([], c.io)).toBe(64);
    const before = hits.length;
    const r = await fetchHistory("npm:offsite", { origin });
    expect(hits.length).toBe(before + 1);
    expect(r.changes).toHaveLength(1);
  });

  it("runs as a command and prints JSON with --json, or the not-yet-measured state", async () => {
    const run = (args) =>
      new Promise((resolve) => {
        const p = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("close", (code) => resolve({ code, out }));
      });
    const j = await run(["npm:@example/notes-mcp", "--origin", origin, "--json"]);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out)).toMatchObject({ server: "npm:@example/notes-mcp", contract_version: "1.0.0" });
    const none = await run(["pypi:unknown-thing", "--origin", origin]);
    expect(none.code).toBe(0);
    expect(none.out).toContain("pypi:unknown-thing: not yet measured");
    expect(none.out).toContain("Change events: 0 of 0 consecutive pairs");
  });
});
