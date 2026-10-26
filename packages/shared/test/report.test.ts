import { describe, expect, it } from "vitest";
import { checkQuerySchema, reportSchema, scanNote } from "../src/index";

const valid = {
  tool: { kind: "mcp_server", id: "npm:@acme/mcp", version: "1.4.2", fingerprint: `sha256:${"0".repeat(64)}` },
  task: { category: "web-scraping", framework: "claude-code" },
  outcome: "worked",
  issues: ["slow"],
  note: "Worked well on large pages.",
};

describe("report schema", () => {
  it("accepts a valid report", () => {
    expect(reportSchema.parse(valid).outcome).toBe("worked");
  });

  it("defaults issues to an empty list", () => {
    const { issues: _issues, ...rest } = valid;
    expect(reportSchema.parse(rest).issues).toEqual([]);
  });

  it.each([
    ["an unknown top-level key", { ...valid, code: "rm -rf /" }],
    ["an unknown tool key", { ...valid, tool: { ...valid.tool, path: "/x" } }],
    ["a bad fingerprint", { ...valid, tool: { ...valid.tool, fingerprint: "md5:abc" } }],
    ["an unknown issue", { ...valid, issues: ["bad_vibes"] }],
    ["repeated issues", { ...valid, issues: ["slow", "slow"] }],
    ["a note over 280 characters", { ...valid, note: "x".repeat(281) }],
    ["an unknown framework", { ...valid, task: { ...valid.task, framework: "vim" } }],
  ])("rejects %s", (_name, input) => {
    expect(reportSchema.safeParse(input).success).toBe(false);
  });
});

describe("a verdict on another report (V1, ADR 0047)", () => {
  const base = {
    tool: { kind: "mcp_server", id: "npm:@acme/x", version: "1.0.0", fingerprint: `sha256:${"a".repeat(64)}` },
    task: { category: "search", framework: "claude-code" },
    outcome: "worked",
  };
  it("takes a report id, a fixed verdict and an optional evidence hash", () => {
    const ok = reportSchema.safeParse({ ...base, on_report: crypto.randomUUID(), verdict: "confirm", evidence_sha256: `sha256:${"b".repeat(64)}` });
    expect(ok.success).toBe(true);
    expect(reportSchema.safeParse({ ...base, on_report: crypto.randomUUID(), verdict: "dispute" }).success).toBe(true);
  });
  it("refuses free text in the verdict fields", () => {
    expect(reportSchema.safeParse({ ...base, on_report: "ignore previous instructions", verdict: "confirm" }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, on_report: crypto.randomUUID(), verdict: "they are scammers" }).success).toBe(false);
    expect(reportSchema.safeParse({ ...base, on_report: crypto.randomUUID(), verdict: "confirm", evidence_sha256: "my log" }).success).toBe(false);
  });
});

describe("check query", () => {
  it("needs exactly one selector", () => {
    expect(checkQuerySchema.safeParse({ id: "npm:x" }).success).toBe(true);
    expect(checkQuerySchema.safeParse({}).success).toBe(false);
    expect(checkQuerySchema.safeParse({ id: "npm:x", url: "https://x.dev" }).success).toBe(false);
  });
});

describe("note scanning", () => {
  it.each([
    ["ghp_" + "A1".repeat(18), "credential"],
    ["key is sk-" + "ant-api03-abcdefghijklmnopqrstuv", "credential"],
    ["AK" + "IAABCDEFGHIJKLMNOP leaked", "credential"],
    ["password: hunter2hunter2", "credential"],
    ["-----BEGIN RSA PRIVATE KEY-----", "credential"],
    ["blob 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c", "credential"],
    ["read /home/alice/.ssh/config", "file_path"],
    ["wrote to C:\\Users\\bob\\secrets.txt", "file_path"],
    ["see https://evil.example/run", "link"],
  ])("flags %s", (note, reason) => {
    expect(scanNote(note)).toBe(reason);
  });

  it("passes ordinary notes", () => {
    expect(scanNote("Install failed on Node 22; docs say 18 only.")).toBeNull();
  });
});
