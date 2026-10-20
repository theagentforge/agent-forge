# Tool selection test, 2026-10-20

docs/launch/agent-channels.md §4.1. The fixed 30 requests in `apps/forge/src/ops/tool-selection.ts` (20 that fit one of our five `/mcp/public` tools, 10 that fit none), sent to each model through its API with our tools mixed among eight ordinary ones (web search, fetch, read file, shell, npm install, email, weather, create repo). Temperature 0, one call each; the first tool call counts. Descriptions are tuned for accuracy on this set, never for win rate.

| Model | Picked the right tool (of the 20 that fit) | Missed (no Forge tool) | Wrong Forge tool | False triggers (of the 10 that don't fit) | Errors | Cost |
|---|--:|--:|--:|--:|--:|--:|
| claude-sonnet-5.5 | 100% (20 of 20) | 0 | 0 | 0 of 6 | 4 | $0.159 |
| gpt-6.1-sol | 80% (16 of 20) | 4 | 0 | 0 of 10 | 0 | $0.065 |

## Each request

| # | Expected | claude-sonnet-5.5 | gpt-6.1-sol |
|--:|---|---|---|
| 1 | forge_check | ✓ forge_check | ✓ forge_check |
| 2 | forge_check | ✓ forge_check | ✓ forge_check |
| 3 | forge_check | ✓ forge_check | ✗ web_search |
| 4 | forge_check | ✓ forge_check | ✓ forge_check |
| 5 | forge_check | ✓ forge_check | ✓ forge_check |
| 6 | forge_check | ✓ forge_check | ✓ forge_check |
| 7 | forge_scan | ✓ forge_scan | ✓ forge_scan |
| 8 | forge_scan | ✓ forge_scan | ✓ forge_scan |
| 9 | forge_scan | ✓ forge_scan | ✓ forge_scan |
| 10 | forge_scan | ✓ forge_scan | ✗ fetch_url |
| 11 | forge_scan | ✓ forge_scan | ✗ none |
| 12 | forge_scan or forge_check | ✓ forge_scan | ✗ fetch_url |
| 13 | forge_watch | ✓ forge_watch | ✓ forge_watch |
| 14 | forge_watch | ✓ forge_watch | ✓ forge_watch |
| 15 | forge_traps | ✓ forge_traps | ✓ forge_traps |
| 16 | forge_traps | ✓ forge_traps | ✓ forge_traps |
| 17 | forge_traps or arena_results | ✓ forge_traps | ✓ forge_traps |
| 18 | arena_results | ✓ arena_results | ✓ arena_results |
| 19 | arena_results | ✓ arena_results | ✓ arena_results |
| 20 | arena_results | ✓ arena_results | ✓ arena_results |
| 21 | none of ours | ✓ npm_install | ✓ npm_install |
| 22 | none of ours | ✓ get_weather | ✓ get_weather |
| 23 | none of ours | ✓ none | ✓ none |
| 24 | none of ours | ✓ none | ✓ none |
| 25 | none of ours | ✓ web_search | ✓ web_search |
| 26 | none of ours | ✓ read_file | ✓ read_file |
| 27 | none of ours | ✗ error | ✓ github_create_repo |
| 28 | none of ours | ✗ error | ✓ none |
| 29 | none of ours | ✗ error | ✓ none |
| 30 | none of ours | ✗ error | ✓ fetch_url |

Limits: one run per model, through the API rather than the Claude and ChatGPT apps' own tool search, and the decoys are ours. A change in a description shows here as a change in accuracy or false triggers.

## What it shows (first run, before any tuning)
- **Claude Sonnet 5.5:** picked the right Forge tool for every request that fit (20 of 20) and none for the ones that didn't (0 of 6 that came back). Four calls failed at the provider; they are left out, not counted as right.
- **GPT-6.1 Sol:** 16 of 20, with no false triggers (0 of 10). Its four misses:
  - two scan requests that included a URL, where it reached for the generic `fetch_url` (#10, #12);
  - a pasted tool description it judged by itself (#11);
  - a registry lookup it sent to `web_search` (#3).
- **No description changes follow from one run.** Tuning against this fixed set would teach to the test (agent-channels §2.4). If GPT keeps fetching instead of scanning over the next runs, the `forge_scan` description can say more plainly that it takes the URL itself. The test is then re-run, and both numbers are reported.

