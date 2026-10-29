import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { installLinks, LINK_APPS, linkAppFor, linkVariant, connectStepKeys, type LinkApp } from "../src/web/connect";
import { LOGIN_COOKIE, newSession, readCookie, SESSION_COOKIE, verify } from "../src/web/session";
import { connectAgent, fetchWorker } from "./helpers";
import { AGENT_DIRECTED } from "./wording";
import "../src/index";

// OA-02 (owner acquisition plan, 28 Oct 2026): /connect rebuilt around one path to an owner. Step 1 (the first check),
// the person's own "Did it say flagged?", step 2 "Link this agent to you" for their app, step 3 the Gauntlet
// (optional), and everything else in one collapsed "More ways to connect".

const ORIGIN = env.PUBLIC_ORIGIN;
const MCP = `${ORIGIN}/mcp`;
const page = async (path: string, headers: Record<string, string> = {}) => (await fetchWorker(path, { headers: { Accept: "text/html", ...headers } })).text();
const today = () => new Date().toISOString().slice(0, 10);
const counter = async (key: string) =>
  Number((await getDb(env).select({ n: t.usageDaily.n }).from(t.usageDaily).where(and(eq(t.usageDaily.day, today()), eq(t.usageDaily.key, key))))[0]?.n ?? 0);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
let ipN = 20;
const beacon = (q: string, headers: Record<string, string> = {}) =>
  fetchWorker(`/connect/step?${q}`, {
    method: "POST",
    headers: { "Sec-Fetch-Site": "same-origin", Origin: ORIGIN, Referer: `${ORIGIN}/connect`, "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile Safari", "CF-Connecting-IP": `198.51.100.${ipN++}`, ...headers },
  });
/** The visible step 2 variant on a rendered page, and the hidden ones. */
const variants = (body: string) =>
  Object.fromEntries([...body.matchAll(/<div class="link-variant" data-link-variant="([a-z-]+)"( hidden)?>/g)].map((m) => [m[1]!, m[2] ? "hidden" : "shown"]));

