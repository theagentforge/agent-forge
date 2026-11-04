import { describe, expect, it } from "vitest";
import skillScanReport from "../../../docs/reports/2026-10-skill-scan.md";
import { LAUNCH_SCAN, launchScanHeadline, parseLaunchScan } from "../src/reports/skill-scan-facts";
import { REPORT_FACTS } from "../src/web/security";
import { fetchWorker } from "./helpers";
import "../src/index";

// The home page's launch-scan line is built from the report's own table (30 Oct), not typed by hand.

describe("launch-scan facts come from the report's table", () => {
  it("reads 30 of 9,014 (0.33%) and the report's date", () => {
    expect(LAUNCH_SCAN).toEqual({ date: "19 Oct 2026", ordinary: 9014, flagged: 30, pct: "0.33" });
    expect(launchScanHeadline()).toBe("Launch scan, 19 Oct 2026: 30 of 9,014 ordinary public skills flagged (0.33%)");
  });
  it("agrees with the dated figures the security pages use (REPORT_FACTS)", () => {
    expect(LAUNCH_SCAN!.ordinary).toBe(REPORT_FACTS.skill_scan.ordinary_skills);
    expect(LAUNCH_SCAN!.flagged).toBe(REPORT_FACTS.skill_scan.flagged_ordinary);
    expect(REPORT_FACTS.skill_scan.date).toBe("2026-10-19");
  });
  it("a wrong denominator in the table changes the line; a rate that doesn't match its counts, or no table, gives no line", () => {
    const wrongDenominator = skillScanReport.replace("| Files | 9,014 |", "| Files | 9,930 |");
    expect(parseLaunchScan(wrongDenominator)).toBeNull(); // 30 / 9,930 is 0.30%, not the 0.33% printed beside it
    const both = wrongDenominator.replace("30 (0.33%)", "30 (0.30%)");
    expect(launchScanHeadline(parseLaunchScan(both))).toBe("Launch scan, 19 Oct 2026: 30 of 9,930 ordinary public skills flagged (0.30%)");
    expect(parseLaunchScan("# no table here")).toBeNull();
    expect(launchScanHeadline(null)).toBeNull();
  });
  it("the home page renders the line exactly as before", async () => {
    const page = (await (await fetchWorker("/", { headers: { Accept: "text/html" } })).text()).replaceAll("&#39;", "'");
    expect(page).toContain(
      `<p class="small">Launch scan, 19 Oct 2026: 30 of 9,014 ordinary public skills flagged (0.33%), mostly vendors' own installers; no malware found by this method. <a href="/reports/skill-scan-2026-10?from=home">Read the report</a></p>`,
    );
  });
});
