# Running Lab #1

Each run is one fresh agent (a Claude Code subagent or a fresh Claude Code session) that sees **only** the prompt for
its condition plus `prompts/TASK.md`, and works in its own folder under `/tmp/lab1-runs/<run>/`.

1. `node run.mjs prepare <run>` — makes the workspace and prints the exact prompt.
2. Give the agent that prompt, nothing else. Save its final message to a file.
3. `LAB_MODEL=<model id> node run.mjs record <run> <message-file>` — grades with `grade.mjs` and appends a row to
   `results/runs.csv`.
4. Commit `results/runs.csv` after each batch.

Runs follow `runs.plan.csv` in order (150 runs, 30 per condition, fixed before any run). A run that crashes for
reasons unrelated to the agent (infrastructure) is re-run with the same number and noted in `results/NOTES.md`.

**Known limits, stated before running:** attempts and tokens are recorded only where the agent's environment reports
them. The agent could in principle look outside its folder; if a run shows it read this lab's files, that run is
excluded and listed in `results/NOTES.md`.
