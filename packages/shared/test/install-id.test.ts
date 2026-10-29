import { describe, expect, it } from "vitest";
import { installIdDebugLine, installIdEnvOff, installIdNotice, isInstallId, parseInstallIdState, planInstallId, serializeInstallIdState } from "../src/install-id";

const ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const fresh = () => ID;

describe("install ID (B3-09)", () => {
  it("accepts only UUID v4", () => {
    expect(isInstallId(ID)).toBe(true);
    expect(isInstallId("3b241101-e2bb-1255-8caf-4136c566a962")).toBe(false); // v1
    expect(isInstallId(ID.toUpperCase())).toBe(false);
    expect(isInstallId("me@example.com")).toBe(false);
    expect(isInstallId(null)).toBe(false);
  });

  it("makes one on first run, saves it, and shows the notice once", () => {
    const first = planInstallId(null, {}, fresh);
    expect(first).toMatchObject({ send: ID, id: ID, notice: true, debug: false, off: null });
    expect(JSON.parse(first.save!)).toEqual({ enabled: true, id: ID });
    // The next run reads the same file: the same ID, nothing to save, no notice.
    const again = planInstallId(first.save, {}, () => "4c241101-e2bb-4255-8caf-4136c566a962");
    expect(again).toMatchObject({ send: ID, id: ID, save: null, notice: false });
  });

  it("sends nothing with FORGE_NO_ANALYTICS, DO_NOT_TRACK or CI, and makes no ID", () => {
    for (const env of [{ FORGE_NO_ANALYTICS: "1" }, { DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { CI: "true" }]) {
      const p = planInstallId(null, env, fresh);
      expect(p).toMatchObject({ send: null, id: null, save: null, notice: false });
      expect(p.off).not.toBeNull();
    }
    expect(installIdEnvOff({ DO_NOT_TRACK: "0", FORGE_NO_ANALYTICS: "", CI: "false" })).toBeNull();
  });

  it("sends nothing once disabled, and forgets the ID", () => {
    const off = serializeInstallIdState({ enabled: false, id: ID });
    expect(off).not.toContain(ID);
    expect(planInstallId(off, {}, fresh)).toMatchObject({ send: null, off: "disabled" });
    expect(parseInstallIdState("not json")).toEqual({ enabled: true, id: null });
  });

  it("debug mode prints what would be sent and sends nothing", () => {
    const p = planInstallId(null, { FORGE_TELEMETRY_DEBUG: "1" }, fresh);
    expect(p).toMatchObject({ send: null, id: ID, debug: true });
    expect(installIdDebugLine(ID, "cli", "https://x/api/v1/check?id=npm%3Aa")).toContain(`forge-install-id: ${ID}`);
  });

  it("refuses a made-up ID that isn't a UUID v4", () => {
    expect(planInstallId(null, {}, () => "/home/me")).toMatchObject({ send: null, save: null });
  });

  it("the notice is one line", () => {
    expect(installIdNotice("forge telemetry disable")).not.toContain("\n");
  });
});
