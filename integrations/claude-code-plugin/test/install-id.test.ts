import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installIdFor } from "../src/hooks/common";
import { decide, withNotice } from "../src/hooks/pre-install";

// B3-09 (ADR 0103): the plugin's anonymous install ID. A UUID v4 in the plugin's data folder, stable across runs, sent
// as forge-install-id with install checks; off with the `install_id` setting, FORGE_NO_ANALYTICS, DO_NOT_TRACK or CI.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORIGIN = "https://theagentforge.io";
const saved = { ...process.env };

beforeEach(() => {
  process.env.CLAUDE_PLUGIN_DATA = mkdtempSync(join(tmpdir(), "forge-plugin-"));
  delete process.env.CLAUDE_PLUGIN_OPTION_INSTALL_ID;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("plugin install ID", () => {
  it("makes a UUID v4 once, keeps it, and gives the notice only the first time", () => {
    const first = installIdFor(ORIGIN, {});
    const id = first.headers["forge-install-id"];
    expect(id).toMatch(UUID_V4);
    expect(first.notice).toContain("a random install ID");
    expect(JSON.parse(readFileSync(join(process.env.CLAUDE_PLUGIN_DATA!, "install-id.json"), "utf8"))).toEqual({ enabled: true, id });
    const again = installIdFor(ORIGIN, {});
    expect(again.headers["forge-install-id"]).toBe(id);
    expect(again.notice).toBeNull();
  });

  it("sends nothing with the env opt-outs or the plugin setting off", () => {
    for (const env of [{ FORGE_NO_ANALYTICS: "1" }, { DO_NOT_TRACK: "1" }, { CI: "true" }]) expect(installIdFor(ORIGIN, env)).toEqual({ headers: {}, notice: null });
    process.env.CLAUDE_PLUGIN_OPTION_INSTALL_ID = "false";
    expect(installIdFor(ORIGIN, {})).toEqual({ headers: {}, notice: null });
  });

  it("debug mode sends nothing", () => {
    expect(installIdFor(ORIGIN, { FORGE_TELEMETRY_DEBUG: "1" }).headers).toEqual({});
  });

  it("the check carries the header, and the notice goes only to the person (systemMessage)", async () => {
    const seen: Headers[] = [];
    const fetcher = (async (_u: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return Response.json({ known: true, tool: null, version: "1", forge_score: 90, distinct_owners: 5, verified_owners: 5, security_status: "clear", page_url: `${ORIGIN}/t/x` });
    }) as unknown as typeof fetch;
    const id = installIdFor(ORIGIN, {});
    const out = withNotice(await decide("npm i good-pkg", ORIGIN, fetcher, { headers: id.headers }), id.notice);
    expect(seen[0]!.get("forge-install-id")).toBe(id.headers["forge-install-id"]);
    expect(seen[0]!.get("user-agent")).toBe("theagentforge-claude-plugin");
    expect(out?.systemMessage).toContain("a random install ID");
    expect(JSON.stringify((out as { hookSpecificOutput?: unknown }).hookSpecificOutput ?? {})).not.toContain("install ID");
    expect(withNotice(null, "n")).toEqual({ systemMessage: "n" });
    expect(withNotice(null, null)).toBeNull();
  });

  it("the setting is called Random install ID, keeps its key install_id, and says what Cloudflare's logs keep (Dinike, 29 Oct)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"));
    const setting = manifest.userConfig.install_id;
    expect(setting.title).toBe("Random install ID");
    expect(setting.default).toBe(true);
    expect(setting.description).toContain("Cloudflare's request logs keep each request (its address, which names the package checked, and its headers, including this ID) with the IP address for up to 7 days");
    expect(JSON.stringify(manifest)).not.toMatch(/anonymous install/i);
    expect(installIdFor(ORIGIN, {}).notice).toContain('the plugin setting "Random install ID"');
  });
});
