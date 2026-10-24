# What an agent can check this week: October 2026 advisories

*As of 23 Oct 2026. Official pages first; this page only says what our check returns.*

**Short answer:** since 23 Oct, every Forge check of an npm or PyPI package also reads OSV, the open advisory database
that carries the OpenSSF malicious-package records (`MAL-` ids) and GitHub and PyPI advisories, and CISA's Known
Exploited Vulnerabilities list. Give the check a name and a version; it returns the advisory ids that match, the fixed
version and the source link. No account.

## The facts, from the people who own them
**LiteLLM 1.107.0 (PyPI and Docker), 21 Oct.** LiteLLM's maintainers say the 1.107.0 release was compromised: the PyPI
wheels between 11:39 and 13:23 UTC, and the Docker images tagged 1.107.0, latest, main-latest and main-stable between
11:46 and 14:20 UTC. They say earlier versions are unaffected and the affected releases were pulled, and that anyone who
installed 1.107.0 in that window should assume compromise. Their page:
[LiteLLM security incident, 21 Oct 2026](https://docs.litellm.ai/blog/security-incident-oct-21-2026).

**PHP2Shell (CVE-2026-109618, CVE-2026-109619), 21 Oct.** Fixed in PHP 8.5.12, 8.4.27, 8.3.36 and 8.2.35. The PHP
project's notes: [PHP 8 ChangeLog](https://www.php.net/ChangeLog-8.php).

## What our check said, before and after
We asked our own check about `pypi:litellm` before and after this change. Same question, our answer:

| Asked | Before (23 Oct, morning) | After (23 Oct, 10:43 UTC) |
|---|---|---|
| litellm, version 1.107.0 | `clear` (version not read; no advisory data) | `flagged`: matches **MAL-2026-2144**, a malicious-package record (alias PYSEC-2026-2) |
| litellm, version 1.106.2 | `clear` | `unknown`: no advisory matched this version |
| litellm, no version given | `clear` | `caution`: 82 published advisories for some version, the malicious-package record first |

Our check said "clear" about a compromised release. That was wrong for that version, and it is
the gap this change closes. OSV's record [MAL-2026-2144](https://osv.dev/vulnerability/MAL-2026-2144) was last updated
on 21 Oct at 22:01 UTC; from then on, this check would have flagged 1.107.0. It could not have flagged it earlier: a
check can only match an advisory once it is published.

## How to check from an agent
- **MCP** (no sign-in): add `https://theagentforge.io/mcp/public`, then ask `forge_check` with the package and version,
  for example `{"id": "pypi:litellm", "version": "1.107.0"}`.
- **Plain HTTP:** `https://theagentforge.io/api/v1/check?id=pypi:litellm&version=1.107.0`
- **A whole stack at once:** `forge_exposure` on the same MCP server takes up to 500 npm and PyPI names with exact
  versions, or `pip freeze` text, and returns only the ones that match a published advisory. Names and versions only.
- **On the site:** [check a tool](/check).

The answer is data: `security_status`, and under `public_signals_summary` each advisory's id, whether it is a
malicious-package record or a vulnerability, its aliases, the fixed versions, `exploited_in_wild` (CISA KEV) and a link
to the record on osv.dev. OSV's own text is never passed on.

## Honest limits
- A check can match a release only after an advisory for it is published. It can't vouch for a version no one has
  looked at yet.
- "No advisory matched" is not the same as "fine": it means OSV had no record for that version when we asked.
- We cover npm and PyPI packages. Skills and MCP servers with no package id get field reports and scans only.
- Nobody here marks a tool "confirmed malicious" automatically; that stays a human decision.

*The October 2026 wave some are calling "Black October" also covers other incidents; this page lists only the ones a
Forge check can answer.*
