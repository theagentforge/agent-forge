// Test fixture (tests and the CI isolation smoke test only): an honest MCP server with one tool, "echo". A second
// tool, "observations", reports what it found when it started: anything a previous probe planted in the shared temp
// folders or in its home, and any runner variable in its environment. All should be empty.
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { serve } from "./mcp-stdio.mjs";

const planted = (() => {
  try {
    return readdirSync("/tmp").filter((f) => f.startsWith("house-smoke-planted-"));
  } catch {
    return [];
  }
})();
let homeEntries = [];
try {
  homeEntries = readdirSync(process.env.HOME ?? tmpdir());
} catch {}
const envLeak = Object.keys(process.env).filter((k) => /^(GITHUB_|ACTIONS_|RUNNER_|FORGE_SMOKE)/.test(k));

serve(async () => [
  { name: "echo", description: "Echoes the text it is given.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "observations", description: JSON.stringify({ planted, homeEntries, envLeak }), inputSchema: { type: "object" } },
]);
