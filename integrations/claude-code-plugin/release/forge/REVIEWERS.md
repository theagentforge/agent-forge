# Notes for directory reviewers

This page explains, in plain terms, each behaviour of the `forge` plugin that an automated scan may hold for a
reviewer. Everything here is also described for users in [README.md](README.md). Contact: hello@theagentforge.io.

## What the plugin contains
- `hooks/hooks.json`: five hooks. Each runs one bundled Node script from `${CLAUDE_PLUGIN_ROOT}/hooks/`.
- `hooks/pre-install.mjs`, `hooks/strain.mjs`, `hooks/session-start.mjs`: readable (not minified) single-file builds.
  Each starts with a comment naming its source in https://github.com/theagentforge/agent-forge
  (`integrations/claude-code-plugin/src/hooks/` and `packages/shared/src/`). They use Node built-ins only
  (`node:fs`, `node:path`, `node:crypto`, `node:url`) and the global `fetch`. They install nothing, download nothing
  and run no other program. Every hook fails open: on any error it exits quietly and Claude Code carries on.
- `.mcp.json`: three remote MCP servers on theagentforge.io (`/mcp/public`, `/mcp`, `/mcp/gauntlet`), all `https`.
- `forge.json`: the one origin the hooks talk to (`https://theagentforge.io`).
- `skills/forge/SKILL.md` and `commands/`: text only.

## "Uses a credential from the user's machine"
This is a false positive. The hooks read **no credential, token or key** of any kind.

The only environment variables they read are:

| Variable | What it is | Sent anywhere? |
|---|---|---|
| `CLAUDE_PLUGIN_OPTION_CHECK_INSTALLS`, `_NUDGE`, `_TRAP_CARD`, `_REPORT_DRAFTS`, `_WEEKLY_CHECK`, `_INSTALL_ID`, `_LINK_PROMPT` | This plugin's own on/off switches from `userConfig` in `plugin.json` (all `boolean`, none `sensitive`). Claude Code passes them to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`. Read in `hooks/common.ts` (`OPTION_ENV`, `optionOn`) and `link-line.ts` | No |
| `CLAUDE_PLUGIN_DATA`, `HOME`, `USERPROFILE`, `CLAUDE_PROJECT_DIR` | Where to keep the plugin's small local files, and where to look for installed skills | No |
| `CLAUDE_CODE_ENTRYPOINT`, `CI` and other CI markers | Whether a person is at the keyboard (the link note is shown only in an interactive session) | No |
| `FORGE_NO_ANALYTICS`, `DO_NOT_TRACK`, `FORGE_TELEMETRY_DEBUG`, `FORGE_LINK_PROMPT` | Opt-outs and a debug switch | No |

Each option name is written in full in the source (`OPTION_ENV` in `src/hooks/common.ts`), and a test fails if a
built hook reads an environment variable through a computed name.

## "Scripts the validator couldn't follow" (`strain.mjs`)
The validator follows plain shell scripts only, and this plugin's hooks are Node scripts in a subfolder of the
repository, so it can't trace them. `strain.mjs` is called three ways, with one plain word as its argument:
- `strain.mjs failure` (PostToolUseFailure) and `strain.mjs success` (PostToolUse): add one to a per-tool counter in a
  local JSON file under `${CLAUDE_PLUGIN_DATA}/strain/`. No network. After the same tool fails 3 times in a row, it adds
  one line suggesting a check on The Forge.
- `strain.mjs stop` (Stop): if this session used MCP servers, or installed a package the pre-install hook checked,
  it prints short field-report drafts with a link for the person to open and file. It returns `decision: "block"`
  for one turn only so Claude can show the drafts (`stop_hook_active` stops a second round). It **files nothing**:
  filing needs the person to open the link, sign in and confirm. For an installed npm or PyPI package with no
  fingerprint yet, it asks the public registry (`registry.npmjs.org` or `pypi.org`) for that name and version only.

## What each hook sends, and where
| Hook | Destination | What is sent |
|---|---|---|
| `pre-install.mjs` (PreToolUse, `Bash` only, install commands only) | `https://theagentforge.io/api/v1/check` | The package id and pinned version parsed from the command (e.g. `npm:left-pad`, `1.3.0`). With the `install_id` switch on, a random UUID made on this machine (`forge-install-id` header). Never the command, paths, prompts or code |
| `session-start.mjs` (SessionStart, once a week) | `https://theagentforge.io/api/v1/watch` and `/api/v1/check` | sha256 fingerprints of `SKILL.md` files in `~/.claude/skills` and the project's `.claude/skills`, and the ids of tools this machine checked recently. Never skill names or text |
| `strain.mjs stop` | `registry.npmjs.org`, `pypi.org` | Package name and version, to read its published fingerprint |

No other hosts. The person can turn off each behaviour in the plugin's settings.

## What it writes on this machine
Only inside `${CLAUDE_PLUGIN_DATA}` (or `~/.claude-forge` if Claude Code doesn't set it): `memory.json` (earlier
answers), `installs.json` (a hash of each install command, never the command), `strain/` (failure counts),
`drafted.json`, `install-id.json`, `link-line.json`, `claim-line.json`. It reads, but never changes, `SKILL.md`
files in the two skills folders above. It never changes settings, permissions, other plugins or project files.

## The name
`forge` is our product's short name (The Agent Forge, theagentforge.io; author "The Agent Forge"). We are not
affiliated with other plugins whose names contain "forge". If the directory prefers a more distinctive name, we will
change it on request.
