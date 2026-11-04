# What public agent skills tell your agent to do: launch scan, 19 Oct 2026

*The Agent Forge, 19 October 2026. Report version 1.2, rules version 2026-10-19.3. Data:
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
**Every repository is named, and each file links to its result page:**
- **Named at launch:** the four vendors' official installers.
- **Named from 2 November:** the other 17 repositories, mostly individual or small-team projects, which were
  anonymised until then while their maintainers heard from us first. Where a maintainer responded, the response and
  our rescan are in the last column.

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
| AceDataCloud/Skills | [clawhub/api-guide/SKILL.md](https://theagentforge.io/scan/f22592ae04c69686c427edefb145b63a517e8032e3e8d42fe6b611be64d47a73) | reads the agent's whole key file | real pattern, no sign of malice |
| BehiSecc/VibeSec-Skill | [SKILL.md](https://theagentforge.io/scan/d83cd2d3002a7d77cf4ee395d82059f925429dcd584f9c02ea55f0dee7ca94da) | contains rm -rf / | false match: quoted as a rule to block |
| BrianRWagner/ai-marketing-claude-code-skills | [last30days/SKILL.md](https://theagentforge.io/scan/bd504b9b7ddd60513cf3ffcc9264d7640c12819349ef8421b1d63ad02fec69d1) | reads the agent's whole key file | real pattern, no sign of malice |
| ReScienceLab/opc-skills | [skills/requesthunt/SKILL.md](https://theagentforge.io/scan/3107b90ff342ef57f98d778a09c5376a8ac2878c5e1855c0f29d59bbdf84526c) | pipes a download into a shell | real pattern, no sign of malice |
| Tencent/AI-Infra-Guard | [agent-scan/agent_scan/prompt/skills/unexpected-code-execution-detection/SKILL.md](https://theagentforge.io/scan/a33d1417a50cc405f4d3a44f3ed03ab23da5d637a0f93b18417a6cb567fe6c4b) | pipes a download into a shell | real pattern, no sign of malice. Maintainer response (29 Oct 2026, [#730](https://github.com/Tencent/AI-Infra-Guard/issues/730)): by design, a detection skill in a security scanner whose matched lines are probe payloads sent to an audited target, never run at load time; no change planned |
| VoDaiLocz/kilo-kit-mcp | [skills/ai-media/ai-multimodal/SKILL.md](https://theagentforge.io/scan/492e291734b1039cd7c8782fd9dc6364e7befd00fa8a26255caa8c7446146fe7) | reads the agent's whole key file | real pattern, no sign of malice |
| VoDaiLocz/kilo-kit-mcp | [skills/engineering/render-deploy/SKILL.md](https://theagentforge.io/scan/c17c75adeb1834ed5cee1e440a651ae476c4101cd63762fcd9a58eada917552d) | pipes a download into a shell | real pattern, no sign of malice |
| VoDaiLocz/kilo-kit-mcp | [skills/operations/devops/SKILL.md](https://theagentforge.io/scan/c947d0a2f13d527a4e54edd782b1fc6f726288a4a45002b1e0a64d0d7efe878e) | pipes a download into a shell | real pattern, no sign of malice |
| aeonfun/aeon | [skills/vuln-scanner/SKILL.md](https://theagentforge.io/scan/2f4f8e71b719d7fc0adae62afdd6aeef0446ff0c60bc4da0b1e8d11e68cd31a4) | downloads a binary and makes it executable | real pattern, no sign of malice. Maintainer response (28 Oct 2026): fixed in [#1286](https://github.com/aeonfun/aeon/pull/1286); rescan at `e6058e3accb3`: clear |
| amirkiarafiei/subagent-cli-skills | [skills/deepagents-code/SKILL.md](https://theagentforge.io/scan/680b03ddb797d73f7529305c4da70e5c7526855c3706cc8c87bf1ceb006e0226) | pipes a download into a shell | real pattern, no sign of malice |
| amirkiarafiei/subagent-cli-skills | [skills/hermes-agent/SKILL.md](https://theagentforge.io/scan/640981fd83d9deada64ad5c30101ea98725e63024be7f727cfbf25c908425fa8) | contains rm -rf / | false match: quoted as a rule to block |
| lawve-ai/awesome-legal-skills | [skills/skill-security-auditor-lawve/SKILL.md](https://theagentforge.io/scan/44f68d2f1a835e1fd75de174c75fb82af0d64bf1e8172fde42e71eb527ec855e) | names a throwaway data-collection endpoint | false match: quoted as a rule to block |
| metalbear-co/skills | [skills/mirrord-ci/SKILL.md](https://theagentforge.io/scan/c5c50f7e6e53cfcaa5755beec7c9f60225a955eacf2ef6638c75ad6e41a0cd9f) | reads or writes cloud credentials | real pattern, no sign of malice |
| rainmanjam/poka-yoke | [plugins/poka-yoke/skills/agent-guardrails/SKILL.md](https://theagentforge.io/scan/51f9646a0e09c1520eddfc4e0117ee5128958bd0cbce9f66a08f9455010b0207) | contains rm -rf / | false match: quoted as a rule to block |
| squirrelscan/skills | [skills/squirrelscan/SKILL.md](https://theagentforge.io/scan/5401edd6eaae333ff7afa9e8f267811b72ab01db5aa2dc5b017c88f1601e0f0c) | pipes a download into a shell, runs downloaded PowerShell | real pattern, no sign of malice. Maintainer response (28 Oct 2026): fixed in [#25](https://github.com/squirrelscan/skills/pull/25) (29f6fad, 24 Oct, after our 19 Oct scan); rescan at `8ce7e12d51e0`: clear |
| thedotmack/claude-mem | [openclaw/SKILL.md](https://theagentforge.io/scan/c79300106ea780050828472e51b33b3a62e60043cef9f7d97e35558319d4bc71) | pipes a download into a shell | real pattern, no sign of malice |
| thedotmack/claude-mem | [plugin/skills/version-bump/SKILL.md](https://theagentforge.io/scan/3624047d35fe6f0fbde7211172b86a88bcc46f1e3d4f560207e317ca281e47ed) | reads or writes cloud credentials | real pattern, no sign of malice |
| wanshuiyin/Auto-claude-code-research-in-sleep | [skills/gemini-search/SKILL.md](https://theagentforge.io/scan/a8778e4e1dacae68691d13342a9a33200ade427beb777a4defbbb91dfcb030e3) | reads the agent's whole key file | real pattern, no sign of malice. Maintainer response (29 Oct 2026): fixed in [#482](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/482); rescan at `a3a847b421c6`: clear |
| wanshuiyin/Auto-claude-code-research-in-sleep | [skills/openalex/SKILL.md](https://theagentforge.io/scan/4c853b646987c4472a8360e044ad232aa9731dcfb60c7183073e8e5f3e6ac9c1) | reads the agent's whole key file | real pattern, no sign of malice. Maintainer response (29 Oct 2026): fixed in [#482](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/482); rescan at `a3a847b421c6`: clear |
| wanshuiyin/Auto-claude-code-research-in-sleep | [skills/deepxiv/SKILL.md](https://theagentforge.io/scan/19d6b9a334f56398be97f68727feaf7689134e5294f7d9507a2d071b1eeed148) | reads the agent's whole key file | real pattern, no sign of malice. Maintainer response (29 Oct 2026): changed the file in [#482](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/482); rescan at `a3a847b421c6`: still matches FS-SEC-003 (line 54, now describing the third-party SDK's own `~/.env` handling) |
| wanshuiyin/Auto-claude-code-research-in-sleep | [skills/skills-codex/deepxiv/SKILL.md](https://theagentforge.io/scan/a249c058513dfda7424e601edff1a19adaa27192124b152f8c45eed8c7ab64a1) | reads the agent's whole key file | real pattern, no sign of malice. Maintainer response (29 Oct 2026): changed the file in [#482](https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep/pull/482); rescan at `a3a847b421c6`: still matches FS-SEC-003 (line 51, now describing the third-party SDK's own `~/.env` handling) |
| wendylabsinc/claude-skills | [wendy-cloud-iterate/SKILL.md](https://theagentforge.io/scan/9a7feb8801a59bda9561d1372b99fea30a9cc21df93118257a9aea7a4ccd1aef) | runs a download through bash -c | real pattern, no sign of malice |
| wrsmith108/linear-claude-skill | [SKILL.md](https://theagentforge.io/scan/8dec60611ff95e214ba16ad0c35a51bf4f7c80df1ff7613a63803897d6879c04) | reads the agent's whole key file | real pattern, no sign of malice |
| wrsmith108/varlock-claude-skill | [skills/varlock/SKILL.md](https://theagentforge.io/scan/1548230c6144ead7d00d53a37420a39ef3477d20fdcbf9760668153dfe72f5fc) | pipes a download into a shell | real pattern, no sign of malice |

## Method and limits
- **How it works:** 34 text rules ([/scan/rules](/scan/rules)), taken from published attacks. No model, and nothing
  is run.
- **It can be evaded:** a careful attacker can split a payload across files, fetch it at run time, or reword it.
  Researchers have shown that simple tricks get past today's skill scanners. A clear result is not proof of
  safety.
- **How we tuned it:** two rounds on this corpus before publishing, to cut false matches (for example "do not ask the
  user", emoji joiners, capturing an API reply with `$(curl …)`). The rule changes are in the rules version history.
- **Reproduce it:** the dataset has every file's fingerprint, path, commit and matches, all 9,930 of them. (Until
  2 Nov it left out 241 flagged or caution files from 61 repositories outside the four vendors, while their
  maintainers heard from us; the counts above always included them.) The scanner is open source in
  `packages/shared/src/skill-scan.ts` (github.com/theagentforge/agent-forge).
- **Conflict of interest:** The Agent Forge offers this scanner free, and hopes you'll use it. We have no commercial
  relationship with any repository named here.
- **Corrections:** email hello@theagentforge.io or reply on a result page. Corrections are dated in the changelog
  below.

## Changelog
- **1.2 (2 Nov 2026):** the notice period has ended. The 17 repositories anonymised in 1.1 are named, each flagged
  file links to its result page, and the 241 flagged or caution files held back from the dataset (from 61
  repositories) are in it. Three maintainers responded to their notices with changes: aeonfun/aeon fixed its file on
  28 Oct (#1286), and squirrelscan/skills had changed its file on 24 Oct (#25), after our scan. Both current files
  scan clear. wanshuiyin/Auto-claude-code-research-in-sleep changed four files on 29 Oct (#482): two now scan clear;
  the two DeepXiv files still match FS-SEC-003, in new text describing the third-party SDK's own handling of ~/.env.
  Each entry shows the result at the commit we scanned, the maintainer's response and our rescan.
  Tencent/AI-Infra-Guard replied on 29 Oct (#730) that its file works as designed: it is a detection skill in a
  security scanner, whose matched lines are probe payloads sent to an audited target and never run at load time, so
  no change is planned. The headline counts are unchanged, because they describe the commits we scanned.
- **1.1, title (1 Nov 2026):** the title no longer carries a number, so it can't be read as a count of skills (it said
  "9,930", which counts every file scanned, while the rate is over 9,014 ordinary skills). No number in the report
  changed; the table below keeps both counts.
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