describe("/connect: one path to an owner (OA-02)", () => {
  it("renders step 1 → yes/no → step 2 (link) → step 3 (Gauntlet) → More ways, with at most 3 copy boxes before More ways", async () => {
    const body = await page("/connect");
    const at = ['id="first-step"', 'id="worked"', 'id="link-step"', 'id="gauntlet-step"', 'id="more-ways"'].map((m) => body.indexOf(m));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const before = body.slice(0, body.indexOf("More ways to connect"));
    expect((before.match(/class="copy-row"/g) ?? []).length).toBeLessThanOrEqual(3);
    expect([...before.matchAll(/<code id="([a-z-]+)">/g)].map((m) => m[1])).toEqual(["first-cc", "first-prompt", "link-cc"]);
    // The yes/no answers step 1's own question (litellm, "flagged"), not a different test question.
    const worked = body.slice(at[1]!, at[2]!);
    expect(worked).toContain("Did it say <b>flagged</b>?");
    expect(worked).toContain('data-worked="yes"');
    expect(worked).toContain('data-worked="no"');
    expect(worked).toContain("It didn't say flagged: common fixes");
    expect(worked).not.toContain("forge-test-");
    // Step 2 is the link step, with its heading.
    expect(body.slice(at[2]!, at[3]!)).toContain("Link this agent to you</h2>");
    expect(body.slice(at[3]!, at[4]!)).toContain("Step 3 · optional");
    // Everything else is in one collapsed section (a <details> that isn't open), including the "Test it" code check.
    expect(body).toContain('<details class="more-ways-box" id="more-ways" data-more-ways>');
    expect(body.indexOf('id="h-test"')).toBeGreaterThan(at[4]!);
    expect(body.indexOf('class="app-tiles"')).toBeGreaterThan(at[4]!);
    expect((body.match(/<details class="more-ways-box"/g) ?? []).length).toBe(1);
  });

  it("the steps are words for people: no agent-directed steering, no 'social network'", async () => {
    const body = await page("/connect");
    const steps = body.slice(body.indexOf('id="first-step"'), body.indexOf('id="more-ways"'));
    expect(AGENT_DIRECTED.exec(text(steps))?.[0] ?? null).toBeNull();
    expect(body.toLowerCase()).not.toContain("social network");
  });

  it("counts yes/no, link shown and link copied through the beacon, by fixed names only, skipping crawlers", async () => {
    expect(connectStepKeys("worked", "yes")).toEqual(["connect:worked:yes"]);
    expect(connectStepKeys("worked", "no")).toEqual(["connect:worked:no"]);
    expect(connectStepKeys("worked", "maybe")).toEqual([]);
    for (const app of LINK_APPS) {
      expect(connectStepKeys("link-shown", app)).toEqual([`connect:link-shown:${app}`]);
      expect(connectStepKeys("link-copied", app)).toEqual([`connect:link-copied:${app}`]);
    }
    expect(connectStepKeys("link-shown", "<script>")).toEqual([]);
    expect(connectStepKeys("link-copied", "chatgpt")).toEqual([]);
    const keys = ["connect:worked:yes", "connect:worked:no", "connect:link-shown:cursor", "connect:link-copied:cursor"];
    const before = await Promise.all(keys.map(counter));
    for (const q of ["e=worked&app=yes", "e=worked&app=no", "e=link-shown&app=cursor", "e=link-copied&app=cursor"]) {
      const res = await beacon(q);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    }
    await expect.poll(async () => (await Promise.all(keys.map(counter))).map((n, i) => n - before[i]!)).toEqual([1, 1, 1, 1]);
    // Crawlers and other sites are skipped.
    await beacon("e=worked&app=yes", { "User-Agent": "Googlebot/2.1" });
    await beacon("e=worked&app=yes", { "Sec-Fetch-Site": "cross-site", Origin: "https://elsewhere.example" });
    await new Promise((r) => setTimeout(r, 50));
    expect(await counter("connect:worked:yes")).toBe(before[0]! + 1);
  });

  it("opens step 2 on the app the person picked or came from", () => {
    expect(linkAppFor(undefined, undefined)).toBe("claude-code");
    expect(linkAppFor("cursor", "https://claude.ai/new")).toBe("cursor");
    expect(linkAppFor("nope", "https://claude.ai/new")).toBe("claude");
    expect(linkAppFor(undefined, "https://forum.cursor.com/t/1")).toBe("cursor");
    expect(linkAppFor(undefined, "https://code.visualstudio.com/docs")).toBe("vscode");
  });
});

// One snapshot per app: what the person sees in step 2 (tags stripped), and that the page shows only that app.
const SNAPSHOTS: Record<LinkApp, string> = {
  "claude-code": `In your terminal, run: claude mcp add --scope user --transport http forge-reports ${MCP} Copy Start Claude Code, type /mcp , pick forge-reports and choose Authenticate . Your browser opens GitHub: sign in, and you're done. Have the Forge plugin? forge-reports is already there: just /mcp → forge-reports → Authenticate .`,
  claude: `Add to Claude, signed in Claude opens "Add custom connector" with the name and address filled in. Press Add . Press Connect and sign in with GitHub.`,
  cursor: "Add to Cursor, signed in Cursor opens its MCP settings with forge-reports filled in. Press Install . Press the sign-in button next to forge-reports and sign in with GitHub.",
  vscode: "Install in VS Code, signed in VS Code asks to install forge-reports . Press Install . When it asks to sign in, allow it and sign in with GitHub.",
  other: `Add the signed-in address as a remote MCP server, and sign in with GitHub when your app asks: ${MCP} Codex and Gemini CLI have one line each under Link from other apps .`,
};

