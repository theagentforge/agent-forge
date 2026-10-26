import { site } from "./pages";

// Proves to the official MCP Registry that we control theagentforge.io, so the Forge server is listed as
// `io.theagentforge/forge` (HTTP authentication). This is a public key only; the private key is used once per
// publish in a Claude session and never stored (docs/runbooks/mcp-registry.md).
export const MCP_REGISTRY_AUTH = "v=MCPv1; k=ed25519; p=El9KXKOmqZUuaKdcWLuLHaoFcmUgn1SibF+aMvv/w7Y=";

site.get("/.well-known/mcp-registry-auth", (c) =>
  c.text(MCP_REGISTRY_AUTH, 200, { "Cache-Control": "public, max-age=300" }),
);
