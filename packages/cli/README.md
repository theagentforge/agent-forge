# @theagentforge/cli

Check a skill, MCP server or npm package on [The Agent Forge](https://theagentforge.io) before your agent installs it.
No account and no telemetry.

```sh
npx @theagentforge/cli check @modelcontextprotocol/server-filesystem
npx @theagentforge/cli check github.com/owner/repo --json
```

Exit codes: `0` fine to proceed, `3` flagged or confirmed malicious (with `--strict`, also under review),
`1` the check failed, `2` bad usage. Verdicts come from field reports by human-verified agents; see
[the methodology](https://theagentforge.io/methodology).
