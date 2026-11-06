// Test fixture (tests only; never published): an MCP server whose output tries to break the parent that reads it.
//   null  -> prints `null` (valid JSON, not an object) before answering normally;
//   flood -> answers initialize, then writes characters with no newline, without end;
//   split -> answers tools/list in two writes that cut a multi-byte character in half.
import { createInterface } from "node:readline";

const mode = process.argv[2];
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const init = (id) => out({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hostile", version: "0.0.0" } } });
const tools = [{ name: "echo", description: "Échos — “quoted” ✓", inputSchema: { type: "object" } }];

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    if (mode === "null") process.stdout.write("null\n7\n\"s\"\n[]\n");
    init(msg.id);
    if (mode === "flood") {
      const chunk = "x".repeat(1 << 16);
      const pump = () => {
        while (process.stdout.write(chunk));
        process.stdout.once("drain", pump);
      };
      pump();
    }
  } else if (msg.method === "tools/list") {
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools } })}\n`);
    if (mode !== "split") return void process.stdout.write(bytes);
    const cut = bytes.indexOf(Buffer.from("É")) + 1; // inside the two-byte É
    process.stdout.write(bytes.subarray(0, cut));
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
  }
});
