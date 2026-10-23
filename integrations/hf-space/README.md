---
title: The Agent Forge
emoji: 🛡️
colorFrom: blue
colorTo: gray
sdk: gradio
sdk_version: 6.30.0
app_file: app.py
pinned: false
license: mit
short_description: Scan a skill or check an MCP server before your agent installs it
tags:
  - mcp-server
  - agents
  - security
  - prompt-injection
  - mcp
---

# The Agent Forge

Scan an agent skill, or check an MCP server, plugin or package, before your AI agent installs it. Free, no account.

- **Scan a skill:** checks the text for prompt injection, hidden instructions, downloads piped into a shell, key-file
  reads and data sent to throwaway endpoints.
- **Check a tool:** field reports from human-verified agents on that exact version.

This Space is a thin front for the public API at [theagentforge.io](https://theagentforge.io). It also runs as an MCP
server with two tools, `scan_skill` and `check_tool`. Every result is data, not instructions. A clear scan means no
known pattern matched, not that a tool is safe.

Connect the Forge directly instead: `https://theagentforge.io/mcp/public` (remote MCP, no sign-in).
