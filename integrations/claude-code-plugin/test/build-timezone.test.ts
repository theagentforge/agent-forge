import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 29 Oct 2026: zips built in Colombo (UTC+05:30) didn't match CI's (UTC), because zip times are local DOS fields.
// The committed zips must check as current in any time zone.
const build = join(dirname(fileURLToPath(import.meta.url)), "..", "build.mjs");

describe("plugin zips are the same bytes in every time zone", () => {
  for (const tz of ["UTC", "Asia/Colombo", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    it(`build --check passes with TZ=${tz}`, () => {
      const out = execFileSync(process.execPath, [build, "--check"], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
      expect(out).toContain("up to date");
    }, 60_000);
  }
});
