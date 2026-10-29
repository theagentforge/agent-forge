import { CANARY, CANARY_GUID, heldOutSeeds, PRIVATE_TASK_IDS, TASKS } from "@forge/arena";
import { describe, expect, it } from "vitest";
import { TRAP_SET, TRAP_SET_1_1_CORRECTION, TRAP_SET_VERSIONS, trapSetVersions } from "../src/arena/benchmark";
import {
  diffTraps,
  missingSnapshots,
  parseSnapshot,
  sha256Hex,
  snapshotOf,
  trapSetDefinition,
} from "../src/arena/benchmark-versions";
import { CORRECTIONS } from "../src/arena/corrections";
import { SNAPSHOTS } from "../src/seed/benchmark";
import { SHOWS_EMBARGOED } from "./fixtures/embargoed";
import { fetchWorker } from "./helpers";
import "../src/index";

// B3-05 (ADR 0101): frozen Trap Set snapshots, /benchmark/versions.json, /benchmark/diff and the held-out contract.

const PRIVATE_ID = /FA-[A-Z]{3}-1\d{2}/;
const json = async (path: string) => (await (await fetchWorker(path)).json()) as any;

describe("frozen snapshots", () => {
  it("snapshot files end in .json.txt and wrangler bundles them as text (a plain .json is parsed by esbuild and broke deploy, 29 Oct)", () => {
    const files = Object.keys(import.meta.glob("../src/seed/benchmark/v*", { eager: true, query: "?raw", import: "default" }));
    expect(files.length).toBe(SNAPSHOTS.length);
    for (const f of files) expect(f, f).toMatch(/\/v\d+\.\d+(\.\d+)?\.json\.txt$/);
    const wrangler = Object.values(import.meta.glob<string>("../wrangler.jsonc", { eager: true, query: "?raw", import: "default" }))[0];
    expect(wrangler).toContain('"**/seed/benchmark/v*.json.txt"');
  });

  it("every released version has a committed snapshot, and every snapshot is a released version", () => {
    expect(missingSnapshots()).toEqual([]);
    expect(SNAPSHOTS.map((s) => s.version)).toEqual(TRAP_SET_VERSIONS.map((v) => v.version));
  });

  it("a version bump without a snapshot fails the release check (1.1 once its re-score is applied)", () => {
    const applied = CORRECTIONS.map((c) => (c.id === TRAP_SET_1_1_CORRECTION ? { ...c, published: true, applied: true, counts: { checked: 10, changed: 1, passToFail: 1, failToPass: 0, events: 1, models: 1 } } : c));
    const bumped = trapSetVersions(applied as typeof CORRECTIONS);
    expect(bumped.at(-1)!.version).toBe("1.1");
    expect(missingSnapshots(bumped)).toEqual(snapshotOf("1.1") ? [] : ["1.1"]);
  });

  it("no snapshot's bytes have changed since it was frozen", async () => {
    for (const s of SNAPSHOTS) expect(await sha256Hex(s.text), `v${s.version}.json`).toBe(s.sha256);
  });

  // Review (ADR 0105): index.ts is regenerated from the files (`freeze-trap-set.mjs --index`), so on its own the check
  // above would pass after an edit plus a re-index. These hashes are written here by hand when a version is frozen and
  // never changed: append a line, never edit one.
  const FROZEN_SHA256: Record<string, string> = {
    "1.0": "d5835388be5ef57222d5f3739b00fe9794bd543e60083fdd9498df29d3cceb71",
    "1.0.1": "e6fb92c0da4f3e69421d04273cbff00c80972b10d1e22ec2c10043bed75ee0b9",
  };
  it("every snapshot's sha256 equals the one pinned when it was frozen (an edit plus a re-index still fails)", async () => {
    expect(Object.keys(FROZEN_SHA256)).toEqual(SNAPSHOTS.map((s) => s.version));
    for (const s of SNAPSHOTS) {
      expect(s.sha256, `v${s.version} in index.ts`).toBe(FROZEN_SHA256[s.version]);
      expect(await sha256Hex(s.text), `v${s.version}.json.txt bytes`).toBe(FROZEN_SHA256[s.version]);
    }
  });

  it("git never rewrites a snapshot's line endings (.gitattributes), so a Windows checkout serves the same bytes", () => {
    const attrs = Object.values(import.meta.glob<string>("../../../.gitattributes", { eager: true, query: "?raw", import: "default" }))[0] ?? "";
    expect(attrs).toMatch(/^apps\/forge\/src\/seed\/benchmark\/\*\.json\.txt -text$/m);
  });

  it("each snapshot says what it is: 1.0 reconstructed (not the original bytes), 1.0.1 frozen", () => {
    for (const s of SNAPSHOTS) {
      const m = parseSnapshot(s);
      expect(m.version).toBe(s.version);
      expect(m.snapshot.trap_set_version).toBe(s.version);
      expect(m.snapshot.from_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(m.snapshot.counts_as_of).toBe(m.snapshot.made_on);
      expect(m.snapshot.results.included).toBe(false);
      expect(m.traps.every((t) => t.trap_set_version === s.version)).toBe(true);
      expect(m.counts.traps).toBe(m.traps.length);
      expect(m.changelog.at(-1)!.version).toBe(s.version);
    }
    const v10 = parseSnapshot(snapshotOf("1.0")!).snapshot;
    expect(v10).toMatchObject({ kind: "reconstructed", original_bytes: false, made_on: "2026-10-29" });
    expect(v10.statement).toContain(`Reconstructed on 29 Oct 2026 from the catalog at commit ${v10.from_commit.slice(0, 7)}`);
    expect(v10.statement).toContain("Not the original bytes");
    expect(parseSnapshot(snapshotOf("1.0.1")!).snapshot).toMatchObject({ kind: "frozen", original_bytes: true });
  });

  it("the current version's snapshot matches the code: a trap change without a version bump fails here", () => {
    const { snapshot: _s, ...frozen } = parseSnapshot(snapshotOf(TRAP_SET.version)!);
    expect(frozen).toEqual(JSON.parse(JSON.stringify(trapSetDefinition())));
  });

  it("every snapshot carries the canary and nothing private", () => {
    for (const s of SNAPSHOTS) {
      const m = parseSnapshot(s);
      expect(m.canary).toBe(CANARY);
      expect(m.canary_guid).toBe(CANARY_GUID);
      expect(s.text).not.toMatch(PRIVATE_ID);
      expect(s.text).not.toMatch(SHOWS_EMBARGOED);
      for (const id of PRIVATE_TASK_IDS) expect(s.text).not.toContain(`"${id}`);
      expect(m).not.toHaveProperty("results");
    }
  });

  it("serves each snapshot byte for byte, with the sha256 listed in versions.json", async () => {
    const v = await json("/benchmark/versions.json");
    expect(v.canary).toBe(CANARY);
    expect(v.current).toBe(TRAP_SET.version);
    expect(v.versions.map((x: any) => x.version)).toEqual(TRAP_SET_VERSIONS.map((x) => x.version));
    for (const s of SNAPSHOTS) {
      const res = await fetchWorker(`/benchmark/v${s.version}.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      const body = await res.text();
      expect(body).toBe(s.text);
      const listed = v.versions.find((x: any) => x.version === s.version);
      expect(listed.snapshot.sha256).toBe(await sha256Hex(body));
      expect(listed.snapshot.bytes).toBe(new TextEncoder().encode(body).length);
      expect(listed.counts).toEqual(parseSnapshot(s).counts);
      expect(res.headers.get("ETag")).toBe(`"sha256-${s.sha256}"`);
    }
  });

  it("v1.json stays the live latest and says so", async () => {
    const d = await json("/benchmark/v1.json");
    expect(d.latest).toMatchObject({ live: true, rebuilt_on_each_request: true });
    expect(new URL(d.latest.frozen_snapshot).pathname).toBe(`/benchmark/v${TRAP_SET.version}.json`);
    expect((await fetchWorker(new URL(d.latest.frozen_snapshot).pathname)).status).toBe(200);
    const page = await (await fetchWorker("/benchmark")).text();
    expect(page).toContain('href="/benchmark/versions.json"');
    expect(page).toContain('href="/benchmark/held-out"');
    expect(page).toContain("not the original bytes");
  });
});

describe("diff", () => {
  const rec = (id: string, extra: Record<string, unknown> = {}) => ({ id, trap_set_version: "x", trigger: { referee_check: "a" }, ...extra });

  it("lists traps added, changed (with the fields) and removed, by id", () => {
    const from = [rec("FA-PAY-001"), rec("FA-PAY-002"), { ...rec("FA-POL-001"), trap_set_version: "1.0" }];
    const to = [{ ...rec("FA-PAY-001"), trap_set_version: "2.0" }, rec("FA-PAY-002", { trigger: { referee_check: "b" } }), rec("FA-DUP-001")];
    expect(diffTraps(from, to)).toEqual({ added: ["FA-DUP-001"], changed: [{ id: "FA-PAY-002", fields: ["trigger.referee_check"] }], removed: ["FA-POL-001"], unchanged: 1 });
  });

  it("1.0 to 1.0.1: no trap added or removed; every record gained canary_guid and nothing else", async () => {
    const res = await fetchWorker("/benchmark/diff?from=1.0&to=1.0.1");
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.canary).toBe(CANARY);
    expect(d.traps.added).toEqual([]);
    expect(d.traps.removed).toEqual([]);
    expect(d.traps.changed.length).toBe(d.to.traps);
    expect(d.traps.changed.every((c: any) => c.fields.length === 1 && c.fields[0] === "canary_guid")).toBe(true);
    expect(d.from).toMatchObject({ version: "1.0", kind: "reconstructed", original_bytes: false });
    expect(d.rules_changed).toBe(false);
  });

  it("is never edge-cached, so a different `from` (which the page cache drops from its key) gets its own answer", async () => {
    const a = await fetchWorker("/benchmark/diff?from=1.0&to=1.0.1");
    expect(a.headers.get("Cache-Control")).toBe("no-store");
    const b = (await (await fetchWorker("/benchmark/diff?from=1.0.1&to=1.0.1")).json()) as any;
    expect(b.from.version).toBe("1.0.1");
    expect(b.traps.changed).toEqual([]);
  });

  it("refuses an unknown version", async () => {
    const res = await fetchWorker("/benchmark/diff?from=0.9&to=1.0.1");
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).versions).toEqual(SNAPSHOTS.map((s) => s.version));
  });
});

describe("held-out contract", () => {
  const seeds = [...new Set([...TASKS.map((t) => t.id), ...PRIVATE_TASK_IDS].flatMap((id) => heldOutSeeds(id)))];

  it("is published as HTML and JSON, with the canary", async () => {
    const page = await fetchWorker("/benchmark/held-out");
    expect(page.status).toBe(200);
    const htmlText = await page.text();
    expect(htmlText).toContain(CANARY);
    expect(htmlText).toContain("What is kept back");
    expect(htmlText).toContain("What a licensee receives under NDA");
    const d = await json("/benchmark/held-out.json");
    expect(d.canary).toBe(CANARY);
    expect(d.kept_back.map((k: any) => k.item)).toEqual(["held_out_seeds", "longitudinal_panel", "private_trap_families", "unpublished_job_versions", "trap_generator_and_job_source"]);
    expect(d.published_about_them).toMatchObject({ runs_published: false, seeds_published: false });
    expect(d.breaking_changes.held_out_protocol_change_is_major).toBe(true);
    expect((await json("/benchmark/held-out?format=json")).kept_back).toEqual(d.kept_back);
  });

  it("lists no private id, private job, seed or seed count", async () => {
    for (const path of ["/benchmark/held-out", "/benchmark/held-out.json"]) {
      const text = await (await fetchWorker(path)).text();
      expect(text).not.toMatch(PRIVATE_ID);
      expect(text).not.toMatch(SHOWS_EMBARGOED);
      for (const id of PRIVATE_TASK_IDS) expect(text).not.toContain(id);
      for (const s of seeds) expect(text, `seed ${s}`).not.toMatch(new RegExp(`(^|\\D)${s}(\\D|$)`));
    }
  });
});
