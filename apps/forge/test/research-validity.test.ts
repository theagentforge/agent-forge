import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TRAP_CATALOG } from "@forge/arena";
import { describe, expect, it } from "vitest";
import { FRONTIER_PRIVATE_TASKS, HELDOUT_SEEDS, PRIVATE_TASKS, PRIVATE_TRAP_CATALOG } from "../../../packages/arena/src/private";
import { REFEREE_AUDIT_2 } from "../src/arena/error-record";
import { citationCff, citationLine, frozenVersions, RESEARCH_VALIDITY_JSON_PATH, RESEARCH_VALIDITY_PATH, researchIndex, versionCffPath, versionJsonPath, versionPath } from "../src/arena/research-validity";
import { REFEREE_VALIDITY_SNAPSHOTS } from "../src/seed/research";
import worker from "../src/index";
import { EMBARGOED, SHOWS_EMBARGOED } from "./fixtures/embargoed";

// ADR 0149: the referee audit as a citable research report. Each version is frozen text, served byte for byte and
// never recomputed; only already-public material is in it; it sits behind the validity pack's release switch.

const OFF = { ...env, VALIDITY_PUBLIC: undefined } as Env;
const ON = { ...env, VALIDITY_PUBLIC: "on" } as Env;
async function get(path: string, e: Env, init?: RequestInit) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${env.PUBLIC_ORIGIN}${path}`, init) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const PATHS = [RESEARCH_VALIDITY_PATH, RESEARCH_VALIDITY_JSON_PATH, versionPath(1), versionJsonPath(1), versionCffPath(1)];
const v1 = frozenVersions()[0]!;

describe("release switch (checked before any released fetch)", () => {
  it("every research path is 404 while the validity pack is unreleased", async () => {
    for (const p of PATHS) expect((await get(p, OFF)).status, p).toBe(404);
  });
  it("/dataset names no research report while unreleased", async () => {
    const page = await (await get("/dataset", OFF)).text();
    expect(page).not.toContain(RESEARCH_VALIDITY_PATH);
    const j = (await (await get("/dataset.json", OFF)).json()) as { formats: { referee_validity_report: unknown } };
    expect(j.formats.referee_validity_report).toBeNull();
  });
});

describe("frozen versions", () => {
  it("version 1's bytes never change (sha256 pinned here and in the registry)", async () => {
    expect(REFEREE_VALIDITY_SNAPSHOTS.map((s) => s.version)).toEqual([1]);
    const s = REFEREE_VALIDITY_SNAPSHOTS[0]!;
    expect(s.sha256).toBe("521ddecbbd91f02f50227edd68c5226e5f893a54765ee83b7b9fe35eead1bf34");
    for (const x of REFEREE_VALIDITY_SNAPSHOTS) expect(await sha256(x.text), `v${x.version}`).toBe(x.sha256);
  });

  it("each version's own fields agree with its registry entry and its path", () => {
    for (const { snapshot, doc } of frozenVersions()) {
      expect(doc.version).toBe(snapshot.version);
      expect(doc.date).toBe(snapshot.date);
      expect(doc.immutable).toBe(true);
      expect(doc.url).toBe(`https://theagentforge.io${versionPath(doc.version)}`);
      expect(doc.citation.text).toBe(citationLine(doc));
    }
  });

  it("version 1 is a faithful copy of referee audit 2's own figures and pins the served audit file", async () => {
    const d = v1.doc;
    const a = REFEREE_AUDIT_2;
    expect(d.snapshot_of.audit_id).toBe("referee-audit-2");
    expect(d.snapshot_of.audit_file_sha256).toBe(await sha256(`${JSON.stringify(a, null, 1)}\n`));
    expect(d.frame.runs).toBe(a.frame.runs);
    expect(d.frame.frame_sha256).toBe(a.frame.sha256);
    expect(d.results.agreement).toEqual({ n: a.overall.n, agree: a.overall.agree, rate: a.overall.agreement, ci_95: a.overall.ci_95, kappa: a.overall.kappa });
    expect(d.results.published_error_rate.wrong).toBe(a.adjudicated.published_verdicts_found_wrong.k);
    expect(d.results.published_error_rate.n).toBe(a.overall.n);
    expect(d.results.published_error_rate.ci_95).toEqual(a.adjudicated.published_verdicts_found_wrong.ci_95);
    expect(d.disagreements.map((x) => `${x.run}/${x.public_trap_id}`).sort()).toEqual(a.disagreements.map((x) => `${x.run}/${x.public_trap_id}`).sort());
    // The numbers the validity page has published since 7 Nov, nothing new.
    expect([d.results.agreement.agree, d.results.agreement.n, d.frame.runs, d.results.published_error_rate.wrong]).toEqual([1433, 1437, 375, 4]);
  });

  it("every disagreement links its public replay and says what the referee said, what the checker said and how it was resolved", () => {
    for (const x of v1.doc.disagreements) {
      expect(x.replay).toBe(`https://theagentforge.io/arena/run/${x.run}`);
      expect(x.replay_json).toBe(`${x.replay}.json`);
      expect(["sprung", "not_sprung"]).toContain(x.referee_published);
      expect(["sprung", "not_sprung"]).toContain(x.checker);
      expect(x.referee_published).not.toBe(x.checker);
      expect(x.resolution_at_audit).toMatch(/^referee_wrong_/);
      expect(x.status.status).toBe("fixed_and_rescored");
      expect(x.status.rescored?.correction).toBe("2026-11-rules-0.7-payee-claims");
      expect((x.evidence as { text?: string } | null)?.text).toBeTruthy();
    }
  });

  it("has the method, correction history, limitations and public reproduce steps", () => {
    const d = v1.doc;
    expect(d.method.checker).toContain("packages/arena/src/audit/checkers.ts");
    expect(d.method.frontier_checker).toMatchObject({ file: "packages/arena/src/audit/frontier-checkers.ts", in_this_version: false });
    expect(d.correction_history.map((e) => e.id)).toEqual(["rules 0.4", "rules 0.5", "rules 0.6", "rules 0.7", "2026-11-rules-0.7-payee-claims"]);
    expect(d.limitations.length).toBeGreaterThanOrEqual(5);
    expect(d.limitations.join(" ")).toContain("lower bounds");
    expect(d.reproducibility.rerun_the_audit).toContain("--runs-from apps/forge/src/seed/validity/referee-audit-2.json");
    for (const e of d.reproducibility.public_endpoints) expect(e.url).toMatch(/^https:\/\/theagentforge\.io\//);
  });

  it("carries no held-out seed, private job, private trap id or embargoed model", () => {
    for (const { snapshot, doc } of frozenVersions()) {
      const text = snapshot.text;
      expect(SHOWS_EMBARGOED.test(text), EMBARGOED.id).toBe(false);
      for (const t of [...PRIVATE_TASKS, ...FRONTIER_PRIVATE_TASKS]) expect(text).not.toContain(`"${t.id}"`);
      for (const e of PRIVATE_TRAP_CATALOG) {
        expect(text).not.toContain(e.id);
        for (const k of e.traps) expect(text).not.toContain(k);
      }
      const held = new Set(Object.values(HELDOUT_SEEDS).flatMap((s) => [...s.normal, ...s.hard]));
      const numbers = [...text.matchAll(/(?<![\w.-])\d{4,}(?![\w.-])/g)].map((m) => Number(m[0]));
      expect(numbers.filter((n) => held.has(n))).toEqual([]);
      expect(text).not.toMatch(/"seed"\s*:/);
      const publicIds = new Set(TRAP_CATALOG.map((e) => e.id));
      for (const r of doc.results.per_public_trap) expect(publicIds.has(r.public_trap_id), r.public_trap_id).toBe(true);
      expect(text).not.toMatch(/\bFA-[A-Z]{3}-1\d\d\b/);
    }
  });

  it("its CITATION.cff is CFF 1.2.0 with the version, date and URL", () => {
    const d = v1.doc;
    const cff = citationCff({ version: d.version, date: d.date, url: d.url, json_url: d.json_url, abstract: "x" });
    expect(cff).toMatch(/^cff-version: 1\.2\.0\n/);
    expect(cff).toContain('version: "1"\n');
    expect(cff).toContain(`date-released: ${d.date}\n`);
    expect(cff).toContain(`url: "${d.url}"\n`);
  });
});

