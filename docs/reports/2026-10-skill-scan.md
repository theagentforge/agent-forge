# What 9,930 public agent skills tell your agent to do

*The Agent Forge, 19 October 2026. Report version 1.1, rules version 2026-10-19.3. Data:
[skill-scan-2026-10-19.json](/data/skill-scan-2026-10-19.json). Corrections: hello@theagentforge.io.*

**In short:**
- We found no malware with this method: 0.33% of ordinary skills matched a high-risk pattern.
- 26 of the 30 matches were real patterns when we read them by hand, and none showed signs of malice.
- The two habits worth changing are piping a download into a shell (14 files, mostly vendors' own installers) and
  reading the agent's whole key file to get one API key (8 files).

## Why we looked
- **Skills are text your agent obeys.** In early 2026 the ClawHavoc campaign used them to install a password
  stealer: hundreds of malicious skills on ClawHub told agents to run an "installer" that was malware.
- **Virus scanners miss plain-language payloads.** They now check skill packages, but their makers say they can't
  catch instructions written in plain language.
- **So we scanned the text itself.**

## What we scanned
- **9,930 unique SKILL.md files from 277 public GitHub repositories:**
  - Anthropic, Vercel, Composio, K-Dense and OpenClaw;
  - obra/superpowers;
  - every repository linked from two community lists of skills.
- **Pinned and de-duplicated:** each file is pinned to the commit we scanned and counted once by its fingerprint.
- **Ordinary skills vs examples:** 916 files are security courses, scanner test fixtures or examples, which quote
  attack patterns on purpose. We report them separately and don't treat them as clean or as findings.
- **Not included:** ClawHub, because its skill index isn't public on GitHub (the malicious skills found there were
  removed), and private skills.

## What the words mean
| Term | Meaning |
|---|---|
| **Flagged** | At least one high-severity pattern: a download piped into a shell, a read of key or credential files, data sent to a throwaway collection endpoint, hidden text in invisible characters, or deleting the home or root directory. |
| **Caution** | Medium-severity patterns only, such as turning off permission prompts, editing the agent's standing files, or instructions inside HTML comments. |
| **Clear** | No known pattern matched. That isn't proof a file is safe. |

A pattern on a line that reads as a warning or an example ("never run…") is lowered one step and marked.

## What we found
| | Ordinary skills | Security courses, tests, examples |
|---|---|---|
| Files | 9,014 | 916 |
| Flagged | 30 (0.33%) in 21 repositories | 47 |
| Caution | 147 | 47 |
| Clear | 8,837 | 822 |

**We hand-reviewed all 30 flagged ordinary files:**
- **26 are real patterns:** the file really does pipe an installer, read a key file, and so on.
- **4 are false matches:** three guardrail skills that list `rm -rf /` as a command to block, and one security
  auditor that names a throwaway endpoint as something to detect.
- **None showed signs of malice.**
- **Precision on this sample:** 87%.

1. **Piping a download into a shell: 14 files in 11 repositories.**
   - This is the delivery trick ClawHavoc used: the agent runs whatever the server sends at that moment, unseen.
   - Most of these are vendors' own documented installers (uv, rustup, the Google Cloud SDK, Claude Code), in
     official skills from Google, NVIDIA, Anthropic and Trail of Bits. If you trust the vendor, the risk is low.
   - The concern is the habit: an agent that learns to pipe installers from trusted skills will do it for
     untrusted ones too.
   - A safer pattern is to install from a package manager, or download, show the human, then run.
2. **Reading the agent's whole key file: 8 files in 5 repositories.**
   - These read `~/.env`, `~/.claude/.env` or `~/.openclaw/.env` to get one API key.
   - That file usually holds every key the agent has. The skills we read only wanted their own key, but the
     pattern exposes the rest.
   - Reading one named variable is safer.
3. **Smaller patterns** (one file each unless stated):
   - writing cloud credentials (2 files);
   - downloading a binary and making it executable;
   - running downloaded PowerShell;
   - running a download through `bash -c`.

**The most common medium patterns:**
- turning off the agent's permission prompts (28 files);
- editing the agent's standing files, such as AGENTS.md or CLAUDE.md (27);
- instructions inside HTML comments, which are hidden when the file is rendered (16);
- reading a `.env` file (16).

## The flagged ordinary skills
**What's named and what isn't:**
- **Named now:** the four vendors' official installers. Their result pages are linked below.
- **Anonymised:** the other 17 repositories, mostly individual or small-team projects, while their maintainers hear
  from us first. Their result pages stay unlisted until 2 November.

A match is a reason to read a line, not a verdict on the author. Publishers can reply on each page, and the reply is
shown there.

