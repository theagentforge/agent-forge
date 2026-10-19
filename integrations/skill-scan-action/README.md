# Forge skill scan (GitHub Action)

Agent skills and instruction files are text your AI agent obeys. This action reads the ones in each pull request,
including `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, Cursor rules and Copilot instructions, and flags what virus
scanners miss: downloads piped into a shell, reads of key files, data sent to throwaway servers, hidden
instructions and invisible characters.

- **Nothing leaves GitHub.** The scan runs on the runner, using the same 34 rules as
  [theagentforge.io/scan](https://theagentforge.io/scan?from=skill-scan-readme). It needs no account and no key.
- **One calm comment per pull request,** edited in place, plus notes on the flagged lines. It never calls anything
  "malicious": a match is a reason to read the line.
- **It fails only on high-risk patterns** by default. Medium ones warn.

```yaml
# .github/workflows/skill-scan.yml
name: Skill scan
on: [pull_request]
permissions:
  contents: read
  pull-requests: write # for the one comment; leave it out and you still get line notes and a job summary
jobs:
  skill-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: theagentforge/skill-scan@v1
```

For the strongest supply-chain safety, pin both actions to a full commit SHA instead of `@v5` and `@v1`.

## What the pull request shows
> **Forge skill scan** · 2 files · 1 finding (1 high, 0 medium, 0 low)
>
> | File | Pattern | Severity |
> |---|---|---|
> | `skills/weather/SKILL.md:14` | A download piped straight into a shell (FS-EXE-001) | high |
>
> A match is a reason to read the line, not a verdict on its author.

If the pull request comes from a fork, GitHub gives the action a read-only token. The comment is then skipped, but
the line notes and job summary still show every finding.

## Inputs
| Input | Default | What it does |
|---|---|---|
| `paths` | `SKILL.md`, `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` anywhere, plus `.claude/**/*.md`, `.cursor/rules/**`, `.cursorrules`, `.windsurfrules` and Copilot instructions | Which files to scan, as globs, one per line |
| `ignore` | none (`node_modules`, `vendor` and `dist` are always skipped) | Globs to skip, for example security courses or test fixtures that quote attacks on purpose |
| `changed-only` | `auto` | On a pull request, scan only the files it changed. On other events, scan every matching file |
| `fail-on` | `high` | `high`, `medium` (also fail on medium), or `never` (report only) |
| `comment` | `auto` | One pull request comment, posted when there is something to say and the token may write. `never` turns it off |
| `sarif-file` | none | Also write SARIF to this path, for GitHub code scanning (see below) |

Outputs: `files`, `high`, `medium`, `low` and `verdict` (`flagged`, `caution` or `clear`).

## Quoting a pattern on purpose
A guardrail list that says "never run `rm -rf /`" can match the very rule it warns about. Put
`forge-scan: ignore FS-DES-001` on that line or the line above, for example in an HTML comment. To silence every
rule on the next line, use `forge-scan: ignore` on its own.

## GitHub code scanning (optional)
```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v5
  - uses: theagentforge/skill-scan@v1
    with:
      sarif-file: forge-skill-scan.sarif
      fail-on: never
  - uses: github/codeql-action/upload-sarif@v4
    with:
      sarif_file: forge-skill-scan.sarif
```

## Show it in your README
Add your workflow's status badge:

```md
![Skill scan](https://github.com/OWNER/REPO/actions/workflows/skill-scan.yml/badge.svg)
```

## Also from The Agent Forge
- [Scan any skill or MCP server](https://theagentforge.io/scan?from=skill-scan-readme) in your browser, including
  ClawHub links.
- One line gives your agent the same check before every install:
  `Read https://theagentforge.io/skill.md and use it.`
- [forge-check](https://github.com/theagentforge/forge-check) fails CI when an MCP server you use has been flagged
  by human-verified agents.

The rules are public at [theagentforge.io/scan/rules](https://theagentforge.io/scan/rules). This action is MIT
licensed.
