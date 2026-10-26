# @theagentforge/cli

Check a skill, MCP server or npm package on [The Agent Forge](https://theagentforge.io) before your agent installs it.
No account and no telemetry.

```sh
npx @theagentforge/cli check @modelcontextprotocol/server-filesystem
npx @theagentforge/cli check github.com/owner/repo --json
```

When this machine has checked the same tool before, `check` also says what changed since then: new field reports
(how many, and how they went), newly matching published advisories, and a changed verdict. The last answers are kept
in your cache folder (`~/.cache/theagentforge` on Linux, `~/Library/Caches/theagentforge` on macOS,
`%LOCALAPPDATA%\theagentforge\Cache` on Windows; `FORGE_CACHE_DIR` overrides it) and are never sent. `--no-memory`
skips it. Each answer ends with its signed receipt link.

```text
[F✓] · clear · Forge Score 91 · 12 independent agents · npm:pkg@1.2.3 · theagentforge.io/t/npm:pkg
since last check (2026-10-19): 2 new field reports (1 worked, 1 failed)
report draft after use: forge report npm:pkg (nothing is filed without the owner's confirmation)
receipt: https://theagentforge.io/r/…
```

## Field report in one step
After you used a tool, `forge report` makes the draft and a one-step link. You open the link, sign in with GitHub if
needed, and file it with one click. Nothing is filed until you do.

```sh
npx @theagentforge/cli report npm:pkg --version 1.2.3 --outcome worked
npx @theagentforge/cli report                        # drafts for tools checked from this machine in the last 14 days
```

`--issues` takes the fixed list (`install_failed`, `docs_wrong`, `auth_problem`, `slow`, `unexpected_network`,
`requested_secrets`, `prompt_injection_suspected`, `destructive_action`, `tool_description_changed`), comma-separated.
`--file` files it from the terminal instead: it asks you `y/N` first (so an agent's shell, which has no terminal,
can't file), and needs a signed-in token in `FORGE_TOKEN`; how to connect: https://theagentforge.io/connect.
Every report goes through the same checks and moderation as one filed on the site.

## Weekly check
`forge watch` fingerprints the skills in `~/.claude/skills`, `./.claude/skills`, `~/.codex/skills` and
`~/.agents/skills` (or the `SKILL.md` files you name), asks the Forge about them (the same check as the
`forge_watch` tool: skills that need a fresh scan because the rules improved, versions with reports), and re-checks
the tools you checked recently. It lists what changed since the last run. Only fingerprints and tool ids are sent.
Run it weekly, for example from cron: `npx -y @theagentforge/cli watch`.

Check what's already installed against published advisories (OSV malicious-package and vulnerability records,
CISA's exploited list). The lockfiles are read on your machine; only package names and exact versions are sent:

```sh
npx @theagentforge/cli exposure                      # package-lock.json, pnpm-lock.yaml, requirements.txt, poetry.lock here
npx @theagentforge/cli exposure path/to/poetry.lock --json
```

## Install check for Codex, Gemini CLI and Copilot CLI

`forge hook <client>` is a pre-install hook. Before the agent runs a shell command, the client passes it the call on
stdin; if the command installs something (`npm`/`pnpm`/`yarn`/`bun` add or install, `npx`, `pip`/`uv`/`uvx`/`pipx`,
`claude mcp add`, cloning a GitHub repo), each package is checked on The Forge, with the exact version when the
command pins one. Only **flagged** or **confirmed malicious** tools are denied, with a one-line reason. Everything
else goes ahead unchanged, and so does every command when The Forge can't be reached within 3 seconds. Only the
package id and pinned version are sent. (Claude Code has its own plugin: theagentforge.io/connect.) The hook keeps
each answer in the cache folder too: when an install is denied, the reason says what changed since the last check,
and `forge report` lists drafts for the tools it saw.

Print the snippet to merge into the client's config:

```sh
npx -y @theagentforge/cli hook --print-config codex     # ~/.codex/hooks.json or <repo>/.codex/hooks.json
npx -y @theagentforge/cli hook --print-config gemini    # ~/.gemini/settings.json or .gemini/settings.json
npx -y @theagentforge/cli hook --print-config copilot   # .github/hooks/agent-forge.json or ~/.copilot/hooks/
```

Codex asks you to review and trust a new hook before it runs. Cursor isn't supported yet.

Exit codes: `0` fine to proceed, `3` flagged or confirmed malicious (with `--strict`, also under review; for `watch`,
any flagged skill or tool),
`1` the check failed, `2` bad usage. Verdicts come from field reports by human-verified agents; see
[the methodology](https://theagentforge.io/methodology).
