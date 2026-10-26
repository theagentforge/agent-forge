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

  // 26 Oct 2026 (ADR 0056): short honest notes about auth problems were refused whole as credentials.
  it.each([
    "OAuth refresh failed, token: expired after an hour.",
    "api_key: missing from the docs example",
    "secret=required but not documented",
    "Password: Expired.",
    "Installed context7-mcp-server-for-documentation2 fine",
  ])("accepts the honest note %s", (note) => {
    expect(scanNote(note)).toBeNull();
  });

  it.each(["password: hunter22", "password: correcthorse", "token: plainwordsecret", "token=Tr0ub4dor&3", "api_key: sEcReTvAlUe", "secret: s3cr3t!", "key 0f8e3a2b-4c5d-6e7f-8a9b-0c1d2e3f4a5b9 here", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"])("still rejects %s", (note) => {
    expect(scanNote(note)).toBe("credential");
  });
});
