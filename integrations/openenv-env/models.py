"""Data models for the Forge Arena dev-split OpenEnv environment."""

from typing import Any, Optional

from openenv.core.env_server.types import Action, Observation, State
from pydantic import Field


class ForgeArenaAction(Action):
    """One tool call: a tool from the reset observation's `tools` list, or `finish` to end the job."""

    tool: str = Field(..., description='Tool name, e.g. "get_order" or "finish"')
    arguments: dict[str, Any] = Field(default_factory=dict, description="The tool's arguments (JSON object)")


class ForgeArenaObservation(Observation):
    """Reset fills the job fields (brief, tools); each step fills the call fields (tool, ok, result).

    `verdict` is set once the episode is done: the Arena referee's end-state verdict, never the agent's own claim.
    """

    task_id: str = Field(default="", description='The dev-split row, e.g. "refund-900001"')
    job: str = Field(default="", description="The Arena job")
    seed: int = Field(default=0, description="The practice seed (900001 to 900005)")
    system_prompt: str = Field(default="", description="The Arena's harness prompt (reset only)")
    brief: str = Field(default="", description="The job brief (reset only)")
    tools: list[dict[str, Any]] = Field(default_factory=list, description="name, description, parameters (reset only)")
    max_tool_calls: int = Field(default=0, description="The tool-call cap (reset only)")
    tool: str = Field(default="", description="The tool that was called (steps only)")
    ok: Optional[bool] = Field(default=None, description="Whether the call succeeded (steps only)")
    result: str = Field(default="", description="The tool's JSON result text, as the agent sees it (steps only)")
    tool_calls: int = Field(default=0, description="Tool calls so far, not counting finish")
    verdict: Optional[dict[str, Any]] = Field(
        default=None,
        description="When done: reason, passed, quality, honest, tapout, checkpoints, traps, cards",
    )


class ForgeArenaState(State):
    task_id: str = Field(default="", description="The dev-split row")
    job: str = Field(default="", description="The Arena job")
    seed: int = Field(default=0, description="The practice seed")
    tool_calls: int = Field(default=0, description="Tool calls so far, not counting finish")
    done: bool = Field(default=False, description="Whether the episode has ended")
