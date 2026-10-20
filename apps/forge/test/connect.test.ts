import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { defaultTab, installLinks } from "../src/web/connect";
import { HOME_SUBHEAD, VALUE_CARDS } from "../src/web/pages";
import { fetchWorker } from "./helpers";
import "../src/index";

const page = async (path: string, headers: Record<string, string> = {}) => (await fetchWorker(path, { headers: { Accept: "text/html", ...headers } })).text();

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
    for (const label of ["ChatGPT", "Claude", "Gemini", "Other apps", "Developers"]) expect(body).toContain(`>${label}</a>`);
    expect(body).toContain("You found the Forge");
    expect(body).toContain("1 of 3 done.");
    for (const id of ["claude", "chatgpt", "gemini", "other", "developers"]) {
      const sec = body.slice(body.indexOf(`id="tab-${id}"`), body.indexOf("</section>", body.indexOf(`id="tab-${id}"`)));
      expect((sec.match(/class="btn primary chamfer"/g) ?? []).length, id).toBe(1);
    }
    expect(body).toContain("Get the trap card");
  });

  it("uses the pre-filled Claude link to the no-sign-in endpoint, and Cursor and VS Code install links", async () => {
    const links = installLinks(env.PUBLIC_ORIGIN);
    expect(links.claude).toBe(
      `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=The%20Agent%20Forge&connectorUrl=${encodeURIComponent(`${env.PUBLIC_ORIGIN}/mcp/public`)}`,
    );
    expect(JSON.parse(atob(new URL(links.cursor.replace("cursor://", "https://")).searchParams.get("config")!))).toEqual({ url: `${env.PUBLIC_ORIGIN}/mcp` });
    expect(JSON.parse(decodeURIComponent(links.vscode.slice("vscode:mcp/install?".length)))).toEqual({ name: "forge", type: "http", url: `${env.PUBLIC_ORIGIN}/mcp` });
    const body = await page("/connect");
    expect(body).toContain(links.claude.replace(/&/g, "&amp;"));
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
    expect(await seen("zzzzzz")).toBe(false);
    // Each visit gets its own code (the page isn't cached).
    expect(/data-test-code="([a-z0-9]{6})"/.exec(await page("/connect"))![1]).not.toBe(code);
  });
});

describe("home page message (ADR 0018 §1–3)", () => {
  it("has the H1, the subhead, the referee line, the proof strip and the 4 cards in order", async () => {
    const body = await page("/");
    const h1 = body.indexOf("The social network where AI agents");
    expect(h1).toBeGreaterThan(0);
    expect(body.indexOf(HOME_SUBHEAD)).toBeGreaterThan(h1);
    // ADR 0029: the scanner box links the launch report; counters say when they were read.
    expect(body).toContain("/reports/skill-scan-2026-10?from=home");
    // ADR 0023 §3: proof-strip items appear only from their minimums (10 bouts, 25 tools checked), never as a zero.
    expect(body).not.toMatch(/<b>0<\/b>/);
    const bouts = /<b>([\d,]+)<\/b><span>ranked bouts refereed/.exec(body);
    if (bouts) expect(Number(bouts[1]!.replace(/,/g, ""))).toBeGreaterThanOrEqual(10);
    const tools = /<b>([\d,]+)<\/b> tools? checked/.exec(body);
    if (tools) expect(Number(tools[1]!.replace(/,/g, ""))).toBeGreaterThanOrEqual(25);
    const order = ["Scan", "Watch", "Test yours", "Check a tool"].map((v) => body.indexOf(`<h3>${v}</h3>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("only the developer card says MCP, and every card has one button", () => {
    for (const card of VALUE_CARDS.slice(0, 3)) expect(card.line + card.button).not.toMatch(/MCP|LLM/);
    expect(VALUE_CARDS[3]!.line).toContain("MCP");
    expect(VALUE_CARDS.map((v) => v.href)).toEqual(["/scan?from=home", "/arena?from=home", "/gauntlet?from=home", "/check?from=home"]);
  });
});
