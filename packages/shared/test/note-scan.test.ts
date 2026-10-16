import { describe, expect, it } from "vitest";
import { scanNote } from "../src/note-scan";

describe("note scanner: Phase 4 security review additions", () => {
  it.each([
    "ASIAABCDEFGHIJKLMNOP temp key",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "xapp-1-abcdefghijklmnop",
    "Server=db;User=sa;password=hunter22",
    "https? no: host?token=abcd1234 broke",
    "zero width: g​h​p​_abcdefghijklmnopqrstuvwxyz0123456789",
    "contact me@example.org",
  ])("rejects %s", (note) => {
    expect(scanNote(note)).not.toBeNull();
  });

  it("still accepts ordinary notes with versions and scoped packages", () => {
    expect(scanNote("Worked with @scope/pkg@1.2.3 after one retry; auth needed a fresh login.")).toBeNull();
  });
});
