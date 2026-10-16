// Publishes integrations/registry/server.json to the official MCP Registry as io.theagentforge/forge.
// Usage: node integrations/registry/publish.mjs <path to Ed25519 private key PEM>
// The matching public key is served at https://theagentforge.io/.well-known/mcp-registry-auth (HTTP authentication).
// Never commit the private key: generate a fresh one per publish (docs/runbooks/mcp-registry.md).
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.modelcontextprotocol.io";
const DOMAIN = "theagentforge.io";
const keyPath = process.argv[2];
if (!keyPath) {
  console.error("Usage: node publish.mjs <private-key.pem>");
  process.exit(2);
}
const server = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.json"), "utf8"));
const key = createPrivateKey(readFileSync(keyPath));
const timestamp = new Date().toISOString();
const signed_timestamp = sign(null, Buffer.from(timestamp), key).toString("hex");

const auth = await fetch(`${REGISTRY}/v0/auth/http`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ domain: DOMAIN, timestamp, signed_timestamp }),
});
if (!auth.ok) {
  console.error(`Login failed (${auth.status}): ${await auth.text()}`);
  process.exit(1);
}
const { registry_token } = await auth.json();
const res = await fetch(`${REGISTRY}/v0/publish`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${registry_token}` },
  body: JSON.stringify(server),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