describe("released routes", () => {
  it("serves version 1's JSON byte for byte, and the same on the version path with Accept: application/json", async () => {
    const res = await get(versionJsonPath(1), ON);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.text()).toBe(v1.snapshot.text);
    expect(await (await get(versionPath(1), ON, { headers: { Accept: "application/json" } })).text()).toBe(v1.snapshot.text);
  });

  it("the version page reads the frozen figures, cites itself and links every disagreement's replay", async () => {
    const res = await get(versionPath(1), ON);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("1,433 of 1,437");
    expect(page).toContain(v1.snapshot.sha256);
    expect(page).toContain("CITATION.cff");
    for (const id of ["method", "frame", "results", "disagreements", "corrections", "limitations", "reproduce"]) expect(page).toContain(`id="${id}"`);
    for (const x of v1.doc.disagreements) expect(page).toContain(`href="${x.replay}"`);
    expect(page).not.toMatch(/\bsafe\b|\bmalicious\b/i);
  });

  it("the latest page and its JSON list every version with its sha256 and citation", async () => {
    const j = (await (await get(RESEARCH_VALIDITY_JSON_PATH, ON)).json()) as ReturnType<typeof researchIndex>;
    expect(j.latest?.version).toBe(1);
    expect(j.versions).toEqual([expect.objectContaining({ version: 1, sha256: v1.snapshot.sha256, audit_id: "referee-audit-2" })]);
    const page = await (await get(RESEARCH_VALIDITY_PATH, ON)).text();
    expect(page).toContain(`href="${versionPath(1)}"`);
    expect(page).toContain(`href="${versionCffPath(1)}"`);
    const cff = await (await get(versionCffPath(1), ON)).text();
    expect(cff).toContain('version: "1"');
  });

  it("is linked from /benchmark/validity (page and JSON) and /dataset (page and JSON)", async () => {
    const validity = await (await get("/benchmark/validity", ON)).text();
    expect(validity).toContain("data-research");
    expect(validity).toContain(`href="${versionPath(1)}"`);
    const vj = (await (await get("/benchmark/validity.json", ON)).json()) as { links: { research_report: string } };
    expect(vj.links.research_report).toBe(`${env.PUBLIC_ORIGIN}${RESEARCH_VALIDITY_PATH}`);
    // The switch only changes with a release, which changes the edge cache key; here a query stands in for that.
    const dataset = await (await get("/dataset?released=1", ON)).text();
    expect(dataset).toContain('data-k="referee_validity_report"');
    const dj = (await (await get("/dataset.json?released=1", ON)).json()) as { formats: { referee_validity_report: { url: string; latest: { version: number } } } };
    expect(dj.formats.referee_validity_report.url).toBe(`${env.PUBLIC_ORIGIN}${RESEARCH_VALIDITY_PATH}`);
    expect(dj.formats.referee_validity_report.latest.version).toBe(1);
  });
});
