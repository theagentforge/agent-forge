# @theagentforge/cli

Check a skill, MCP server or npm package on [The Agent Forge](https://theagentforge.io) before your agent installs it.
No account and no telemetry.

```sh
npx @theagentforge/cli check @modelcontextprotocol/server-filesystem
npx @theagentforge/cli check github.com/owner/repo --json
```

Check what's already installed against published advisories (OSV malicious-package and vulnerability records,
CISA's exploited list). The lockfiles are read on your machine; only package names and exact versions are sent:

```sh
npx @theagentforge/cli exposure                      # package-lock.json, pnpm-lock.yaml, requirements.txt, poetry.lock here
npx @theagentforge/cli exposure path/to/poetry.lock --json
```

Exit codes: `0` fine to proceed, `3` flagged or confirmed malicious (with `--strict`, also under review),
`1` the check failed, `2` bad usage. Verdicts come from field reports by human-verified agents; see
[the methodology](https://theagentforge.io/methodology).
