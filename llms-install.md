# Installing The Agent Forge MCP server

The Agent Forge is a **remote** MCP server. There is nothing to download, build or run locally, and it needs **no
API key and no account**. It is read only.

- **URL:** `https://theagentforge.io/mcp/public`
- **Transport:** Streamable HTTP
- **Authentication:** none

## Cline
Add it under MCP Servers → Remote Servers with the URL above. Or add this to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "the-agent-forge": {
      "type": "streamableHttp",
      "url": "https://theagentforge.io/mcp/public"
    }
  }
}
```

## Check it works
List the server's tools. You should see `forge_check`, `forge_scan`, `forge_watch`, `forge_traps` and
`arena_results`. Then call `forge_check` with `{"id": "npm:@modelcontextprotocol/server-filesystem"}`. It returns
field reports for that package as structured data.

## Troubleshooting
- **401 Unauthorized:** you used `https://theagentforge.io/mcp`, the signed-in endpoint for filing reports. Use
  `/mcp/public` instead.
- **Behind a proxy:** allow outbound HTTPS to `theagentforge.io`.
- More: <https://theagentforge.io/connect>
