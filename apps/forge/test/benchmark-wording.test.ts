import { describe, expect, it } from "vitest";
import { TRAP_SET, TRAP_SET_CHANGE_CLASS_NOTES, TRAP_SET_VERSIONS, VERSIONING } from "../src/arena/benchmark";
import { fetchWorker } from "./helpers";
import "../src/index";

// Weekly brief 9 Nov: /benchmark said "Version 1.1 comes with the first new public job family…" while 1.3 was live,
// and the 1.2 changelog line (the rules 0.7 re-score) named no change class.

const CLASS = /^(First release|Patch|Minor|Major)\b/;

describe("/benchmark versioning wording", () => {
  it("names the current version and the history so far, not a future 1.1", async () => {
    const page = await (await fetchWorker(`/benchmark?w=${Date.now()}`, { headers: { Accept: "text/html" } })).text();
    expect(page).not.toContain("comes with the first new public job family");
    expect(page).toContain(`The current version is ${TRAP_SET.version}.`);
    expect(page).toContain("1.2 with a referee correction (the rules 0.7 re-score)");
  });

  it("every Trap Set changelog line names its change class; 1.2 is Minor (a referee correction), on the page and the JSON", async () => {
    // The reading: a referee correction that makes a check match its published trigger is a minor change.
    expect(VERSIONING.minor).toContain("referee_correction_that_makes_a_check_match_its_published_trigger_with_stored_runs_rescored_and_listed_as_a_correction");
    expect(TRAP_SET_CHANGE_CLASS_NOTES["1.2"]).toMatch(/^Minor \(a referee correction that makes a check match its published trigger/);
    // Only versions whose frozen line lacks a class get a note, so no line names its class twice.
    for (const v of TRAP_SET_VERSIONS) expect(CLASS.test(v.change) !== !!TRAP_SET_CHANGE_CLASS_NOTES[v.version], v.version).toBe(true);
    const d = (await (await fetchWorker("/benchmark/changelog.json")).json()) as { entries: { kind: string; version: string; change: string }[] };
    const sets = d.entries.filter((e) => e.kind === "trap_set");
    expect(sets.map((e) => e.version)).toEqual(TRAP_SET_VERSIONS.map((v) => v.version));
    for (const e of sets) expect(e.change, e.version).toMatch(CLASS);
    expect(sets.find((e) => e.version === "1.2")!.change).toMatch(/^Minor \(a referee correction/);
    const page = await (await fetchWorker(`/benchmark?c=${Date.now()}`, { headers: { Accept: "text/html" } })).text();
    expect(page).toMatch(/<b>1\.2<\/b>: Minor \(a referee correction/);
    const changelog = await (await fetchWorker("/benchmark/changelog")).text();
    expect(changelog).toContain("Minor (a referee correction that makes a check match its published trigger");
  });
});