describe("step 2 for each app (OA-02 snapshots)", () => {
  const links = installLinks(ORIGIN);

  it.each(LINK_APPS.map((a) => [a]))("%s", async (app) => {
    expect(text(String(linkVariant(app, ORIGIN, links)))).toBe(SNAPSHOTS[app]);
    const body = await page(`/connect?app=${app}`);
    expect(variants(body)).toEqual(Object.fromEntries(LINK_APPS.map((a) => [a, a === app ? "shown" : "hidden"])));
    expect(body).toContain(`data-link-pick="${app}" aria-current="true"`);
  });

  it("every one-click link goes to the signed-in address, under the signed-in name", () => {
    expect(Object.fromEntries(new URL(links.claudeSignedIn).searchParams)).toMatchObject({ connectorUrl: MCP, connectorName: "The Agent Forge (reports)" });
    const cursor = new URL(links.cursorSignedIn.replace("cursor://", "https://"));
    expect(cursor.searchParams.get("name")).toBe("forge-reports");
    expect(JSON.parse(atob(cursor.searchParams.get("config")!))).toEqual({ url: MCP });
    expect(JSON.parse(decodeURIComponent(links.vscodeSignedIn.slice("vscode:mcp/install?".length)))).toEqual({ name: "forge-reports", type: "http", url: MCP });
    for (const [app, href] of [["claude", links.claudeSignedIn], ["cursor", links.cursorSignedIn], ["vscode", links.vscodeSignedIn]] as const)
      expect(String(linkVariant(app, ORIGIN, links))).toContain(`href="${href.replace(/&/g, "&amp;")}"`);
  });
});

describe("sign-ins from /connect are attributed (OA-01 tags, ADR 0073)", () => {
  const signInHref = (body: string) => /<a [^>]*href="([^"]+)" data-link-signin>/.exec(body)![1]!.replace(/&amp;/g, "&");

  it("the optional website sign-in carries from=connect and comes back to step 2 for the same app", async () => {
    const href = signInHref(await page("/connect?app=cursor"));
    const u = new URL(href, ORIGIN);
    expect(u.pathname).toBe("/auth/login");
    expect(u.searchParams.get("from")).toBe("connect");
    expect(u.searchParams.get("next")).toBe("/connect?app=cursor#link-step");
    // /auth/login accepts it and keeps the tag through GitHub sign-in.
    const res = await fetchWorker(href, { redirect: "manual" });
    expect(res.status).toBe(302);
    const login = await verify<{ from?: string; next?: string }>(env.SESSION_SECRET, readCookie(res.headers.get("Set-Cookie"), LOGIN_COOKIE));
    expect(login).toMatchObject({ from: "connect", next: "/connect?app=cursor#link-step" });
  });

  it("keeps a known tag the visitor arrived with (the plugin's line), and files unknown ones under connect", async () => {
    expect(new URL(signInHref(await page("/connect?from=plugin")), ORIGIN).searchParams.get("from")).toBe("plugin");
    expect(new URL(signInHref(await page("/connect?from=whatever")), ORIGIN).searchParams.get("from")).toBe("connect");
    expect(new URL(signInHref(await page("/connect?from=check")), ORIGIN).searchParams.get("from")).toBe("connect");
  });

  it("a signed-in person sees their linked agent in step 2, and no sign-in link", async () => {
    const { human, agent } = await connectAgent();
    const cookie = `${SESSION_COOKIE}=${await newSession(env.SESSION_SECRET, human.id)}`;
    const body = await page("/connect", { Cookie: cookie });
    const step2 = body.slice(body.indexOf('id="link-step"'), body.indexOf('id="gauntlet-step"'));
    expect(step2).toContain("data-signed-in");
    expect(step2).toContain(`✓ Linked to you: <a href="/a/${encodeURIComponent(agent.handle)}">${agent.handle}</a>`);
    expect(step2).not.toContain("data-link-signin");
    // Someone else's view never shows it, and the page is never cached.
    const anon = await fetchWorker("/connect", { headers: { Accept: "text/html" } });
    expect(await anon.text()).not.toContain(agent.handle);
    expect(anon.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("the yes/no is usable by keyboard and screen reader (review, 28 Oct)", () => {
  it("each answer button names the section it opens and moves focus there", async () => {
    const js = (await import("../public/site.js?raw")).default as string;
    // The buttons point at what they open (aria-controls), and the opened part gets the focus.
    expect(js).toContain('b.setAttribute("aria-controls", target.id)');
    expect(js).toContain('focusOn(linkStep.querySelector("h2"))');
    expect(js).toContain('focusOn(fixes.querySelector("summary"))');
    const body = await page("/connect");
    expect(body).toMatch(/id="link-step"[^>]*data-link-step/);
    expect(body).toMatch(/id="fixes" data-worked-fixes/);
    expect(body).toMatch(/<h2 id="h-link">/);
  });
});
