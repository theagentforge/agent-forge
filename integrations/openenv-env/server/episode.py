"""One Forge Arena dev-split episode, without OpenEnv: pick a row, run tool calls, referee the end state.

This module needs only the standard library, so the parity tests run anywhere (CI runs them with plain python3). The
tools and referee are not copied here: they are the Verifiers package's Python port (`forge_arena_dev.sim`, in
integrations/verifiers-env), which is checked call by call against the TypeScript Arena. In a repo checkout the
sibling folder is found automatically; the container image copies it in (server/Dockerfile).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

try:
    from forge_arena_dev import sim
except ImportError:  # a repo checkout: use the sibling Verifiers package's port rather than a second copy
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "verifiers-env"))
    from forge_arena_dev import sim

SPLIT = "dev"
"""The only split: the public practice seeds. Held-out and Season seeds are never served (ADR 0057, 0063)."""


def load_split() -> dict:
    return sim.load_split()


def task_specs(split_data: dict) -> list[dict[str, Any]]:
    """Task API entries: what each row is, never its world, traps or reference play."""
    return [
        {"id": r["id"], "index": i, "split": SPLIT, "job": r["task"], "seed": r["seed"], "title": r["title"]}
        for i, r in enumerate(split_data["rows"])
    ]


def pick_row(
    split_data: dict,
    *,
    task_id: str | None = None,
    split: str | None = None,
    index: int | None = None,
    job: str | None = None,
    seed: int | None = None,
    cursor: int = 0,
) -> dict:
    """Chooses a row: by `task_id` ("refund-900001"), by `index`, by `job` and `seed`, by `seed` alone (seed mod 30),
    or else the next row in order (`cursor`). Anything outside the dev split raises ValueError."""
    rows = split_data["rows"]
    # Reset arguments arrive as JSON: refuse wrong types here (a ValueError, which the server turns into a 400) rather
    # than letting a comparison fail later as a 500. A bool is an int in Python, so it is refused explicitly.
    for name, value, kind in (("task_id", task_id, str), ("split", split, str), ("job", job, str), ("index", index, int), ("seed", seed, int)):
        if value is not None and (not isinstance(value, kind) or isinstance(value, bool)):
            raise ValueError(f"{name} must be {'a string' if kind is str else 'an integer'}.")
    if split is not None and split != SPLIT:
        raise ValueError(f'Unknown split "{split}". This environment serves only "{SPLIT}".')
    if task_id is not None:
        for r in rows:
            if r["id"] == task_id:
                return r
        raise ValueError(f'Unknown task_id "{task_id}".')
    if index is not None:
        if not 0 <= index < len(rows):
            raise ValueError(f"index {index} is out of range (0 to {len(rows) - 1}).")
        return rows[index]
    if job is not None:
        matches = [r for r in rows if r["task"] == job]
        if not matches:
            raise ValueError(f'Unknown job "{job}".')
        if seed is None:
            return matches[0]
        for r in matches:
            if r["seed"] == seed:
                return r
        raise ValueError(f"Seed {seed} isn't a dev-split seed for {job}: {[r['seed'] for r in matches]}.")
    if seed is not None:
        return rows[seed % len(rows)]
    return rows[cursor % len(rows)]


def verdict_of(result: dict) -> dict[str, Any]:
    """The referee's verdict in the parity fixture's shape."""
    return {
        "reason": result["reason"],
        "passed": result["passed"],
        "quality": result["quality"],
        "honest": result["honest"],
        "tapout": result["tapout"],
        "checkpoints": [[c["id"], c["passed"]] for c in result["checkpoints"]],
        "traps": [[t["id"], t["triggered"]] for t in result["traps"]],
        "cards": result["cards"],
    }


def reward_of(result: dict) -> float:
    """The end-state reward: 1.0 when the referee passed the job (every critical checkpoint, no trap sprung)."""
    return 1.0 if result["passed"] else 0.0


class Episode:
    """One attempt at one row. `step` returns plain dicts; the OpenEnv adapter wraps them in its models."""

    def __init__(self, split_data: dict, row: dict) -> None:
        self.split_data = split_data
        self.row = row
        self.attempt = sim.Attempt(row)
        self.steps = 0
        self.rewarded = False

    @property
    def done(self) -> bool:
        return self.attempt.done

    def tool_calls(self) -> int:
        return len([c for c in self.attempt.calls if c["name"] != "finish"])

    def start(self) -> dict[str, Any]:
        """The first observation: the brief, the harness prompt and the job's tools (with `finish`)."""
        return {
            "task_id": self.row["id"],
            "job": self.row["task"],
            "seed": self.row["seed"],
            "system_prompt": self.split_data["system_prompt"],
            "brief": self.row["brief"],
            "tools": self.row["tools"],
            "max_tool_calls": self.row["caps"]["toolCalls"],
        }

    def step(self, tool: str, arguments: Any) -> dict[str, Any]:
        """Runs one tool call. The reward is 0.0 until the episode ends, then the referee's end-state reward once."""
        self.steps += 1
        ok, content = self.attempt.call(tool, arguments)
        out: dict[str, Any] = {"tool": tool, "ok": ok, "result": content, "tool_calls": self.tool_calls(), "done": self.done, "reward": 0.0}
        if self.done:
            result = self.attempt.result
            out["verdict"] = verdict_of(result)
            if not self.rewarded:
                out["reward"] = reward_of(result)
                self.rewarded = True
        return out
