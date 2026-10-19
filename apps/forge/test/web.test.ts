import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicCounts } from "../src/services/forge";
import { connectAgent, fetchWorker, fp, postReport, profile, report } from "./helpers";
import "../src/index";

const guard = vi.fn(async () => ({ response: "safe" }));
beforeEach(() => {
  guard.mockResolvedValue({ response: "safe" });
  vi.spyOn(env.AI, "run").mockImplementation(guard as never);
});

const page = async (path: string) => {
  const res = await fetchWorker(path, { headers: { Accept: "text/html" } });
  return { res, body: await res.text() };
};

describe("public site", () => {
  it("home page renders with headline, check box, live numbers and security headers", async () => {
    const { res, body } = await page("/");
    expect(res.status).toBe(200);
    expect(body).toContain("Check a skill before your agent installs&nbsp;it.");
    // Plain-word navigation (ADR 0019 §6); the insider pages move to the footer.
    const nav = body.slice(body.indexOf('class="nav"'), body.indexOf("</nav>", body.indexOf('class="nav"')));
    for (const label of ["Skill Watch", "Arena", "Trap card", "Check a tool", "How it works"]) expect(nav).toContain(`>${label}</a>`);
    expect(nav).not.toContain("Live Wire");
    expect(body).toContain('<a href="/wire">Live Wire</a>');
    expect(body).toContain("Check a tool before your agent installs it");
    expect(body).toContain('id="check-input"');
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    expect(body).toContain('rel="alternate" type="application/json"');
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
  });

  it("every page has a JSON twin for agents", async () => {
    const res = await fetchWorker("/?format=json");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toHaveProperty("stats");
  });

  it("a report shows up on the Live Wire, the tool page and the agent page, with notes escaped", async () => {
    const { token, agent } = await connectAgent();
    const tool = { kind: "mcp_server", id: "npm:@web/test-mcp", version: "2.1.0", fingerprint: fp("7") };
    const res = await postReport(token, report({ tool, note: "<script>alert(1)</script> fine otherwise" }));
    expect(res.status).toBe(201);

    const wire = await page("/wire?x=1");
    expect(wire.body).toContain("npm:@web/test-mcp");

    const t = await page(`/t/${encodeURIComponent("npm:@web/test-mcp")}`);
    expect(t.res.status).toBe(200);
    expect(t.body).toContain("[F–] · not enough reports yet (1 of 5)");
    expect(t.body).not.toContain("<script>alert(1)</script>");
    expect(t.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(t.body).toContain(`/og/t/${encodeURIComponent("npm:@web/test-mcp")}.png?v=`);

    const a = await page(`/a/${agent.handle}`);
    expect(a.res.status).toBe(200);
    expect(a.body).toContain(agent.handle);
  });

  it("the check page prints the same verdict string as the CLI", async () => {
    const { body } = await page("/check?q=npm:never-reported");
    expect(body).toContain("[F–] · not enough reports yet (0 of 5)");
  });

  it("Top Scouts credits findings that other people's agents confirm", async () => {
    const tool = { kind: "skill", id: "github.com/scouts/skill", version: "1", fingerprint: fp("6") };
    const first = await connectAgent();
    await postReport(first.token, report({ tool, issues: ["unexpected_network"], outcome: "partial" }));
    const second = await connectAgent();
    await postReport(second.token, report({ tool, issues: ["unexpected_network"], outcome: "partial" }));
    const res = await fetchWorker("/scouts?format=json&n=1");
    const { items } = (await res.json()) as { items: { handle: string; corroborated: number; earlyWarnings: number }[] };
    const scout = items.find((s) => s.handle === first.agent.handle);
    expect(scout).toMatchObject({ corroborated: 1, earlyWarnings: 1 });
  });

  it.each(["/methodology", "/connect", "/terms", "/privacy", "/watchlist", "/scouts"])("%s renders", async (path) => {
    const { res } = await page(path);
    expect(res.status).toBe(200);
  });

  it.each(["/terms", "/privacy"])("%s is the approved version, not a draft", async (path) => {
    const { body } = await page(path);
    expect(body).toContain("Dinike Jayamaha");
    expect(body).toContain("Version 1.0");
    const text = body.split('class="prose"')[1]?.split("</div>")[0] ?? "";
    expect(text).not.toMatch(/draft|\[/i);
  });

  it("the home page offers a line to send to your agent and points to the Arena", async () => {
    const { body } = await page("/");
    expect(body).toContain("/skill.md and use it: before you install any skill, plugin or MCP server, check it with The Forge.");
    expect(body).toContain('href="/arena"');
  });

  it("a tool page with no reports yet is kept out of search; one with reports isn't", async () => {
    const { getDb } = await import("../src/services/db");
    const t = await import("../src/db/schema");
    await getDb(env).insert(t.tools).values({ id: "empty-tool", kind: "mcp_server", canonicalId: "npm:nobody-reported-this" });
    expect((await page("/t/npm%3Anobody-reported-this")).body).toContain('<meta name="robots" content="noindex">');
    const { token } = await connectAgent();
    await postReport(token, report({ tool: { ...report().tool, id: "npm:somebody-reported-this" } }));
    expect((await page("/t/npm%3Asomebody-reported-this")).body).not.toContain('content="noindex"');
  });

  it("unknown tools and agents get a helpful 404", async () => {
    expect((await page("/t/npm%3Anothing-here")).res.status).toBe(404);
    expect((await page("/a/nobody-123")).res.status).toBe(404);
  });

  it("sandbox people count in the public numbers", async () => {
    const before = (await publicCounts(env)).humans;
    await connectAgent({ profile: profile({ public_repos: 0, public_gists: 0, followers: 0 }) });
    expect((await publicCounts(env)).humans).toBe(before + 1);
    // ADR 0023 §3: the public twin shows the number only from its minimum.
    const s = (await (await fetchWorker("/?format=json&n=2")).json()) as { stats: { humans: number | null; below_minimum: string[] } };
    expect(s.stats.humans === null).toBe(s.stats.below_minimum.includes("humans"));
  });
});

describe("share cards", () => {
  it("tool and agent pages link to versioned cards, and cards render as PNG", async () => {
    const { token, agent } = await connectAgent();
    const tool = { kind: "api", id: "npm:card-test", version: "1.0.0", fingerprint: fp("3") };
    await postReport(token, report({ tool }));
    const html = await (await fetchWorker(`/t/${encodeURIComponent("npm:card-test")}`)).text();
    const img = /property="og:image" content="([^"]+)"/.exec(html)![1]!;
    expect(img).toMatch(/\/og\/t\/npm%3Acard-test\.png\?v=[0-9a-f]{12}$/);
    const png = await fetchWorker(new URL(img).pathname + new URL(img).search);
    expect(png.status).toBe(200);
    expect(png.headers.get("Content-Type")).toBe("image/png");
    expect(png.headers.get("Cache-Control")).toContain("immutable");
    const bytes = new Uint8Array(await png.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");

    const a = await fetchWorker(`/og/a/${agent.handle}.png`);
    expect(a.headers.get("Content-Type")).toBe("image/png");
  });

  it("unknown cards fall back to the site image", async () => {
    const res = await fetchWorker("/og/t/npm%3Anope.png", { redirect: "manual" });
    expect(res.headers.get("Location")).toBe("/og/home.png");
  });
});

describe("bad links", () => {
  it("a malformed tool link is a 404, not a crash", async () => {
    expect((await fetchWorker("/t/npm%25")).status).toBe(404);
    expect((await fetchWorker("/og/t/npm%25.png", { redirect: "manual" })).status).toBe(302);
  });
});

describe("Claude Code plugin marketplace", () => {
  it("serves a marketplace pinned to this environment's plugin zip", async () => {
    const res = await fetchWorker("/marketplace.json");
    expect(res.status).toBe(200);
    const m = (await res.json()) as { name: string; plugins: { name: string; source: { source: string; url: string; sha256: string } }[] };
    expect(m.name).toBe("theagentforge");
    const src = m.plugins[0]!.source;
    expect(src.source).toBe("archive");
    expect(src.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(src.url).toMatch(/\/plugins\/forge-(staging|production)-[0-9.]+-[0-9a-f]{12}\.zip$/);
  });
});
