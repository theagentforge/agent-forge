import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// drizzle-kit numbers the next migration from the last journal entry's `idx` + 1, and diffs the schema against the
// alphabetically last snapshot in migrations/meta. If the two disagree (a migration numbered out of order), the next
// `drizzle-kit generate` repeats changes already made, and the migration fails on apply (docs/runbooks/migrations.md).
const root = fileURLToPath(new URL("../../../apps/forge/migrations/", import.meta.url));
const journal = JSON.parse(readFileSync(join(root, "meta/_journal.json"), "utf8"));
const num = (s) => Number(s.split("_")[0]);

describe("the drizzle migration journal and snapshots", () => {
  it("each journal entry's idx is its file number, in increasing order, with its SQL file and snapshot", () => {
    let last = -1;
    for (const e of journal.entries) {
      expect(e.idx, e.tag).toBe(num(e.tag));
      expect(e.idx, e.tag).toBeGreaterThan(last);
      last = e.idx;
      expect(existsSync(join(root, `${e.tag}.sql`)), e.tag).toBe(true);
      expect(existsSync(join(root, `meta/${e.tag.split("_")[0]}_snapshot.json`)), e.tag).toBe(true);
    }
  });

  it("the snapshots form one chain, and the last one (which generate diffs against) is the last journal entry's", () => {
    const files = readdirSync(join(root, "meta")).filter((f) => f.endsWith("_snapshot.json")).sort();
    const snaps = files.map((f) => JSON.parse(readFileSync(join(root, "meta", f), "utf8")));
    for (let i = 1; i < snaps.length; i++) expect(snaps[i].prevId, files[i]).toBe(snaps[i - 1].id);
    expect(new Set(snaps.map((s) => s.id)).size).toBe(snaps.length);
    expect(num(files.at(-1))).toBe(journal.entries.at(-1).idx);
    expect(files.length).toBe(journal.entries.length);
  });

  it("every SQL migration is in the journal", () => {
    const sql = readdirSync(root).filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, ""));
    expect(sql.sort()).toEqual(journal.entries.map((e) => e.tag).sort());
  });
});
