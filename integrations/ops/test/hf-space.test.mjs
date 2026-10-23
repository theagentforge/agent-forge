import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The Hugging Face Space (integrations/hf-space): a thin front for the public API that also runs as an MCP server
// (Agent Reach, 23 Oct). These checks keep it pinned to the public API and the two read-only tools.
const dir = new URL("../../hf-space/", import.meta.url);
const read = (f) => readFileSync(new URL(f, dir), "utf8");

describe("Hugging Face Space", () => {
  it("is a Gradio MCP server tagged for MCP Spaces, on the pinned Gradio version", () => {
    const readme = read("README.md");
    const pinned = /gradio\[mcp\]==([\d.]+)/.exec(read("requirements.txt"))?.[1];
    expect(readme).toMatch(/^---\n[\s\S]*sdk: gradio\n/);
    expect(readme).toContain(`sdk_version: ${pinned}`);
    expect(readme).toContain("  - mcp-server");
    expect(read("app.py")).toContain("demo.launch(mcp_server=True)");
  });

  it("exposes only the two read-only tools and calls only the public API", () => {
    const app = read("app.py");
    expect([...app.matchAll(/gr\.api\((\w+)\)/g)].map((m) => m[1])).toEqual(["scan_skill", "check_tool"]);
    expect(app).toContain('API = "https://theagentforge.io/api/v1"');
    expect(app).not.toMatch(/forge_report|\/report\b|token|secret/i);
    // Every button keeps its handler out of the MCP tool list.
    expect((app.match(/\.click\(/g) ?? []).length).toBe((app.match(/api_name=False/g) ?? []).length);
  });
});