| Who | File | What matched | Hand review |
|---|---|---|---|
| Anthropic (anthropics/claude-agent-sdk-python) | [.claude/skills/verify/SKILL.md](https://theagentforge.io/scan/f499a4e88c29144d6faf08eda62ff46035f99a8d29766ee504c0a6e1fe1edf09) | pipes a download into a shell | real pattern, no sign of malice |
| Google (google/skills) | [skills/cloud/developing-genkit-dart/SKILL.md](https://theagentforge.io/scan/4d61bfae2a7eb15c751779d577df9295009cad2dd550ad26484423819ffc6d44) | pipes a download into a shell | real pattern, no sign of malice |
| Google (google/skills) | [skills/cloud/developing-genkit-go/SKILL.md](https://theagentforge.io/scan/bc4bf4f9154a91721077551941dcf281d439818f7019ef7f1d9bd8536987ffec) | pipes a download into a shell | real pattern, no sign of malice |
| NVIDIA (NVIDIA/skills) | [skills/tao-run-on-brev/SKILL.md](https://theagentforge.io/scan/d6e9f1ddb47af386fd11829240b8b6756b525b140ec3d1a29c0f4f88c1105a9f) | pipes a download into a shell | real pattern, no sign of malice |
| NVIDIA (NVIDIA/skills) | [skills/vss-deploy-profile/SKILL.md](https://theagentforge.io/scan/d777f8b46d5cc48d1a7a460202290f3d823be5a153ba172a14d367e9c4475f81) | pipes a download into a shell | real pattern, no sign of malice |
| Trail of Bits (trailofbits/skills) | [plugins/testing-handbook-skills/skills/libafl/SKILL.md](https://theagentforge.io/scan/2f7f261439c2d87a15ddbb8a04a387fb8c211b9f20b00baf28b1466e036fc0d5) | pipes a download into a shell | real pattern, no sign of malice |
| Repository A | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository B | unlisted until 2 Nov | contains rm -rf / | false match: quoted as a rule to block |
| Repository C | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository D | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |
| Repository E | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |
| Repository F | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository F | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |
| Repository F | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |
| Repository G | unlisted until 2 Nov | downloads a binary and makes it executable | real pattern, no sign of malice |
| Repository H | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |
| Repository H | unlisted until 2 Nov | contains rm -rf / | false match: quoted as a rule to block |
| Repository I | unlisted until 2 Nov | names a throwaway data-collection endpoint | false match: quoted as a rule to block |
| Repository J | unlisted until 2 Nov | reads or writes cloud credentials | real pattern, no sign of malice |
| Repository K | unlisted until 2 Nov | contains rm -rf / | false match: quoted as a rule to block |
| Repository L | unlisted until 2 Nov | pipes a download into a shell, runs downloaded PowerShell | real pattern, no sign of malice |
| Repository M | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |
| Repository M | unlisted until 2 Nov | reads or writes cloud credentials | real pattern, no sign of malice |
| Repository N | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository N | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository N | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository N | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository O | unlisted until 2 Nov | runs a download through bash -c | real pattern, no sign of malice |
| Repository P | unlisted until 2 Nov | reads the agent's whole key file | real pattern, no sign of malice |
| Repository Q | unlisted until 2 Nov | pipes a download into a shell | real pattern, no sign of malice |

## Method and limits
- **How it works:** 34 text rules ([/scan/rules](/scan/rules)), taken from published attacks. No model, and nothing
  is run.
- **It can be evaded:** a careful attacker can split a payload across files, fetch it at run time, or reword it.
  Researchers have shown that simple tricks get past today's skill scanners. A clear result is not proof of
  safety.
- **How we tuned it:** two rounds on this corpus before publishing, to cut false matches (for example "do not ask the
  user", emoji joiners, capturing an API reply with `$(curl …)`). The rule changes are in the rules version history.
- **Reproduce it:** the dataset has every file's fingerprint, path, commit and matches, except 241 flagged or
  caution files from the unnamed repositories, which we add on 2 Nov once their maintainers have had notice. The
  counts above include them. The scanner is open source in
  `packages/shared/src/skill-scan.ts` (github.com/theagentforge/agent-forge).
- **Conflict of interest:** The Agent Forge offers this scanner free, and hopes you'll use it. We have no commercial
  relationship with any repository named here.
- **Corrections:** email hello@theagentforge.io or reply on a result page. Corrections are dated in the changelog
  below.

## Changelog
- **1.1, note (28 Oct 2026):** two maintainers of anonymised repositories replied to their notices. One fixed the
  flagged file, and the other had already changed it after our 19 Oct scan. We re-scanned both current files: no
  pattern matched. The headline counts don't change, because they describe the commits we scanned. From 2 November each
  entry shows the result at the scanned commit, the maintainer's response and our rescan.
- **1.1 (19 Oct 2026):** severity definitions, hand review of all 30 flags, small repositories anonymised pending
  notice (their rows held back from the dataset until 2 Nov), limits and conflict-of-interest sections.
- **1.0 (19 Oct 2026):** first draft.

## Check yours
Paste or link any skill at https://theagentforge.io/scan, or tell your agent: "Read
https://theagentforge.io/skill.md and use it: before you install any skill, plugin or MCP server, check it with The
Forge."
