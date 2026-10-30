import { env } from "cloudflare:workers";
import { grossNumbers } from "../src/services/public-stats";
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
    // W2.1: one of the three hero cases (test/home-hero.test.ts covers which applies when).
    expect(body).toMatch(/<h1>(An AI agent paid a fake invoice and <em>reported the job done<\/em>\.|AI agents paid a planted fake invoice in <em>[^<]+<\/em> refereed Arena runs\.|Would your AI agent pay a <em>fake invoice<\/em>\?)<\/h1>/);
    // W2.1 navigation: Arena, Benchmark, Check a tool, Security, Stats; the Wire and Skill Watch move to the footer.
    const nav = body.slice(body.indexOf('class="nav"'), body.indexOf("</nav>", body.indexOf('class="nav"')));
    for (const label of ["Arena", "Benchmark", "Check a tool", "Security", "Stats"]) expect(nav).toContain(`>${label}</a>`);
    expect(nav).not.toContain("Live Wire");
    expect(body).toContain('<a href="/wire">The Wire</a>');
    expect(body).toContain('<a href="/skill-watch">Skill Watch</a>');
    // Site audit 29 Oct: one check box on the home page.
    expect(body).toContain('<h2 id="home-check">Check before you install</h2>');
    expect(body).toContain('id="home-go"');
    expect(body).toContain('name="twitter:card" content="summary_large_image"');
    expect(body).toContain('rel="alternate" type="application/json"');
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
    // ADR 0116: cached only until the totals snapshot ends (at most 60 seconds).
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(60);
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
    expect(body).toContain(path === "/privacy" ? "Version 1.1" : "Version 1.0");
    const text = body.split('class="prose"')[1]?.split("</div>")[0] ?? "";
    expect(text).not.toMatch(/draft|\[/i);
  });

  it("the line to send to your agent lives on /connect (site audit B2), and the home page points to the Arena", async () => {
    const { body } = await page("/");
    expect(body).not.toContain("/skill.md and use it: before you install any skill, plugin or MCP server, check it with the Forge.");
    expect(body).toContain('href="/arena');
    const { body: connect } = await page("/connect");
    expect(connect).toContain("/skill.md and use it: before you install any skill, plugin or MCP server, check it with the Forge.");
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
    // F-02 (ADR 0082): the outside-only count is internal; the public twin gives it as null, with a gross twin.
    const s = (await (await fetchWorker("/?format=json&n=2")).json()) as { stats: { humans: number | null; internal_only: string[]; gross: { items: { key: string; value: number }[] } } };
    expect(s.stats.humans).toBeNull();
    expect(s.stats.internal_only).toContain("humans");
    // ADR 0099: the gross row appears once it passes its minimum (50), with the exact value.
    const exact = (await grossNumbers(env)).signed_in_people;
    expect(exact).toBeGreaterThanOrEqual(before + 1);
    expect(s.stats.gross.items.find((i) => i.key === "signed_in_people")?.value ?? null).toBe(exact >= 50 ? exact : null);
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
    expect(src.url).toMatch(/\/plugins\/theagentforge-(staging|production)-[0-9.]+-[0-9a-f]{12}\.zip$/);
  });

  it("lists the plugin as theagentforge, and renames forge to it so existing installs move over (ADR 0121)", async () => {
    const m = (await (await fetchWorker("/marketplace.json")).json()) as { name: string; plugins: { name: string; displayName: string }[]; renames: Record<string, string | null> };
    expect(m.name).toBe("theagentforge");
    expect(m.plugins.map((p) => p.name)).toEqual(["theagentforge"]);
    expect(m.plugins[0]!.displayName).toBe("The Agent Forge");
    expect(m.renames).toEqual({ forge: "theagentforge" });
    // Every rename resolves to a listed plugin (Claude Code rejects a chain that doesn't).
    for (const to of Object.values(m.renames)) expect(to === null || m.plugins.some((p) => p.name === to)).toBe(true);
  });

  it("still serves the old forge 0.7.1 zips byte for byte, for installs and cached catalogs that point at them", async () => {
    const plugin = (await import("../public/plugins/manifest.json")).default as unknown as { legacy: Record<string, { version: string; files: Record<string, { file: string; sha256: string }> }> };
    const old = plugin.legacy.forge!;
    expect(old.version).toBe("0.7.1");
    for (const env of ["staging", "production"]) {
      const { file, sha256 } = old.files[env]!;
      expect(file).toMatch(new RegExp(`^forge-${env}-0\\.7\\.1-${sha256.slice(0, 12)}\\.zip$`));
    }
  });

  it("lists the plugin with the same version and description as its build (from its plugin.json; CI checks the build)", async () => {
    const m = (await (await fetchWorker("/marketplace.json")).json()) as { plugins: { version: string; description: string; source: { url: string } }[] };
    const plugin = (await import("../public/plugins/manifest.json")).default as { version: string; description: string };
    expect(m.plugins[0]).toMatchObject({ version: plugin.version, description: plugin.description });
    expect(m.plugins[0]!.source.url).toContain(`-${plugin.version}-`);
    expect(m.plugins[0]!.description).toContain("/theagentforge:gauntlet");
  });
});
