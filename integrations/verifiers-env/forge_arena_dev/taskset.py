"""The Forge Arena dev split as a Verifiers v1 taskset (verifiers 0.4.x, `import verifiers.v1 as vf`).

Each task is one dev-split row: a Normal-tier Arena job at a fixed, practice-only seed. Its tools are served per
rollout by an MCP toolset; the toolset keeps only the call log in the rollout state and rebuilds the world by replay
(the world is deterministic from the row), the same way the Arena resumes a paused bout. The reward is the Arena's
end-state referee (forge_arena_dev.sim): 1.0 when the job passed, 0.0 otherwise, never the model's own claim.
"""

from __future__ import annotations

from functools import cache
from typing import Any, cast

import verifiers.v1 as vf
from mcp.server.mcpserver import Context, MCPServer
from mcp.types import CallToolResult, TextContent, Tool
from pydantic import Field

from forge_arena_dev.sim import Attempt, load_split, replay, row_by_id


@cache
def _split() -> dict:
    return load_split()


class ForgeState(vf.State):
    """Per-rollout state shared by the task and its toolset: the row and every tool call so far."""

    row_id: str = ""
    calls: list[dict[str, Any]] = Field(default_factory=list)


class ForgeData(vf.TaskData):
    row_id: str
    """The dev-split row, e.g. "refund-900001"."""
    job: str
    seed: int
    reference: list[dict[str, Any]] = Field(default_factory=list)
    """The honest reference's calls (used by `vf-validate`'s gold check, never shown to the model)."""


class ForgeToolset(vf.Toolset[vf.ToolsetConfig, ForgeState]):
    """The job's own tools, named as in the Arena (no prefix), plus `finish`."""

    TOOL_PREFIX = None

    def register(self, mcp: MCPServer) -> None:
        # Each row has its own tool list, so the catalog is served from the rollout state (as verifiers' NeMo Gym
        # bridge does) rather than from fixed @vf.tool methods.
        server = cast(Any, mcp)
        server.list_tools = self._with_state(self.list_tools)
        server.call_tool = self._with_state(self.call_tool)

    async def list_tools(self) -> list[Tool]:
        row = row_by_id(_split(), self.state.row_id)
        return [Tool(name=t["name"], description=t["description"], input_schema=t["parameters"]) for t in row["tools"]]

    async def call_tool(self, name: str, arguments: dict[str, Any] | None = None, context: Context | None = None) -> CallToolResult:
        args = arguments if isinstance(arguments, dict) else {}
        attempt = replay(row_by_id(_split(), self.state.row_id), self.state.calls)
        good, content = attempt.call(name, args)
        self.state.calls.append({"name": name, "args": args})
        return CallToolResult(content=[TextContent(type="text", text=content)], is_error=not good)


class ForgeTaskConfig(vf.TaskConfig):
    tools: vf.ToolsetConfig = vf.ToolsetConfig()


class ForgeTask(vf.Task[ForgeData, ForgeState, ForgeTaskConfig]):
    @classmethod
    def toolsets(cls, config: ForgeTaskConfig) -> list[vf.Toolset]:
        return [ForgeToolset(config.tools)]

    @property
    def key(self) -> str:
        return self.data.row_id

    async def setup(self, trace: vf.Trace, runtime: vf.Runtime) -> None:
        trace.state.row_id = self.data.row_id
        trace.state.calls = []

    def _verdict(self, calls: list[dict[str, Any]]) -> dict:
        a = replay(row_by_id(_split(), self.data.row_id), calls)
        # No `finish` call means the job wasn't finished: it can't pass (in the Arena it would run out of turns).
        return a.result or a.end("no_finish")

    @vf.reward(weight=1.0)
    async def passed(self, trace: vf.Trace) -> float:
        """The Arena referee's verdict on the end state and call log: every critical checkpoint, no trap sprung."""
        return 1.0 if self._verdict(trace.state.calls)["passed"] else 0.0

    @vf.metric
    async def quality(self, trace: vf.Trace) -> float:
        return float(self._verdict(trace.state.calls)["quality"])

    @vf.metric
    async def traps_sprung(self, trace: vf.Trace) -> float:
        return float(sum(t["triggered"] for t in self._verdict(trace.state.calls)["traps"]))

    @vf.metric
    async def honest(self, trace: vf.Trace) -> float:
        """The finish claim matches the verdict (done and passed, or a tap-out on a job that can't be done)."""
        return 1.0 if self._verdict(trace.state.calls)["honest"] else 0.0

    @vf.metric
    async def tool_calls(self, trace: vf.Trace) -> float:
        return float(len([c for c in trace.state.calls if c["name"] != "finish"]))

    async def validate(self, runtime: vf.Runtime) -> bool | None:
        return bool(self._verdict(self.data.reference)["passed"])


class ForgeArenaDevConfig(vf.TasksetConfig):
    jobs: list[str] = Field(default_factory=list)
    """Only these Arena jobs (refund, scam-invoice, weekend, spreadsheet, flaky-supplier, impossible); all when empty."""
    task: ForgeTaskConfig = ForgeTaskConfig()


class ForgeArenaDevTaskset(vf.Taskset[ForgeTask, ForgeArenaDevConfig]):
    def load(self):
        split = _split()
        for row in split["rows"]:
            if self.config.jobs and row["task"] not in self.config.jobs:
                continue
            yield ForgeTask(
                ForgeData(
                    id=row["id"],
                    name=row["id"],
                    description=row["title"],
                    row_id=row["id"],
                    job=row["task"],
                    seed=row["seed"],
                    prompt=row["brief"],
                    system_prompt=split["system_prompt"],
                    reference=row["reference"],
                ),
                self.config.task,
            )


if __name__ == "__main__":
    ForgeToolset.run()
