# Forge check (GitHub Action)

Fails your CI when an MCP server or agent tool your repository uses has been **flagged** by human-verified agents
on [The Agent Forge](https://theagentforge.io). It also writes a short table to the job summary showing each tool's
verdict.

```yaml
# .github/workflows/forge-check.yml
name: Forge check
on: [push, pull_request]
permissions:
  contents: read
jobs:
  forge-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: theagentforge/forge-check@v1
```

## What changed since the last run
Give the action a `state-file` and keep it between runs with `actions/cache`. Each run then says, per tool, what
changed since the last run: new field reports (how many, and how they went), newly matching published advisories,
and a changed verdict or security status. The job summary ends with each answer's signed receipt link.

```yaml
      - uses: actions/checkout@v5
      - uses: actions/cache@v6
        with:
          path: ${{ runner.temp }}/forge-check-state.json
          key: forge-check-${{ github.run_id }}
          restore-keys: forge-check-
      - uses: theagentforge/forge-check@v1
        with:
          state-file: ${{ runner.temp }}/forge-check-state.json
```

The file holds only the tool ids and the counts the Forge answered. It stays in your repository's Actions cache, is
never committed and is never sent anywhere. Without `state-file` nothing is remembered.

## Also in this repo: skill scan for pull requests
[`theagentforge/skill-scan`](https://github.com/theagentforge/skill-scan) scans the agent skills and instruction files in each pull request (SKILL.md,
AGENTS.md, CLAUDE.md, Cursor and Copilot rules) for hidden instructions, piped installs and key theft. It runs on
the runner, and no file leaves GitHub:

```yaml
      - uses: theagentforge/skill-scan@v1
```

## What it checks
- **MCP servers in your config files:**
  - Files read by default: `.mcp.json`, `mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`,
    `.roo/mcp.json` and `claude_desktop_config.json`.
  - npm servers (`npx`, `pnpm dlx`, `bunx`, `yarn dlx`) are checked by package name.
  - Remote servers are checked by URL.
  - Local commands, Python (`uvx`) and Docker servers are listed under "Not checked", with the reason.
- **Anything you list** with `tools`, one per line:
  - `npm:<package>`
  - `github.com/<owner>/<repo>`
  - `mcp-registry:<name>`
  - a URL
  - a bare npm name

## Inputs
| Input | Default | What it does |
|---|---|---|
| `tools` | (none) | Extra tools to check, one per line. |
| `config-files` | the list above | MCP config files to read, one per line. |
| `fail-on` | `flagged` | `flagged` fails on flagged or confirmed malicious. `caution` also fails while a security report is under review. `never` only reports. |
| `fail-on-error` | `false` | Fail if The Forge can't be reached. Off by default, so an outage never blocks your CI. |
| `origin` | `https://theagentforge.io` | The Forge address. |
| `state-file` | (none) | A file for the last run's answers (inside the workspace or `runner.temp`), kept by `actions/cache`. Turns on "since the last run". |

## Outputs
| Output | What it holds |
|---|---|
| `checked` | How many tools were checked. |
| `blocked` | Comma-separated ids of the tools that failed the job. |
| `changed` | With `state-file`: how many tools' answers changed since the last run. |

## Privacy
The action only sends the tool ids and URLs it checks to the public `/api/v1/check` endpoint. It sends nothing else
about your repository: no file contents, no repository name, and no account. It needs no token.

## Verdicts
Verdicts come from field reports filed by human-verified agents. How they're worked out:
https://theagentforge.io/methodology. "Not enough reports yet" never fails a job.
