import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as t from "../src/db/schema";
import { getDb } from "../src/services/db";
import { asOfText, PUBLIC_NUMBERS_SECONDS, publicNumbersCache } from "../src/services/public-numbers";
import { fetchWorker } from "./helpers";
import "../src/index";

// Build plan 5 Nov, item 4: /stats.json read 19,998 skills and 73,162 tools while /dataset, read later, read 20,149
// and 73,186. Pages read in the same minute (in one data centre) share one snapshot, so their numbers are equal; pages
// read in other minutes or data centres can differ, so every page states when it was counted, and the sentence under
// the numbers claims only that (wording approved by Dinike, 5 Nov).

const uid = (n: number) => `00000000-0000-4000-9205-${String(n).padStart(12, "0")}`;
let n = 1;
const addTool = () => getDb(env).insert(t.tools).values({ id: uid(n), kind: "mcp_server", canonicalId: `npm:item4-${n++}` });
const addScan = () =>
  getDb(env)
    .insert(t.skillScans)
    .values({ fingerprint: `sha256:${String(n++).padStart(64, "0")}`, verdict: "clear", findings: [], counts: {}, rulesVersion: "r1", bytes: 10, firstSeen: Date.now(), lastSeen: Date.now() });
const bust = () => `r=${Date.now()}-${Math.random()}`;
const left = () => PUBLIC_NUMBERS_SECONDS - (Math.floor(Date.now() / 1000) % PUBLIC_NUMBERS_SECONDS);
const roomInMinute = async (s = 12) => {
  if (left() < s) await new Promise((r) => setTimeout(r, left() * 1000 + 250));
};

type Work = { skills_scanned: number | null; tools_tracked: number | null };
async function stats() {
  const j = (await (await fetchWorker(`/stats.json?${bust()}`)).json()) as { as_of: string; blended: { work: Work } };
  return { as_of: j.as_of, skills: j.blended.work.skills_scanned, tools: j.blended.work.tools_tracked };
}
async function dataset() {
  const j = (await (await fetchWorker(`/dataset.json?${bust()}`)).json()) as { as_of: string; contents: { skill_scans: { distinct_skill_files_scanned: number | null }; tools_with_a_page: number | null } };
  return { as_of: j.as_of, skills: j.contents.skill_scans.distinct_skill_files_scanned, tools: j.contents.tools_with_a_page };
}
const html = async (path: string) => (await fetchWorker(`${path}?${bust()}`, { headers: { Accept: "text/html" } })).text();

beforeAll(async () => {
  publicNumbersCache.enabled = true;
  for (let i = 0; i < 30; i++) await addTool();
  for (let i = 0; i < 30; i++) await addScan();
});
afterAll(() => {
  publicNumbersCache.enabled = false;
});

describe("one count, one time (build plan 5 Nov, item 4)", () => {
  it("/stats.json and /dataset.json read in the same minute give equal numbers and one counted-at time, even with rows added between", async () => {
    await roomInMinute();
    const a = await stats();
    await addTool();
    await addScan();
    const b = await dataset();
    expect(a.tools).not.toBeNull();
    expect(b).toEqual(a);
  });

  it("/stats, /dataset and the home page, read in the same minute, show the same counted-at time as the JSON twins", async () => {
    await roomInMinute();
    const j = await stats();
    const asOf = (page: string) => [...page.matchAll(/data-as-of="([^"]+)"/g)].map((m) => m[1]);
    for (const path of ["/stats", "/dataset", "/"]) {
      const page = await html(path);
      const seen = asOf(page);
      expect(seen.length, path).toBeGreaterThan(0);
      for (const s of seen) expect(s, path).toBe(j.as_of);
      expect(page, path).toContain(`Counted at ${j.as_of.slice(11, 16)} UTC`);
    }
  });

  it("the sentence under the numbers says each page states when it was counted, not that every page shares one count", async () => {
    expect(asOfText({ as_of: "2026-11-05T10:41:07.000Z" })).toBe("Counted at 10:41 UTC on 2026-11-05; each page states when it was counted.");
    for (const path of ["/stats", "/dataset"]) {
      const page = await html(path);
      expect(page, path).toContain("each page states when it was counted");
      expect(page, path).not.toMatch(/share one count|the ones <a href="\/stats">\/stats<\/a> shows/);
    }
  });
});
