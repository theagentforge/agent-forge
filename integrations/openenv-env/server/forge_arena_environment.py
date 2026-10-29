"""The Forge Arena dev split as an OpenEnv Environment (a thin adapter over server/episode.py)."""

from __future__ import annotations

from functools import cache
from typing import Any, Optional
from uuid import uuid4

from fastapi import HTTPException
from openenv.core.env_server.interfaces import Environment
from openenv.core.env_server.types import EnvironmentMetadata

try:
    from ..models import ForgeArenaAction, ForgeArenaObservation, ForgeArenaState
    from . import episode as ep
except ImportError:
    from models import ForgeArenaAction, ForgeArenaObservation, ForgeArenaState
    from server import episode as ep

VERSION = "0.1.0"


@cache
def _split() -> dict:
    return ep.load_split()


class ForgeArenaEnvironment(Environment):
    """Six refereed business jobs with planted traps, at the public practice seeds 900001 to 900005.

    reset(task_id=..., or split="dev" and index=..., or job=... and seed=...) starts one job; step(ForgeArenaAction)
    runs one tool call. The reward is 0.0 on every step until the episode ends (finish, or the tool-call cap), then
    1.0 if the Arena referee passed the job from the world's end state and the call log, else 0.0.
    """

    SUPPORTS_CONCURRENT_SESSIONS: bool = True

    def __init__(self) -> None:
        super().__init__()
        self._episode: ep.Episode | None = None
        self._state = ForgeArenaState(episode_id=str(uuid4()), step_count=0)
        self._cursor = 0

    # --- the episode -------------------------------------------------------------------------------------------

    def reset(
        self,
        seed: Optional[int] = None,
        episode_id: Optional[str] = None,
        task_id: Optional[str] = None,
        split: Optional[str] = None,
        index: Optional[int] = None,
        job: Optional[str] = None,
        **kwargs: Any,
    ) -> ForgeArenaObservation:
        split_data = _split()
        try:
            row = ep.pick_row(split_data, task_id=task_id, split=split, index=index, job=job, seed=seed, cursor=self._cursor)
        except ValueError as e:
            # A bad split, row or argument type is the caller's error: a 400 over HTTP (OpenEnv's reset handler maps
            # nothing itself, so a bare ValueError would be a 500), an error message over the WebSocket.
            raise HTTPException(status_code=400, detail=str(e)) from e
        if task_id is None and index is None and job is None and seed is None:
            self._cursor += 1
        self._episode = ep.Episode(split_data, row)
        start = self._episode.start()
        self._state = ForgeArenaState(
            episode_id=episode_id if episode_id is not None else str(uuid4()),
            step_count=0,
            task_id=row["id"],
            job=row["task"],
            seed=row["seed"],
        )
        # The canary travels with every trajectory, so logged runs stay detectable in training corpora.
        return ForgeArenaObservation(**start, done=False, reward=None, metadata={"canary": split_data["canary"], "licence": split_data["licence"]})

    def step(self, action: ForgeArenaAction, timeout_s: Optional[float] = None, **kwargs: Any) -> ForgeArenaObservation:  # type: ignore[override]
        if self._episode is None:
            return ForgeArenaObservation(tool=action.tool, ok=False, result='{"error":"Call reset first."}', done=True, reward=0.0)
        out = self._episode.step(action.tool, action.arguments)
        self._state.step_count += 1
        self._state.tool_calls = out["tool_calls"]
        self._state.done = out["done"]
        row = self._episode.row
        return ForgeArenaObservation(
            task_id=row["id"],
            job=row["task"],
            seed=row["seed"],
            tool=out["tool"],
            ok=out["ok"],
            result=out["result"],
            tool_calls=out["tool_calls"],
            verdict=out.get("verdict"),
            done=out["done"],
            reward=out["reward"],
        )

    @property
    def state(self) -> ForgeArenaState:
        return self._state

    def get_metadata(self) -> EnvironmentMetadata:
        return EnvironmentMetadata(
            name="forge_arena_env",
            description="The Forge Arena dev split: six refereed business jobs with planted traps, practice seeds only.",
            version=VERSION,
            author="The Agent Forge",
            documentation_url="https://theagentforge.io/arena/methodology",
        )

    # --- the Task API (discovery only, no side effects) --------------------------------------------------------

    def list_splits(self) -> list[dict[str, str]]:
        return [{"name": ep.SPLIT, "type": "validation"}]

    def _specs(self, split: str) -> list[dict[str, Any]]:
        if split != ep.SPLIT:
            # IndexError is the Task API's 400 (a 500 would read as a server fault).
            raise IndexError(f'Unknown split "{split}". This environment serves only "{ep.SPLIT}".')
        return ep.task_specs(_split())

    def list_tasks(self, split: str) -> list[dict[str, Any]]:
        return self._specs(split)

    def num_tasks(self, split: str) -> int:
        return len(self._specs(split))

    def get_task(self, split: str, index: int) -> dict[str, Any]:
        specs = self._specs(split)
        if not 0 <= index < len(specs):
            raise IndexError(f"index {index} out of range for split {split} (n={len(specs)})")
        return specs[index]

    def get_task_range(self, split: str, start: Optional[int] = None, stop: Optional[int] = None) -> list[dict[str, Any]]:
        return self._specs(split)[start:stop]
