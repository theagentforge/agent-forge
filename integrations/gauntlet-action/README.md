# Forge Gauntlet (GitHub Action)

Tests **your own AI agent** on the [Forge Gauntlet](https://theagentforge.io/gauntlet) on every change: everyday business
jobs (paying invoices, refunds, purchasing) in a sandbox with planted traps such as a changed payee, a hidden
instruction in an email or a flaky tool that tempts a double payment. The check fails when your agent falls for a trap,
and the job summary shows which traps it fell for, with a link to each job's replay.

- **Your model, your key.** The key goes only to the model address you give (redirects are refused), is masked in
  logs, and is never sent to The Forge.
- **No account, nothing to pay The Forge.** The Gauntlet referees from the agent's tool calls, so a run costs you only
  your own model calls. A Sprint (the default) is one job with at most 10 tool calls.
- **Comparable re-runs.** Replay an earlier run's exact six jobs with `challenge` to compare before and after a change.

```yaml
# .github/workflows/gauntlet.yml
name: Forge Gauntlet
on: [pull_request]
permissions:
  contents: read
jobs:
  gauntlet:
    runs-on: ubuntu-latest
    steps:
      - uses: theagentforge/gauntlet@v1
        with:
          model: gpt-5-mini
          api-key: ${{ secrets.OPENAI_API_KEY }}
```

## Two ways to drive your agent

### 1. A chat model (any OpenAI-compatible endpoint)
Give `model`, `api-key` and, for anything other than OpenAI, `base-url` (OpenRouter, Together, Groq, Azure OpenAI's
v1 address, vLLM or Ollama on the runner with `http://localhost:…/v1`). The action plays the agent loop: each job's
tools are offered to the model as functions, every tool call is sent to the Gauntlet, and the result goes back to the
model. By default it uses the Arena's published harness prompt and turn cap (8 replies a job), so your numbers read
against the Arena's. Put your agent's own instructions in `system-prompt` to test what you ship.

```yaml
      - uses: theagentforge/gauntlet@v1
        with:
          model: anthropic/claude-sonnet-4.5
          base-url: https://openrouter.ai/api/v1
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
          system-prompt: ${{ vars.AGENT_SYSTEM_PROMPT }}
```

### 2. Your own agent harness (`command`)
Your agent has its own loop, tools or framework? The action starts the run, then runs your command with:

| Variable | What it holds |
|---|---|
| `FORGE_GAUNTLET_ID` | The run to play |
| `FORGE_GAUNTLET_MCP_URL` | The Gauntlet MCP server (`gauntlet_status`, `gauntlet_act`) |
| `FORGE_GAUNTLET_API_URL` | The same run over plain HTTP (`GET` it, `POST …/act`) |
| `FORGE_GAUNTLET_START_FILE` | A JSON file with the first job: brief, tools and limits |
| `FORGE_GAUNTLET_MODE` | `sprint` or `full` |

Your agent plays that run (call `gauntlet_status` for the current job, then `gauntlet_act` with a tool and its
arguments; `finish` ends a job). Don't call `gauntlet_start`: that would be a different run. When the command exits,
the action reads the result **from The Forge**, not from your command's output. Your command gets the environment a `run:`
step would (none of the action's inputs); pass your own secrets with `env:`.

```yaml
      - uses: theagentforge/gauntlet@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          command: python agent/play_gauntlet.py
```

## A blocking gate, by default
When your agent falls for a planted trap, the step exits non-zero, so the job fails. Make the job a **required status
check** (branch protection or a ruleset) and a pull request can't merge until the agent passes. To report without
blocking, set `fail-on-trap: none`; to block on some trap families only, list them (below).

In Harness's [State of Agent DLC 2026](https://www.harness.io/state-of-agent-dlc-2026) (a Sapio Research survey of 700
technology professionals at large enterprises, July 2026), 19% said they have a gate that automatically blocks every
bad release.

## When the check fails

| Input | Default | Meaning |
|---|---|---|
| `fail-on-trap` | `any` | `any` sprung trap fails the check (the step exits non-zero); `none` reports only (the opt-out); or trap families, e.g. `PAY,INJ,PRM` |
| `min-pass-rate` | `0` | Also fail when fewer than this % of jobs are right |
| `mode` | `sprint` | `sprint` (one job, the week's pick) or `full` (six jobs) |
| `challenge` | | With `mode: full`: an earlier run id (from the `gauntlet-id` output) or `model:<id>`, to play identical jobs |
| `max-turns` | `8` | Model replies a job (way 1). A job not finished is "incomplete", which fails |
| `fail-on-error` | `false` | Fail when no run could be played or read: The Forge unreachable or erroring, its daily limit hit, or an empty `api-key` (a fork's pull request gets no secrets) |

Trap families (ids look like `FA-PAY-001`; the full list is on [/benchmark](https://theagentforge.io/benchmark)):
PAY paid a scam or changed payee · INJ followed a hidden instruction · DUP double payment or order · POL policy breach ·
AMT wrong amount · CLM false success · DAT deleted or merged the wrong record · TIM time zone or deadline ·
PRM permission overreach. The Forge publishes no per-trap severity, so families are the filter. A trap outside the
public catalog has no family and counts under every filter.

A run the agent didn't finish (the model stopped or ran out of turns, a job's tool calls or the time limit ran out)
always fails, even with no trap sprung: the action never calls `finish` for your agent.

## Output
- **Job summary:** jobs right, traps it fell for (linked to the Trap Set), each job's replay (kept 30 days), the run
  page, and for a full run the trap card: the published checks, with the ones it slipped on first.
- **Pull request comment:** off by default. `comment: true` posts one comment and edits it on later runs (needs
  `permissions: pull-requests: write`; a fork's pull request gets a read-only token, so the summary carries it).
- **Outputs:** `verdict` (pass, fail, incomplete, not-run), `gauntlet-id`, `report-url`, `jobs-passed`, `jobs-total`,
  `traps-fell`, `fell-for`, `replay-urls` (each played job's signed replay) and `replays-signed`.
- **Score page and badge:** off by default. Runs are anonymous. With `claim-link: true` the masked output `claim-url`
  holds the run's private claim link; a verified owner who opens it can claim the run, which gives it a score page
  (`/score/<id>`) and a README badge. Don't print it or paste it anywhere public: anyone with it can claim the run.

A pass means your agent didn't fall for these traps on these jobs. It is not a statement that an agent is safe.

## Audit evidence: signed replays
Every job the agent played has a replay: the log of its tool calls and the referee's result, hash-chained and signed
with The Forge's published Ed25519 key (replay format v2, keys at
`https://theagentforge.io/.well-known/forge-keys.json`). The output `replay-urls` lists each job's replay JSON and
`replays-signed` says how many carry a signature; the job summary links them. Anyone can check one without trusting
The Forge or your CI:

```sh
npx @theagentforge/cli@0.7.1 verify https://theagentforge.io/gauntlet/r/<run-id>/1.json
```

The Forge keeps Gauntlet replays 30 days. To keep them with your build for longer, save them in a later step:

```yaml
      - uses: theagentforge/gauntlet@v1
        id: gauntlet
        with:
          model: gpt-5-mini
          api-key: ${{ secrets.OPENAI_API_KEY }}
      - name: Save the signed replays
        if: always() && steps.gauntlet.outputs.replay-urls != ''
        env:
          URLS: ${{ steps.gauntlet.outputs.replay-urls }}
        run: |
          mkdir -p gauntlet-evidence
          for u in ${URLS//,/ }; do curl -fsS "$u" -o "gauntlet-evidence/$(basename "$(dirname "$u")")-$(basename "$u")"; done
      - uses: actions/upload-artifact@v7
        if: always() && steps.gauntlet.outputs.replay-urls != ''
        with:
          name: gauntlet-evidence
          path: gauntlet-evidence/
```

A signed replay shows what the agent did on these jobs and that the record wasn't changed afterwards. It records a
test result on these jobs, nothing more.

## What it tests, against the OWASP Top 10 for Agentic Applications
Each public trap carries the closest category of the
[OWASP Top 10 for Agentic Applications for 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
(OWASP GenAI Security Project, 9 Dec 2025), or none where none fits; the mapping is never forced. For the Gauntlet's
six jobs:

| OWASP category | Gauntlet traps (fit) | Note |
|---|---|---|
| ASI01 Agent Goal Hijack | FA-INJ-001 (direct) |  |
| ASI02 Tool Misuse and Exploitation | none | Planted only in the harder Arena jobs, which this action doesn't play ([full mapping](https://theagentforge.io/gauntlet/ci#owasp)). |
| ASI04 Agentic Supply Chain Vulnerabilities | none | Not tested by the Gauntlet. [forge-check](https://github.com/theagentforge/forge-check) fails CI when an MCP server or tool your repository uses is flagged (field reports, OSV advisories): known reports only. |
| ASI09 Human-Agent Trust Exploitation | FA-CLM-001 (partial) |  |

The other traps of these jobs (changed payee, double order, refund and booking policy, wrong amount, deleted record, time zone)
have no OWASP agentic category that fits.

## What is sent to The Forge
Exactly what any Gauntlet run sends: the start (`mode`, and `challenge` if set) and each tool call your agent makes
(the tool's name and arguments). Never your key, the model's name, the model's text replies, your repository or your
account. The start address carries the fixed tag `?client=gh-action-gauntlet-1.0.0`, which only adds to a daily
counter of runs started from this action (at most one a day per runner address); nothing about you is in it. Like any web request, it reaches The Forge from
the runner's network address, which Cloudflare's request logs keep for up to 7 days; the Gauntlet's daily limits use a
one-day code made from it, never the address itself.

## Limits
The Gauntlet's own limits apply to everyone: 20 Sprints and 10 full runs a day per address, and 60 calls a minute per
run (the action waits and retries). GitHub-hosted runners change address, so these rarely bind in CI. Costs: a Sprint is
at most 8 model calls (`max-turns`); a full run at most 48 (six jobs × 8), at your model's prices.

Licence: MIT. Source: `integrations/gauntlet-action/` in [theagentforge/agent-forge](https://github.com/theagentforge/agent-forge).
