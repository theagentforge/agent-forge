import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defaultTab, installLinks, verifyCommands, verifySection } from "../src/web/connect";
import { AGENT_DIRECTED } from "./wording";
import { ADVISORY_LINE_UNTIL, HOME_SUBHEAD, advisoryLine } from "../src/web/pages";
import { fetchWorker } from "./helpers";
import "../src/index";

const page = async (path: string, headers: Record<string, string> = {}) => (await fetchWorker(path, { headers: { Accept: "text/html", ...headers } })).text();

describe("October 2026 advisory lines (crisis-messaging §4)", () => {
  it("home carries the dated line until it retires; /connect carries its sub-line", async () => {
    const home = await page("/");
    expect(home).toContain("<b>October 2026 advisories:</b> checks now include OSV malicious-package and CISA exploited-vulnerability data.");
    expect(home).toContain('href="/advisories/2026-10?from=home"');
    expect(String(advisoryLine(ADVISORY_LINE_UNTIL))).toBe("");
    expect(String(advisoryLine(ADVISORY_LINE_UNTIL - 1))).toContain("See what changed");
    expect(await page("/connect")).toContain("Your agent can check its own stack against <a href=\"/advisories/2026-10?from=connect\">this month's advisories</a> once connected.");
  });
});

describe("/connect, pick your app (ADR 0017 §4)", () => {
  it("leads with one address for any AI app or agent, then the app tiles", async () => {
    const body = await page("/connect");
    expect(body.indexOf("Any AI app or agent")).toBeGreaterThan(0);
    expect(body.indexOf("Any AI app or agent")).toBeLessThan(body.indexOf('class="app-tiles"'));
    expect(body).toContain(`${env.PUBLIC_ORIGIN}/mcp/public</code>`);
    expect(body).toContain(`Read ${env.PUBLIC_ORIGIN}/skill.md and use it`);
  });

  it("shows the app tiles, a checklist that starts at 1 of 3, and one primary button per app", async () => {
    const body = await page("/connect");
    for (const label of ["ChatGPT", "Claude", "Gemini", "Grok, Perplexity, Le Chat", "Developers"]) expect(body).toContain(`>${label}</a>`);
    expect(body).toContain("You found the Forge");
    expect(body).toContain("1 of 3 done.");
    for (const id of ["claude", "chatgpt", "gemini", "other", "developers"]) {
      const sec = body.slice(body.indexOf(`id="tab-${id}"`), body.indexOf("</section>", body.indexOf(`id="tab-${id}"`)));
      expect((sec.match(/class="btn primary chamfer"/g) ?? []).length, id).toBe(1);
    }
    expect(body).toContain("Get the trap card");
  });

  it("gives steps for Grok, Perplexity and Le Chat with the no-sign-in address, and opens that tab for their visitors", async () => {
    const body = await page("/connect");
    const sec = body.slice(body.indexOf('id="tab-other"'), body.indexOf("</section>", body.indexOf('id="tab-other"')));
    for (const app of ["Grok", "Perplexity", "Le Chat"]) expect(sec).toContain(`<b>${app}</b>`);
    expect(sec).toContain(`${env.PUBLIC_ORIGIN}/mcp/public`);
    expect(defaultTab("https://grok.com/chat/1", undefined)).toBe("other");
    expect(defaultTab("https://www.perplexity.ai/search/x", undefined)).toBe("other");
    expect(defaultTab("https://chat.mistral.ai/chat", undefined)).toBe("other");
  });

  it("uses the pre-filled Claude link to the no-sign-in endpoint, and Cursor and VS Code install links", async () => {
    const links = installLinks(env.PUBLIC_ORIGIN);
    expect(links.claude).toBe(
      `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=The%20Agent%20Forge&connectorUrl=${encodeURIComponent(`${env.PUBLIC_ORIGIN}/mcp/public`)}`,
    );
    // One-click links open the no-sign-in address; sign-in is the later step for filing reports.
    const pub = `${env.PUBLIC_ORIGIN}/mcp/public`;
    expect(JSON.parse(atob(new URL(links.cursor.replace("cursor://", "https://")).searchParams.get("config")!))).toEqual({ url: pub });
    expect(JSON.parse(decodeURIComponent(links.vscode.slice("vscode:mcp/install?".length)))).toEqual({ name: "forge", type: "http", url: pub });
    expect(JSON.parse(atob(new URL(links.lmstudio.replace("lmstudio://", "https://x/")).searchParams.get("config")!))).toEqual({ url: pub });
    const goose = new URL(links.goose.replace("goose://", "https://x/"));
    expect(Object.fromEntries(goose.searchParams)).toMatchObject({ url: pub, type: "streamable_http", id: "forge" });
    const body = await page("/connect");
    expect(body).toContain(links.claude.replace(/&/g, "&amp;"));
    expect(body).toContain(`claude mcp add --scope user --transport http forge ${pub}`);
    expect(body).toContain("Then test it below");
    expect(body).toContain("data-test-again");
  });

  it("keeps 'Link from other apps' (the old 'Verify your agent') inside More ways: signed-in address, one line per CLI, Claude.ai link, dashboard (K5, OA-02)", async () => {
    const body = await page("/connect");
    const start = body.indexOf('id="verify"');
    expect(start).toBeGreaterThan(0);
    // No longer a separate top-level panel: it sits in the one collapsed "More ways", after the three steps.
    expect(start).toBeGreaterThan(body.indexOf('<details class="more-ways-box" id="more-ways" data-more-ways>'));
    expect(start).toBeGreaterThan(body.indexOf('id="link-step"'));
    expect(body).not.toContain("Verify your agent (GitHub sign-in, 1 minute)");
    const sec = body.slice(start, body.indexOf("</section>", start));
    expect(sec).toContain("Link from other apps (GitHub sign-in, 1 minute)");
    expect(sec).toContain("count toward");
    expect(sec).toContain("public agent page");
    const mcp = `${env.PUBLIC_ORIGIN}/mcp`;
    expect(sec).toContain(`<code id="url-verify">${mcp}</code>`);
    for (const v of verifyCommands(env.PUBLIC_ORIGIN)) expect(sec).toContain(`<code id="${v.id}">${v.command}</code>`);
    expect(verifyCommands(env.PUBLIC_ORIGIN).map((v) => v.command)).toEqual([
      `claude mcp add --scope user --transport http forge-reports ${mcp}`,
      `codex mcp add forge-reports --url ${mcp}`,
      `gemini mcp add --transport http forge-reports ${mcp}`,
    ]);
    // The pre-filled Claude.ai link opens "Add custom connector" with the signed-in address, and the click path is there.
    const links = installLinks(env.PUBLIC_ORIGIN);
    const u = new URL(links.claudeSignedIn);
    expect(Object.fromEntries(u.searchParams)).toEqual({ modal: "add-custom-connector", connectorName: "The Agent Forge (reports)", connectorUrl: mcp });
    expect(sec).toContain(links.claudeSignedIn.replace(/&/g, "&amp;"));
    expect(sec).toContain("Customize → Connectors → + Add → Add custom connector");
    expect(sec).toContain('href="/dashboard"');
    // Counts stay internal (Dinike, 23 Oct): the step is the same text whatever the numbers are, and carries none.
    expect(String(verifySection(env.PUBLIC_ORIGIN, links))).not.toMatch(/\d+ (verified|human-verified|agents? (connected|verified))/i);
    // Plain steps for people, no agent-directed steering (AGENTS.md rule 7).
    expect(AGENT_DIRECTED.exec(sec.replace(/<[^>]+>/g, " "))?.[0] ?? null).toBeNull();
  });

  it("opens the right tab from where the visitor came from", () => {
    expect(defaultTab("https://chatgpt.com/c/123", undefined)).toBe("chatgpt");
    expect(defaultTab("https://claude.ai/new", undefined)).toBe("claude");
    expect(defaultTab("https://gemini.google.com/app", undefined)).toBe("gemini");
    expect(defaultTab("https://github.com/x/y", undefined)).toBe("developers");
    expect(defaultTab(undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)")).toBe("chatgpt");
    expect(defaultTab(undefined, "Mozilla/5.0 (Macintosh)")).toBe("claude");
  });

  it("ticks 'Test it' when a check for the page's code arrives, from any app", async () => {
    const body = await page("/connect");
    const code = /data-test-code="([a-z0-9]{6})"/.exec(body)![1]!;
    expect(body).toContain(`npm:forge-test-${code}`);
    const seen = async (c: string) => ((await (await fetchWorker(`/api/v1/connect-test/${c}`)).json()) as { seen: boolean }).seen;
    expect(await seen(code)).toBe(false);
    await fetchWorker(`/api/v1/check?id=npm:forge-test-${code}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    expect(await seen(code)).toBe(true);
    // Counted once per code, as a conversion.
    await fetchWorker(`/api/v1/check?id=npm:forge-test-${code}`, { headers: { "CF-Connecting-IP": "203.0.113.9" } });
    const { agentFunnel } = await import("../src/services/agent-funnel");
    await expect.poll(async () => (await agentFunnel(env)).detail.connect_tests_passed).toBe(1);
    expect(await seen("zzzzzz")).toBe(false);
    // Each visit gets its own code (the page isn't cached).
    expect(/data-test-code="([a-z0-9]{6})"/.exec(await page("/connect"))![1]).not.toBe(code);
  });
});

describe("home page message (ADR 0018 §1–3)", () => {
  it("has the H1, the subhead and the numbers; the 4 value cards are gone (site audit 29 Oct, B2)", async () => {
    const body = await page("/");
    const h1 = body.indexOf("<h1>");
    expect(h1).toBeGreaterThan(0);
    expect(body.indexOf(`<p class="lead">${HOME_SUBHEAD}</p>`)).toBeGreaterThan(h1);
    // ADR 0029: the scanner box links the launch report; counters say when they were read.
    expect(body).toContain("/reports/skill-scan-2026-10?from=home");
    // ADR 0023 §3: proof-strip items appear only from their minimums (10 bouts, 25 tools checked), never as a zero.
    expect(body).not.toMatch(/<b>0<\/b>/);
    const bouts = /<b>([\d,]+)<\/b><span>ranked bouts refereed/.exec(body);
    if (bouts) expect(Number(bouts[1]!.replace(/,/g, ""))).toBeGreaterThanOrEqual(10);
    const tools = /<b>([\d,]+)<\/b> tools? checked/.exec(body);
    if (tools) expect(Number(tools[1]!.replace(/,/g, ""))).toBeGreaterThanOrEqual(25);
    for (const v of ["Scan", "Watch", "Test yours"]) expect(body).not.toContain(`<h3>${v}</h3>`);
    expect(body).not.toContain("value-cards");
  });
});
