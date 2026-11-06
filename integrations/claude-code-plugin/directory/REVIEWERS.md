# Notes for directory reviewers

This page explains, in plain terms, what the `theagentforge` plugin (directory edition, 0.9.0) contains and how it
answers each finding on version 0.8.0. Everything here is also described for users in [README.md](README.md).
Contact: hello@theagentforge.io.

## What the plugin contains
- `.claude-plugin/plugin.json` and `.claude-plugin/icon.png`: the manifest and the icon.
- `.mcp.json`: three remote MCP servers on theagentforge.io (`/mcp/public`, `/mcp`, `/mcp/gauntlet`), all `https`,
  all `type: "http"`. No local servers, no headers, no `headersHelper`.
- `skills/forge/SKILL.md`: text only.
- `commands/sprint.md` and `commands/gauntlet.md`: text only.
- `README.md`, `REVIEWERS.md`, `LICENSE`.

There is no `hooks/` folder, no hooks of any type, no `bin/`, no scripts, no `userConfig` and no `package.json`. No
file in the plugin runs on the user's machine.

## Findings on 0.8.0, and what changed
| Finding on 0.8.0 | 0.9.0 |
|---|---|
| Hooks of type command accepted only from Verified organizations (blocking) | All five command hooks removed, with the three Node scripts they ran. No hook of any other type was added: the checks need a network call to theagentforge.io, which a prompt hook can't make, so the skill now asks Claude to call `forge_check` itself before an install |
| Uses a credential from the user's machine (4) | Gone with the scripts. Those were the hooks' reads of their own on/off settings and of the home folder (to find the plugin's data folder and the skills folders it fingerprinted). Nothing in 0.9.0 reads files, settings or environment variables |
| Contains a download-and-run command (2) | Gone with the scripts and the skill's command line. Nothing in 0.9.0 downloads or runs anything |
| Unrecognized field in plugin.json (4) | Every top-level field is in the [plugins reference](https://code.claude.com/docs/en/plugins-reference) Fields table. `documentationUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` and `supportUrl` are kept on purpose: they are the directory listing fields the reference says the directory reads from `plugin.json` (older `claude plugin validate` versions, before 2.1.281, report them as unknown) |

A test in the repository fails the build if this folder gains a hook, a script, a `userConfig`, a field not in the
reference, a read of the home folder or a credential path, or a download-and-run command
(`integrations/claude-code-plugin/test/directory-edition.test.ts` in https://github.com/theagentforge/agent-forge).

## Where it connects
Only the three MCP servers above, and only when Claude calls one of their tools. `forge` and `forge-gauntlet` need no
sign-in. `forge-reports` uses OAuth (GitHub sign-in on theagentforge.io) the first time it's used.

## The full edition
The Forge's own marketplace (theagentforge.io/marketplace.json) keeps a full edition, version `0.9.0-full`, with the
command hooks (pre-install check, failure counts, report drafts). It is not part of this submission. Its files are in
the repository at `integrations/claude-code-plugin/release/forge-full/`.

## The name
The plugin is named `theagentforge` (shown as "The Agent Forge"), after our product and domain (The Agent Forge,
theagentforge.io; author "The Agent Forge"). Until 0.7.1 it was named `forge`; we renamed it in 0.8.0 because a
different, unrelated plugin named `forge` is listed in the community marketplace. We are not affiliated with other
plugins whose names contain "forge".
