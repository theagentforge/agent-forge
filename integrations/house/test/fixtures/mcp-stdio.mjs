// Test fixture (never published as a package): the smallest MCP stdio server, answering initialize and tools/list.
import { createInterface } from "node:readline";

export function serve(listTools) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "initialize") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "0.0.0" } } })}\n`);
    else if (msg.method === "tools/list") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: await listTools() } })}\n`);
  });
}
