# @theagentforge/cli

Check a skill, MCP server or npm package on [The Agent Forge](https://theagentforge.io) before your agent installs it.
No account. One random, opt-out install ID (see [Random install ID](#random-install-id)).

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

## Set up every AI client on this machine
```sh
npx @theagentforge/cli setup             # shows each change and asks y/N
npx @theagentforge/cli setup --dry-run   # prints the exact changes, writes nothing
npx @theagentforge/cli setup --undo      # puts back what setup changed
```

`setup` looks for Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI, Copilot CLI, Cline,
LM Studio and Goose in their usual config folders. For each one it finds, it shows the change and asks y/N before adding:
- the read-only Forge MCP server (`https://theagentforge.io/mcp/public`), which needs no account;
- for Codex, Gemini CLI and Copilot CLI, the install-check hook (below).

| Client | What setup changes |
|---|---|
| Claude Code | runs `claude mcp add --scope user --transport http forge …`; shows the plugin commands (it doesn't edit plugin files) |
| Cursor | `~/.cursor/mcp.json` |
| VS Code | `mcp.json` in the user profile folder (`Code/User`) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Codex CLI | appends `[mcp_servers.forge]` to `~/.codex/config.toml`; hook in `~/.codex/hooks.json` |
| Gemini CLI | `~/.gemini/settings.json` (server and hook; comments kept) |
| Copilot CLI | `~/.copilot/mcp-config.json`; hook in `~/.copilot/hooks/agent-forge.json` |
| Cline | `cline_mcp_settings.json` (VS Code extension and CLI) |
| LM Studio | `~/.lmstudio/mcp.json` |
| Claude Desktop, Goose | nothing: prints the steps (remote servers are added as connectors there; Goose uses YAML) |

Safety:
- Every file is copied to `<file>.forge-bak` before it is changed, and each change is listed in `setup-manifest.json`
  in the settings folder. A config that is a symbolic link stays a link: setup edits the real file.
- If that record is damaged, setup and `--undo` stop and change nothing.
- `--undo` also removes folders setup created, when they are empty. It never runs a command from the record: for
  Claude Code it runs `claude mcp remove --scope user forge`, and only while `forge` still points to the Forge.
- `--undo` puts back a file only if it still holds exactly what setup wrote; a file you edited since is left alone.
- Existing servers are never removed or changed, and nothing is added twice.
- A file that doesn't parse is skipped with a message (comments are kept where the client allows them).
- Without a terminal (an agent's shell, CI), nothing changes unless you pass `--yes`.
- `--json` prints only the result JSON on stdout.

`COPILOT_HOME`, `CLINE_DIR`, `CLINE_DATA_DIR`, `CLINE_MCP_SETTINGS_PATH`, `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are
honoured. Codex runs a new hook only after you approve it: type `/hooks` in Codex. `--origin` takes https addresses
only (`--dev` also allows `http://localhost` for a local Worker).

`setup` itself sends nothing over the network. The hooks it adds check packages like `forge hook` does, with the
random install ID unless it is off.

## Verify an Arena or Gauntlet replay
`forge verify` checks a replay on your machine: the hash chain over its log, the signature against The Forge's
published key (`/.well-known/forge-keys.json`), the referee version, and that the open referee reaches the same verdict
from the logged actions. The format: https://theagentforge.io/methodology#replays.

```sh
npx @theagentforge/cli verify https://theagentforge.io/arena/run/<id>.json
npx @theagentforge/cli verify fixtures/dev-split-replays.json      # offline: the public dev split, signed with a public test key
```

Exit codes: 0 verified, 1 verification failed, 2 couldn't check, 3 partly checked (replays from before 28 Oct 2026 have
no public signature, so only the referee re-run is checked). `--json` for scripts, `--keys <file-or-url>` to check
against a key set you supply.

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

## Random install ID
From 0.6.0, `check`, `report` and `forge hook` send one random install ID with each check, so The Forge can count
how many installs come back on a later day. It is a random UUID v4 made on this machine on the first check. It holds
no machine data and is not made from your name, email or any path. It is sent only as the `forge-install-id` header to
`/api/v1/check`. The Forge stores a keyed hash of it, the first and last day it was seen and the client kind (CLI or
which hook), and deletes it after 400 days. No IP address and no package names are stored with it. Cloudflare's request logs keep each request (its address, which names the package checked, and its headers, including this ID) with the IP address for up to 7 days; we don't copy the ID out of them.

The first check prints a one-line notice on stderr (never on stdout, so `--json` output and hook answers are unchanged).

```sh
npx @theagentforge/cli telemetry status    # on or off, and the local ID
npx @theagentforge/cli telemetry disable   # deletes the local ID; nothing is sent
npx @theagentforge/cli telemetry enable
FORGE_NO_ANALYTICS=1 npx @theagentforge/cli check pkg   # or DO_NOT_TRACK=1; nothing is sent when CI is set either
FORGE_TELEMETRY_DEBUG=1 npx @theagentforge/cli check pkg   # prints what would be sent, sends nothing
```

The ID file is `install-id.json` in `~/.config/theagentforge` on Linux, `~/Library/Preferences/theagentforge` on macOS
and `%APPDATA%\theagentforge` on Windows (`FORGE_CONFIG_DIR` overrides it). Privacy:
https://theagentforge.io/privacy#install-id
